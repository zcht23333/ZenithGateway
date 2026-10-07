#requires -Version 5.1
<#
.SYNOPSIS
Starts the local ZenithGateway development environment.
.DESCRIPTION
Uses an existing Redis, or starts a persistent Docker Redis on loopback.
Builds the backend, installs missing frontend dependencies, and supervises both
services. Ctrl+C gracefully shuts down the backend before stopping owned services.
Run from any directory. No administrator privileges are required.
.PARAMETER CheckOnly
Checks prerequisites and ports without building or starting services.
.PARAMETER SmokeTest
Starts the stack, checks backend and frontend proxy health, then shuts it down.
.PARAMETER SkipBuild
Uses the existing backend JAR; source changes are not compiled.
.PARAMETER InstallDependencies
Runs npm ci even when frontend dependencies are already installed.
.PARAMETER UseExistingRedis
Fails if Redis is unavailable instead of starting a Docker container.
.EXAMPLE
.\dev.ps1
.EXAMPLE
.\dev.ps1 -CheckOnly
.EXAMPLE
.\dev.ps1 -BackendPort 8081 -FrontendPort 5174 -RedisPort 6380
#>
[CmdletBinding()]
param(
    [string]$JavaHome = $env:JAVA_HOME,
    [ValidateRange(1, 65535)][int]$BackendPort = 8080,
    [ValidateRange(1, 65535)][int]$FrontendPort = 5173,
    [string]$RedisHost = $(if ($env:REDIS_HOST) { $env:REDIS_HOST } else { '127.0.0.1' }),
    [ValidateRange(1, 65535)][int]$RedisPort = $(if ($env:REDIS_PORT) { [int]$env:REDIS_PORT } else { 6379 }),
    [switch]$CheckOnly,
    [switch]$SmokeTest,
    [switch]$SkipBuild,
    [switch]$InstallDependencies,
    [switch]$UseExistingRedis
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $root '.dev'
$backend = $null
$frontend = $null
$docker = $null
$redisStartedHere = $false
$mutex = $null
$lockHeld = $false
$exitCode = 0
$script:redisError = ''
$savedEnvironment = @{}
foreach ($name in @('JAVA_HOME', 'GATEWAY_PROXY_TARGET', 'VITE_API_BASE_URL')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Resolve-Application([string]$Name) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw "Missing $Name. Install it and make it available on PATH." }
    return $command.Source
}

function Invoke-Native([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($Executable)) failed (exit $LASTEXITCODE)." }
}

function Assert-PortFree([int]$Port, [string]$Name) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.ExclusiveAddressUse = $true
    try { $listener.Start() }
    catch { throw "$Name port $Port is occupied. Stop that service or choose another port." }
    finally { $listener.Stop() }
}

function Test-Redis {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        if (-not $client.ConnectAsync($RedisHost, $RedisPort).Wait(1500)) { throw 'Connection timed out.' }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 1500
        $stream.WriteTimeout = 1500
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        $commands = [Collections.Generic.List[object]]::new()
        if ($env:REDIS_PASSWORD) { $commands.Add(@('AUTH', $env:REDIS_PASSWORD)) }
        $commands.Add(@('PING'))
        foreach ($command in $commands) {
            $newline = [string][char]13 + [char]10
            $wire = '*' + $command.Count + $newline
            foreach ($arg in $command) {
                $wire += '$' + [Text.Encoding]::UTF8.GetByteCount($arg) + $newline + $arg + $newline
            }
            $bytes = [Text.Encoding]::UTF8.GetBytes($wire)
            $stream.Write($bytes, 0, $bytes.Length)
            $reply = $reader.ReadLine()
            $expected = if ($command[0] -eq 'AUTH') { '+OK' } else { '+PONG' }
            if ($reply -ne $expected) { throw "Redis did not accept $($command[0]). Check REDIS_HOST, REDIS_PORT and REDIS_PASSWORD." }
        }
        $script:redisError = ''
        return $true
    } catch {
        $script:redisError = $_.Exception.Message
        return $false
    } finally { $client.Dispose() }
}

