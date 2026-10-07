# 限流有界交接对照

入口：benchmarks/limiter-handoff.mjs。它复用 limiter-diagnosis.mjs 的隔离环境、固定到达率、审计对账与按所有权清理逻辑。当前正式包已包含固定容量诊断，不需要实验插桩包。

A 为修正诊断但关闭结果交接的同步基线，B 为同一 JAR 开启预留容量的有界交接。两者固定 8 个 I/O 工作线程、128 个等待位、500ms 决策预算，B 另有 2 个结果线程但共用原 136 个准入名额。32 条路由、限流/监控/审计/熔断开启；额度 10000，目标到达率 4000 req/s，客户端最多 256 个在途请求。

两实例的全部 Redis 用途都直连同一个自建 Redis；与旧 transport 诊断中“只将 B 的限流直连”不同。固定 CPU 分配：Redis 0–1、上游 2–3、两网关均 4–7（一次只压一个）、生成器 8–11、中继 12。中继容器仍由共用框架创建，但该模式的 Redis 流量不经过它。至少需要 Docker 16 个逻辑 CPU 和已有固定镜像。

各实例先独立预热 30 秒 1000 req/s、60 秒目标负载，随后 A→B→B→A 各 180 秒。阶段之间新建负载进程，网关 JVM 保留。空闲连接回收、预热和共享宿主调度仍可能影响阶段差异；不可把单次差值当作因果比例。

~~~powershell
Set-Location 'D:/Java/ZenithGateway'
# 先按项目流程构建并验证后端，将被测 JAR 固定到一个独立目录。
$env:LIMITER_DIAG_JAR = 'D:/Java/ZenithGateway/backend/target/zg-1.0.0.jar'
$env:LIMITER_DIAG_OUTPUT = Join-Path '.dev' ('limiter-handoff-' + [guid]::NewGuid().ToString('N'))
$env:LIMITER_DIAG_RATE = '4000'
$env:LIMITER_DIAG_SECONDS = '180'
$env:LIMITER_DIAG_REDIS_HOST = ''
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' benchmarks/limiter-handoff.mjs
if ($LASTEXITCODE -ne 0) { throw 'Comparison execution failed' }

python benchmarks/summarize-limiter-handoff.py (Join-Path $env:LIMITER_DIAG_OUTPUT 'summary.json') (Join-Path $env:LIMITER_DIAG_OUTPUT 'analysis.json')
~~~

报告的 passed 表示执行、结构性断言与清理完成；每段 assessment.healthy 才表示该段健康负载条件是否通过。HTTP 200 不等于成功完成额度判断。固定原因计数按阶段前后差分，两个 queue_full 入口分别列出；预热和失败阶段都保留。

PROGRESS 行仍来自共用框架的最后一个采样实例，双实例时是 B 的生命周期累计数，不能直接用于 A 阶段差分。以 summary.json 的 accounting 和新汇总入口为准。

summary.json 保存实际 JVM 参数、依赖镜像 digest、JAR SHA-256、工具哈希、每阶段计数/耗时、客户端负载结果和清理记录。采样峰值不是精确峰值，耗时均值也不是 CPU 时间。源文件和运行参数应连同证据一起冻结。

旧诊断插桩的复现方式：prepare-limiter-diagnosis.py 新增 --source <归档后端目录> 参数，目录应包含 pom.xml 和 src。使用之前冻结的后端源码，原有 --production-fixture 仍验证当时机制。当前正式源码已经改变线程模型，工具会明确拒绝套用旧替换锚点，不能把新旧诊断口径混作同一测量。

完整设计与本轮结果：[backend-limiter-handoff.md](../docs/backend-limiter-handoff.md)。

## 最终包故障回归

默认交接关闭。要让真实限流及代理矩阵覆盖结果交接，分别显式设置以下环境变量；两个入口都会自建并清理 Redis、随机端口、受控上游和网关，不连接开发实例。RATE_LIMIT_OUTPUT / PROXY_RESILIENCE_OUTPUT 指向尚未使用的证据目录。

~~~powershell
$env:JAVA_HOME = 'D:/Java/ZenithGateway/.dev/toolchains/jdk-21.0.12.1+1'
$env:RATE_LIMIT_HANDOFF = 'true'
$env:RATE_LIMIT_OUTPUT = Join-Path '.dev' ('handoff-rate-' + [guid]::NewGuid().ToString('N'))
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' verification/rate-limit-reliability-live.mjs
if ($LASTEXITCODE -ne 0) { throw 'Limiter validation failed' }

$env:PROXY_RESILIENCE_LIMITER_HANDOFF = 'true'
$env:PROXY_RESILIENCE_JAR = 'D:/Java/ZenithGateway/backend/target/zg-1.0.0.jar'
$env:PROXY_RESILIENCE_OUTPUT = Join-Path '.dev' ('handoff-proxy-' + [guid]::NewGuid().ToString('N'))
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' verification/proxy-resilience-live.mjs
if ($LASTEXITCODE -ne 0) { throw 'Proxy validation failed' }
~~~

代理入口会检查启动时限流/交接实际开启，且重启前发生超过 50 次真实交接。矩阵本身后部会切换限流开关，所以不要把总记录请求数等同于交接次数。恢复旧入口默认行为时，移除这两个 HANDOFF 环境变量即可。
