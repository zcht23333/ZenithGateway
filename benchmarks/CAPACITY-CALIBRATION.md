# 最终包容量定标

本轮只做一次双模式容量摸底、一轮 JFR 针对性对照，以及满足门槛后的一次 3600 秒长测。没有循环调大线程、队列或超时。完整结论见 [容量报告](../docs/backend-capacity-calibration.md)。

## 环境与固定条件

沿用已有 Docker 固定镜像和 Node/JDK 工具链，需要至少 16 个 Docker 逻辑 CPU。网关使用 4 个逻辑 CPU、1GB 容器上限、256m/512m 堆、256m 直接内存、G1。Redis、受控上游、生成器分别使用其他 CPU 集合。Redis 不经故障中继；框架仍创建中继容器但不经过它。

capacity profile：8 个限流 I/O 工作线程、128 个等待位、500ms 决策预算；交接开启时 2 个结果线程，共享原 136 个准入名额。32 条路由；普通 HTTP、小响应体、快速上游；限流、监控、审计、熔断开启。限流容量/速度 10000，成本 1。生成器每秒固定计划到达，最多 256 个在途请求。

两模式使用同一冻结 JAR，区别仅为 result-handoff-enabled。饱和事件采样在两者都启用，其他参数不变；应用默认的交接和事件采样仍关闭。生产运行配置六字段及存储协议不变。

## 执行

先在独立 Redis 下完成后端 verify，然后在仓库根目录执行；每次使用新的证据目录。不要指向开发 Redis，也不要改动旧证据目录。

```powershell
$taskRoot = Join-Path (Get-Location) ('.dev/capacity-repro-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRoot | Out-Null
Copy-Item -LiteralPath 'backend/target/zg-1.0.0.jar' -Destination (Join-Path $taskRoot 'gateway-final.jar')
$env:CAPACITY_CALIBRATION_JAR = Join-Path $taskRoot 'gateway-final.jar'
$env:CAPACITY_CALIBRATION_OUTPUT = Join-Path $taskRoot 'calibration'
$env:CAPACITY_CALIBRATION_RATES = '1000,2000,3000,3500,4000'
$env:CAPACITY_CALIBRATION_SECONDS = '120'
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' benchmarks/capacity-calibration.mjs *> (Join-Path $taskRoot 'calibration.log')
if ($LASTEXITCODE -ne 0) { throw 'Inspect calibration.log and summary.json; failed stages must be retained' }
python benchmarks/summarize-capacity-calibration.py (Join-Path $taskRoot 'calibration/summary.json') (Join-Path $taskRoot 'analysis.json')
```

需要线程调度补充证据时，在第二个终端使用同一个 taskRoot，等日志出现 `START warmup-B` 后运行：

```powershell
& '.dev/toolchains/node-v24.21.0-win-x64/node.exe' benchmarks/calibration-scheduler.mjs $taskRoot
```

辅助进程只在 targeted-A/B 阶段读取调度统计，最多每 10 秒一次、每模式 24 个样本、每次 128 个线程；不写 sysctl，不更改时钟或调度器，结束后自行退出。若 Linux schedstats 未启用，不能把零等待解释为线程从未等待；依赖 JFR 与事件样本说明可观察边界。

## 预先固定的流程

1. 临时初始化实例发布 32 条路由后退出。正式测量实例首次业务流量为 30 秒 1000 req/s 冷启动测试。
2. 等实际代理连接池归零，最长 90 秒，再运行 30 秒 1000 req/s 空闲恢复测试。失败照常保留。
3. 每模式相同预热：30 秒 500、30 秒 1000、60 秒 2000，期间复用负载端连接。
4. 短测 A 升序、B 升序、B 降序、A 降序；每档 120 秒。每档之前相同 15 秒 500 req/s 准备阶段。它们不计入正式容量成绩。
5. 一轮 4000 req/s 的 A/B 诊断对照，各 120 秒，启用有 64MB/180 秒上限的 JFR；这些阶段不参与容量选档。
6. 选两次短测都通过的最高负载，同档优先原默认 A。再通过一次 120 秒确认才进入一次 3600 秒长测。无合格档位或确认失败则不宣称长测通过。
7. 长测后以 500 req/s 降载 120 秒，检查请求和审计排空、连接池归零、内存及线程变化，清理本轮资源。

健康条件：全部响应 200，零传输错误、零限流故障放行、审计丢弃/不确定/对账差为零，采样无错误、资源未越界；计划到达缺口不超过 1%；HTTP 200 P95 ≤ 50ms、P99 ≤ 100ms，包含到达调度等待的 P99 ≤ 150ms。

`passed` 只表示实验执行和结构检查完成；容量看每阶段的 `assessment.healthy` 及最终 `longValidated`。禁止平均多个阶段的 P99。原框架复制来的 modes、repetitions、soakSeconds 等字段没有驱动本轮流程，实际阶段与本页固定流程为准。

## 事件含义与证据

新增启动参数 `zenith.limiter.saturation-sampling-enabled=true`。管理认证保护的 `/settings/rate-limit/saturation?afterSequence=0` 只读本地、禁止缓存。常规 diagnostics 只带轻量采样摘要；事件按游标读取，环覆盖会明确提示 cursorTooOld。最多 128 条，每 100ms 最多一条；每次最多检查 256 个保留任务，展示其中最老的 8 个和最多 64 个 I/O 槽位所有者。没有逐请求堆栈、Redis 查询或后台采样队列。

线程信息属于阶段观察，不是操作系统调度器的精确因果记录；queued/complete 阶段的线程字段是最近转换时的线程，不能解释成此刻正在执行该阶段。状态读取不原子，拒绝之后名额可能已经释放；采样数量也不能代替真实拒绝计数。GC/线程关联需要看时间线，不按平均耗时推导增加线程数。

工具冻结、JAR SHA-256、有效参数、每秒负载记录、饱和事件、代理原因、原始 GC/JFR、审计计数、Redis 状态及清理都在证据目录。比较首次冷启动、空闲恢复与稳态，不删掉预热失败。JFR/调度观测有开销，因此单独报告。

完成后可进一步复算事件、调度增量并绘图（绘图依赖 matplotlib）：

```powershell
python benchmarks/analyze-calibration-evidence.py $taskRoot
python benchmarks/summarize-calibration-scheduler.py (Join-Path $taskRoot 'scheduler-evidence.json')
python benchmarks/plot-capacity-calibration.py $taskRoot
```

专属 Redis 使用 256MiB 容器上限，关闭 RDB 定时保存和 AOF。所有模式的慢日志阈值统一为 1000µs；不把该容量结果推广到启用持久化的 Redis 部署。