function Get-DevRedis {
    $ids = @(Invoke-Native $docker @('ps', '--all', '--filter', "name=^/$redisName$", '--format', '{{.ID}}'))
    if ($ids.Count -eq 0) { return $null }
    $containers = (Invoke-Native $docker @('inspect', $redisName)) -join [Environment]::NewLine | ConvertFrom-Json
    $container = @($containers)[0]
    if ($container.Config.Labels.'com.zenithgateway.dev.workspace' -ne $workspaceId) {
        throw "Docker container $redisName is not owned by this workspace."
    }
    $bindings = @($container.HostConfig.PortBindings.'6379/tcp')
    if ($bindings.Count -ne 1 -or $bindings[0].HostIp -ne '127.0.0.1' -or $bindings[0].HostPort -ne [string]$RedisPort) {
        throw "Docker container $redisName has a different port mapping. Check it before starting."
    }
    return $container
}

function Quote-ProcessArgument([string]$Value) {
    # Start-Process joins ArgumentList on Windows. Quote for a native executable,
    # not for cmd.exe. Preserve spaces, quotes and trailing backslashes.
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Start-LoggedProcess([string]$Executable, [string[]]$Arguments, [string]$Directory, [string]$Name) {
    $commandLine = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
    $options = @{
        FilePath = $Executable
        ArgumentList = $commandLine
        WorkingDirectory = $Directory
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = Join-Path $logDir "$Name.log"
        RedirectStandardError = Join-Path $logDir "$Name.err.log"
    }
    return Start-Process @options
}

function Assert-ProcessesAlive {
    foreach ($entry in @(@{ Process = $backend; Name = 'Backend' }, @{ Process = $frontend; Name = 'Frontend' })) {
        if ($entry.Process -and $entry.Process.HasExited) {
            throw "$($entry.Name) exited (code $($entry.Process.ExitCode)). See $logDir."
        }
    }
}

function Wait-Healthy([string]$Url, [int]$TimeoutSeconds, [string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        Assert-ProcessesAlive
        try {
            $health = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -UseBasicParsing
            if ($health.status -eq 'UP') { return }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    throw "$Name did not become healthy within $TimeoutSeconds seconds. See $logDir."
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher supports Windows PowerShell 5.1 and PowerShell 7 on Windows.' }
    if ([string]::IsNullOrWhiteSpace($RedisHost)) { throw 'RedisHost must not be empty.' }
    if ($BackendPort -eq $FrontendPort -or $BackendPort -eq $RedisPort -or $FrontendPort -eq $RedisPort) {
        throw 'BackendPort, FrontendPort and RedisPort must be different.'
    }

    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())) }
    finally { $hasher.Dispose() }
    $workspaceId = ([BitConverter]::ToString($hash)).Replace('-', '').Substring(0, 12).ToLowerInvariant()
    $redisName = "zenithgateway-dev-$workspaceId-$RedisPort"
    $mutex = [Threading.Mutex]::new($false, "Local\ZenithGatewayDev-$workspaceId")
    try { $lockHeld = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $lockHeld = $true }
    if (-not $lockHeld) { throw 'Another dev.ps1 is already running for this workspace.' }

    if (-not $JavaHome) {
        $javac = Resolve-Application 'javac.exe'
        $JavaHome = Split-Path (Split-Path $javac -Parent) -Parent
    }
    $java = Join-Path $JavaHome 'bin/java.exe'
    if (-not (Test-Path -LiteralPath $java -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) {
        throw 'Set JAVA_HOME to a JDK 21 directory, or pass -JavaHome <directory>.'
    }
    $version = (Invoke-Native $java @('--version')) -join ' '
    if ($version -notmatch '^(openjdk|java)\s+21[.\s+-]') { throw "JDK 21 is required. Selected Java: $version" }
    $env:JAVA_HOME = $JavaHome
    $maven = $null
    if (-not $SkipBuild) {
        $maven = Join-Path $root 'mvnw.cmd'
        if (-not (Test-Path -LiteralPath $maven)) { throw 'Maven Wrapper is missing. Restore mvnw.cmd and .mvn/wrapper/.' }
    }
    $node = Resolve-Application 'node.exe'
    $npm = Resolve-Application 'npm.cmd'
    $nodeVersion = (Invoke-Native $node @('--version')) -join ''
    $nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
    if ($nodeMajor -ne 24) { throw "Node.js 24 LTS is required. Found $nodeVersion. See .node-version for the verified patch." }
    $jar = Join-Path $root 'backend/target/zg-1.0.0.jar'
    if ($SkipBuild -and -not (Test-Path -LiteralPath $jar)) { throw 'Backend JAR is missing. Run without -SkipBuild first.' }
    Assert-PortFree $BackendPort 'Backend'
    Assert-PortFree $FrontendPort 'Frontend'
    Write-Host "Prerequisites OK: JDK 21, Node $nodeVersion. Backend=$BackendPort; frontend=$FrontendPort."

    $redisAvailable = Test-Redis
    $container = $null
    if (-not $redisAvailable) {
        if ($UseExistingRedis -or $RedisHost -notin @('localhost', '127.0.0.1')) {
            throw "Redis is unavailable at $($RedisHost):$RedisPort. $script:redisError"
        }
        Assert-PortFree $RedisPort 'Redis'
        if ($env:REDIS_PASSWORD) { throw 'Configured Redis is unavailable. Start that Redis instance, or unset REDIS_PASSWORD to use the local Docker instance.' }
        $docker = Resolve-Application 'docker.exe'
        Invoke-Native $docker @('info', '--format', '{{.ServerVersion}}') | Out-Null
        $container = Get-DevRedis
        if ($container -and $container.State.Running) { throw "$redisName is running but Redis PING failed. Check its logs." }
        Write-Host "Redis will use Docker container $redisName with a persistent data volume."
    } else {
        Write-Host "Using existing Redis at $($RedisHost):$RedisPort (it will be left running)."
    }

    if ($CheckOnly) {
        Write-Host 'Checks passed. No services started or dependencies installed.'
    } else {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        if (-not $SkipBuild) {
            Write-Host 'Building backend (tests are separate from development startup)...'
            Invoke-Native $maven @('-B', '-ntp', '-f', (Join-Path $root 'backend/pom.xml'), '-DskipTests', 'package')
        }
        $vite = Join-Path $root 'frontend/node_modules/vite/bin/vite.js'
        if ($InstallDependencies -or -not (Test-Path -LiteralPath $vite)) {
            Write-Host 'Installing frontend dependencies from package-lock.json...'
            Invoke-Native $npm @('--prefix', (Join-Path $root 'frontend'), 'ci')
        }

        # Build/install before starting any services so a build error leaves none behind.
        if (-not $redisAvailable) {
            $redisStartedHere = $true
            if ($container) {
                Invoke-Native $docker @('start', $redisName) | Out-Null
            } else {
                Invoke-Native $docker @('run', '--detach', '--name', $redisName,
                    '--label', "com.zenithgateway.dev.workspace=$workspaceId",
                    '--publish', "127.0.0.1:$($RedisPort):6379",
                    '--mount', "type=volume,source=$redisName-data,target=/data",
                    'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499', 'redis-server', '--appendonly', 'yes') | Out-Null
            }
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            while (-not (Test-Redis)) {
                if ([DateTime]::UtcNow -gt $deadline) { throw "Redis startup failed. $script:redisError" }
                Start-Sleep -Milliseconds 250
            }
        }

        Write-Host 'Starting backend...'
        $backendArguments = @('-jar', $jar, '--spring.profiles.active=dev',
            '--server.address=127.0.0.1', "--server.port=$BackendPort",
            "--zenith.cors.allowed-origins[0]=http://127.0.0.1:$FrontendPort",
            "--zenith.cors.allowed-origins[1]=http://localhost:$FrontendPort",
            "--spring.data.redis.host=$RedisHost", "--spring.data.redis.port=$RedisPort",
            "--management.server.port=$BackendPort", '--management.endpoints.web.base-path=/actuator',
            '--management.endpoint.shutdown.access=unrestricted',
            '--management.endpoints.web.exposure.include=health,info,metrics,prometheus,shutdown',
            '--zenith.admin.token-header=Authorization')
        $backend = Start-LoggedProcess $java $backendArguments $root 'backend'
        $backendUrl = "http://127.0.0.1:$BackendPort"
        Wait-Healthy "$backendUrl/actuator/health/readiness" 120 'Backend'

        Write-Host 'Starting frontend...'
        $env:GATEWAY_PROXY_TARGET = $backendUrl
        $env:VITE_API_BASE_URL = '/api'
        $frontend = Start-LoggedProcess $node @($vite, '--host', '127.0.0.1', '--port', [string]$FrontendPort, '--strictPort') (Join-Path $root 'frontend') 'frontend'
        $frontendUrl = "http://127.0.0.1:$FrontendPort"
        Wait-Healthy "$frontendUrl/api/actuator/health/readiness" 30 'Frontend proxy'
        Write-Host ""
        Write-Host "Dashboard: $frontendUrl"
        Write-Host "Backend:   $backendUrl"
        Write-Host "Logs:      $logDir"
        if ($env:ZENITH_ADMIN_TOKEN) { Write-Host 'Management authentication is enabled; use your configured token in the dashboard.' }
        Write-Host 'Ready. Press Ctrl+C to stop. Redis data will be preserved.'
        if ($SmokeTest) {
            Write-Host 'Smoke test passed: backend and frontend proxy are healthy.'
        } else {
            while ($true) { Assert-ProcessesAlive; Start-Sleep -Milliseconds 500 }
        }
    }
} catch {
    $exitCode = 1
    Write-Host ("Development environment failed: " + $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($frontend -and -not $frontend.HasExited) {
        try { $frontend.Kill(); $frontend.WaitForExit(5000) | Out-Null }
        catch { Write-Warning "Could not stop frontend: $($_.Exception.Message)" }
    }
    if ($backend -and -not $backend.HasExited) {
        try {
            Write-Host 'Stopping backend and draining audit records...'
            try {
                $headers = @{}
                if ($env:ZENITH_ADMIN_TOKEN) { $headers['Authorization'] = 'Bearer ' + $env:ZENITH_ADMIN_TOKEN }
                Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/actuator/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -Headers $headers -TimeoutSec 5 -UseBasicParsing | Out-Null
            } catch { Write-Warning ("Graceful shutdown request failed: " + $_.Exception.Message) }
            if (-not $backend.WaitForExit(45000)) {
                Write-Warning 'Backend did not exit in 45 seconds; forcing this process to stop. Pending audit records may be lost.'
                $exitCode = 1
                $backend.Kill()
                $backend.WaitForExit(5000) | Out-Null
            }
        } catch {
            $exitCode = 1
            Write-Warning ("Backend cleanup failed: " + $_.Exception.Message)
        }
    }
    if ($redisStartedHere -and $docker) {
        try {
            # Recheck ownership before stopping; never remove the container or volume.
            $owned = Get-DevRedis
            if ($owned -and $owned.State.Running) {
                Invoke-Native $docker @('stop', '--time', '10', $redisName) | Out-Null
                Write-Host 'Development Redis stopped; its data volume is retained.'
            }
        } catch { Write-Warning "Could not stop development Redis: $($_.Exception.Message)" }
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if ($lockHeld) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
    if ($backend) { $backend.Dispose() }
    if ($frontend) { $frontend.Dispose() }
}
if ($exitCode -ne 0) { exit $exitCode }
