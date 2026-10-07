# 限流短时饱和诊断

这套工具定位本地 `queue_full`、工作线程占用和 Redis 往返尾延迟。它将后端复制到 `.dev` 后编译实验包；不会改写正式后端源码。实验包只用于本地诊断，不应部署为正式服务。

固定条件：8 个限流工作线程/连接、128 个等待位、500ms 决策预算；32 条路由；4,000 req/s 固定计划到达率；最多 256 个在途客户端请求。限流、监控、审计和熔断均开启。Docker Desktop 需要至少 16 个逻辑 CPU，镜像使用与稳定性实验相同的本地固定 digest。

## 构建与机制测试

在仓库根目录执行，使用全新目录。工具拒绝覆盖已有输出。

```powershell
$taskRoot = Join-Path (Get-Location) '.dev/limiter-diagnosis-repro'
New-Item -ItemType Directory -Path $taskRoot | Out-Null
python benchmarks/prepare-limiter-diagnosis.py (Join-Path $taskRoot 'backend')
$env:JAVA_HOME = (Resolve-Path '.dev/toolchains/jdk-21.0.12.1+1').Path
& '.dev/toolchains/apache-maven-3.9.16/bin/mvn.cmd' -f (Join-Path $taskRoot 'backend/pom.xml') -DskipTests package

python benchmarks/prepare-limiter-diagnosis.py (Join-Path $taskRoot 'fixture') --production-fixture
& '.dev/toolchains/apache-maven-3.9.16/bin/mvn.cmd' -f (Join-Path $taskRoot 'fixture/pom.xml') '-Dtest=WorkerOccupancyTest' test
```

机制测试运行未修改的正式限流源码副本：用立即返回的 RedisFuture 和可控制的消费者暂停，验证决策已完成后，限流线程仍被后续处理占用。它不连接 Redis，不是实际吞吐量测试。

## 三种实验

```powershell
$env:LIMITER_DIAG_JAR = Join-Path $taskRoot 'backend/target/zg-1.0.0.jar'
$env:LIMITER_DIAG_RATE = '4000'
$env:LIMITER_DIAG_STUDY = 'observer'
$env:LIMITER_DIAG_REDIS_HOST = ''
$env:LIMITER_DIAG_MODES = 'none,light,native,native,light,none'
$env:LIMITER_DIAG_SECONDS = '180'
$env:LIMITER_DIAG_OUTPUT = Join-Path $taskRoot 'observer-comparison'
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' benchmarks/limiter-diagnosis.mjs

$env:LIMITER_DIAG_STUDY = 'transport'
$env:LIMITER_DIAG_REDIS_HOST = ''
$env:LIMITER_DIAG_SECONDS = '120'
$env:LIMITER_DIAG_OUTPUT = Join-Path $taskRoot 'transport-comparison'
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' benchmarks/limiter-diagnosis.mjs

$env:LIMITER_DIAG_STUDY = 'observer'
$env:LIMITER_DIAG_REDIS_HOST = 'redis'
$env:LIMITER_DIAG_MODES = 'light'
$env:LIMITER_DIAG_SECONDS = '300'
$env:LIMITER_DIAG_OUTPUT = Join-Path $taskRoot 'roundtrip-direct'
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' benchmarks/limiter-diagnosis.mjs

python benchmarks/summarize-limiter-diagnosis.py $taskRoot
python benchmarks/plot-limiter-diagnosis.py (Join-Path $taskRoot 'analysis.json') (Join-Path $taskRoot 'figures')
```

- `none`：负载中不轮询管理接口、不读取进程状态、不执行 jcmd；仍有同样的进程内计数、GC 日志、负载生成器采样与宿主实验报告保存，不等同于零观测。
- `light`：每约 2 秒读取管理诊断和 Prometheus，每约 10 秒读取进程内存状态。
- `native`：在 light 上，每 60 秒执行原生内存等诊断。原稳定性实验为每 300 秒；这里用于放大并观察诊断影响，不能直接换算历史事件归因。
- `transport`：A 的限流连接经过实验 TCP 中继，B 的限流直接连接同一 Redis；其他 Redis 用途仍经过中继。两实例均使用 CPU 4–7，按 A→B→B→A 单独承载，每段 120 秒，各自先预热。Redis CLIENT LIST 实际来源须通过断言。实例切换会产生连接空闲差异，因此不能只按拒绝计数推导因果比例或多实例扩容收益。

每个实例的预热均为 30 秒 1,000 req/s 和 60 秒目标负载。预热单独保留，不隐藏失败。每段新建负载进程及其客户端连接；上游连接池属于仍运行的网关。

## 观测边界

`experimentProbe` 只存在于实验包受管理认证保护的原诊断接口中。原因和拒绝入口为固定计数器；耗时使用固定桶；饱和、慢阶段和慢往返各最多保存 128 条，每类最多每 100ms 一条。周期采集去重后每阶段最多保存各 4,096 条详情。没有按 IP、路由或请求建立无界指标。

工作阶段：提交到连接阶段、连接、Redis 往返与恢复、JSON 解析、结果发送与后续处理、清理。它们是墙钟耗时，包含系统调度和 GC，不是 CPU 占用率。`commandsInFlight` 沿用正式口径，不能直接视为 Redis 服务器上的未完成命令数。

最新实验包额外记录发送、Redis 返回的毫秒时间、回复回调和 Future.get 返回时间。只有回调时间已观测且早于 get 返回时，才计算回调后恢复时间；缺失样本另计。如果回调在线程名为 rate-limit-io 的工作线程上同步执行，表示注册时可能已完成；该回调时间不能当作回复到达时间，分段归因只引用 Lettuce I/O 线程样本。Redis/网关在同一 Docker VM，跨进程墙钟分段仍有毫秒取整误差，不能照搬到时钟不同步的跨主机环境。慢样本是有界抽样，不用于推算全部请求占比。

进度行的 `failedOpen` 是最后一个采样实例的生命周期累计值，双实例时为 B；阶段结论必须读取 `summary.json` 的前后快照差分或汇总中的 `activeLabel`，不要从进度行相减。

## 本次证据

[完整诊断报告](../docs/backend-limiter-diagnosis.md)及其 JSON 索引记录 2026-10-04 的独立实验。原始目录为 `.dev/limiter-diagnosis-20261004-6337c56a`。

本次三轮埋点逐步增加，已分别归档 `observer-sources`、`transport-sources`、`roundtrip-sources` 并记录各 JAR 和实际执行工具的哈希。以上启动命令使用最终版埋点复现流程；精确重复某一早期测量需要其归档源码与冻结 JAR。

`validate-limiter-diagnosis.py` 用于本次完整归档：它要求运行前的文件/容器快照、三组源码归档、机制测试报告和已完成的实验。独立重跑时先保存自己的运行前快照，不要套用本次保存基准。

脚本仅删除带本轮唯一所有权标签的容器、网络和自身创建的凭证文件。已有开发实例不属于清理范围。HTTP 200、脚本正常退出和健康容量是三个独立结论。
