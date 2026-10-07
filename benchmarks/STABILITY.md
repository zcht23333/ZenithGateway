# 稳定负载、内存归因与冷启动接流量实验

这些脚本在独立 Docker 网络与 Redis 命名空间中运行，使用冻结的应用 JAR。它们不修改应用配置文件、不升级开发实例，也不自动把实验调参应用到产品。

本轮结果与判读见 `docs/backend-stability-and-startup.md`；原始协议保存在本轮证据根目录的 `plan.json`。脚本执行成功不等于所有负载阶段健康，必须同时查看 `stages[].assessment`。

## 运行条件与固定边界

- 从仓库根目录运行，需要 Node.js 24、Python 3、Docker Desktop Linux 容器，以及至少 16 个可用逻辑 CPU。
- 三个容器镜像使用 `stability.mjs` 中的固定摘要；脚本用 `--pull=never`，需事先准备对应镜像。
- 单实例 A 使用逻辑 CPU 4–7；双实例冷启动时 B 使用 13–15。两者不是对称资源，因此本实验不用于证明双实例线性扩容。
- JVM：G1、堆 256–512 MiB、直接内存上限 256 MiB、容器内存上限 1 GiB，开启 NMT summary。
- 应用使用已有 `capacity` profile，限流 8 个工作连接、128 个排队决策、500 ms 决策预算。默认 profile 的队列仍为 64，不在本轮内变更。
- 代理每个目标上限 100 个连接、100 个等待获取连接的请求、500 ms 获取预算。限流、监控、审计、熔断均开启。
- 32 条路由轮流转发到同一固定小响应上游；共享限额为每秒 10,000、突发 10,000。
- 负载生成器最多 256 个在途请求，每个请求绝对期限 8 秒。计划但未发出的请求单独记为调度错过或在途上限错过，不计为 HTTP 成功。
- 本机共享 Docker VM 和宿主机，结果是所述条件下的样本，不是生产容量承诺。

## 先冻结应用

在开始前保存目标 JAR 的副本和 SHA-256，记录工作区文件哈希、现有容器列表及实验顺序。不要在同一次对照中重新构建或替换 JAR。

下面的 `STABILITY_JAR` 应指向已冻结的副本，`STABILITY_OUTPUT` 必须是尚不存在的目录。运行工具只会清理自己创建且所有权标签匹配的资源。

```powershell
$node = '.dev/toolchains/node-v24.21.0-win-x64/node.exe'
$env:STABILITY_JAR = 'D:/Java/ZenithGateway/.dev/<本轮证据目录>/baseline.jar'
$env:STABILITY_PROFILE = 'capacity'
$env:STABILITY_WORKERS = '8'
$env:STABILITY_QUEUE = '128'
$env:STABILITY_ROUTES = '32'
```

## 冷启动对照

每次调用创建一对新 JVM。A 完成路由写入与一次真实转发验证，B 从共享存储恢复；确认双方采用相同路由版本后启动负载。输出记录两实例从就绪到负载开始的实际间隔，不将就绪解读为已经达到稳定负载能力。

```powershell
$env:STABILITY_PHASE = 'cold'
$env:STABILITY_RATE = '2000'
$env:STABILITY_COLD_STRATEGY = 'immediate'
$env:STABILITY_OUTPUT = 'D:/Java/ZenithGateway/.dev/<新的立即接流量目录>'
& $node benchmarks/stability.mjs
```

将策略改为 `gradual`、输出目录改为另一新目录即可运行渐进组。预先固定顺序为立即、渐进、渐进、立即、立即、渐进，每次均等待清理完成。

| 策略 | 前 60 秒 | 后 60 秒 |
| --- | --- | --- |
| immediate | 2,000 req/s | 2,000 req/s |
| gradual | 100、500、1,000 req/s，各 20 秒 | 2,000 req/s |

阶梯切换复用负载端连接，不在阶梯之间停止或清空连接池。比较共同的最后 60 秒，保留前 60 秒的所有错误、故障放行和未发出请求。两组总请求量不同，不能用全程 P99 直接声称同等负载下的延迟改善。

`firstFailures` 最多保留前 128 条错误的实例、时间、状态与截断后的响应正文；总数以完整状态计数和服务端原因计数为准。每条错误正文最多 2,048 字符。仅使用隔离测试数据。

## 60 分钟稳定负载

在冷启动对照全部结束后单独运行，期间不要同时执行构建或其他压测。

```powershell
$env:STABILITY_PHASE = 'longevity'
$env:STABILITY_RATE = '4000'
$env:STABILITY_LONG_SECONDS = '3600'
$env:STABILITY_IDLE_SECONDS = '600'
$env:STABILITY_OUTPUT = 'D:/Java/ZenithGateway/.dev/<新的长时实验目录>'
& $node benchmarks/stability.mjs
```

完整顺序约 78 分钟，另加启动和诊断时间：

1. 60 秒预热，预热失败仍独立记录。
2. 连续 3,600 秒、每秒计划 4,000 个请求。
3. 600 秒无代理负载，观察连接回收与内存。
4. 300 秒恢复同等负载。
5. 120 秒再次空闲。
6. 所有上述测量结束后，依次调用 `System.trim_native_heap` 和 `GC.run`，用于区分可回收原生堆与 Java 堆的影响。

长时负载不允许设置为少于 3,600 秒。负载期间不强制 GC、不 trim，不删除不利样本。人为干预后的数字不能混入自然稳定性结论，也不是推荐的应用运行策略。

## 证据与核对

每轮输出包含：

- `summary.json`：运行身份、JAR/测量脚本哈希、容器资源、阶段、采样、逐实例对账和清理结果。
- `NN-阶段/load-result.json`：计划量、实际发送量、错过量、状态、按状态分开的延迟直方图、逐秒累计结果和分段计数。
- `memory-*/`：NMT、堆信息、代码缓存、glibc 分配器信息、Linux smaps、smaps_rollup、进程状态与 cgroup 内存。
- `A-gateway.log`、冷启动时的 `B-gateway.log`，以及各阶段负载日志。

每个负载阶段必须满足：

```text
计划请求 = 实际发送 + 调度错过 + 在途上限错过
实际发送 = 已完成
监控完成数增量 = 对应实例收到的负载请求与探测请求
审计接收增量 = 已确认写入 + 丢弃 + 结果未知 + 在途增量
```

健康判据另要求全部实际响应为 200、无传输错误、无限流故障放行、无审计丢弃或未知、无对账差异、无采样错误，且计划错过不超过 1%。即使所有响应为 200，故障放行也会使该阶段判为不健康。

内存阶段每约 2 秒采集应用指标、每约 10 秒采集 RSS，空闲时约 5 秒一次。冷启动最初 20 秒以约 250 ms 间隔加接口耗时采集，之后约 1 秒。RSS 与其他指标不是原子快照。

每 5 分钟记录一次原生内存细分；`jcmd` 等诊断有观察开销，相关时间保留在证据中，不从请求结果中剔除。NMT committed、Java heap used、smaps RSS 是不同概念。分配器空闲桶字节也不等同于可以立即返还操作系统的驻留内存。

## 汇总与图表

```powershell
python benchmarks/summarize-stability.py <冷启动summary.json列表> <长时summary.json> --output <新的汇总.json>
python benchmarks/plot-stability.py <汇总.json> --output <新的图表目录>
python benchmarks/validate-stability.py <本轮证据根目录> --output <新的完整性核对.json>
```

完整性核对工具按本轮约定的六个冷启动目录和 longevity 目录核对身份、时长、请求与审计计数、共同目标阶段和人工干预时机；它不会把故障放行阶段改判为健康。

汇总工具拒绝覆盖已有输出，图表工具也使用新目录。原始结果和失败样本保留，分析结论应注明：

- 是否复现 503、准确原因、实例和时间范围；
- 相同目标负载阶段的结果，及起步阶段故障放行；
- 后段内存增长速度、堆驻留页、代码缓存、其他匿名页和分配器保留量；
- 空闲、重新加压与人工诊断干预分别发生了什么；
- 有限时长不能排除所有内存泄漏，也不能覆盖 TLS、大响应、长流或生产故障切换。

## 中断与清理

正常完成和异常路径都会导出已有日志并清理当前实验拥有的容器、网络与临时认证文件。脚本在清理前验证所有权标签，不会删除已有开发容器。强制终止宿主进程或 Docker 故障仍可能留下资源；此时根据 `summary.json` 中的实验 ID 和 `zenith.stability.owner` 标签逐项核对，不按名称前缀批量删除其他资源。

整个过程不执行生产数据迁移、不变更现有开发实例、不将试验性阈值写入正式配置。
