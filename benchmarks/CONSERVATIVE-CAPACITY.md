# 保守容量与内存观察

入口：`node benchmarks/conservative-capacity.mjs`。它读取 `CAPACITY_BASELINE_JAR` 指定的已校验发布包，输出到 **尚不存在** 的 `CAPACITY_BASELINE_OUTPUT` 目录。需要 Docker 提供至少 16 个逻辑 CPU，并提前拉取入口中固定摘要的 Redis、Node 与 JDK 镜像。不会升级开发实例。

PowerShell 示例（替换为自己已经校验的绝对路径）：

```powershell
$env:CAPACITY_BASELINE_JAR = 'D:/evidence/final/gateway.jar'
$env:CAPACITY_BASELINE_OUTPUT = 'D:/evidence/capacity-run-01'
node benchmarks/conservative-capacity.mjs
```

计划在首次流量前写入 `plan.json`，工具源码复制到专属输出目录并计算 SHA256。`conservative-capacity-gates.mjs` 固定本轮门槛，不能在实验中调整门槛来制造通过结果。

| 阶段 | 固定负载与时长 | 决策 |
| --- | --- | --- |
| 启动和建路由 | 32 条路由，一次转发探测 | readiness、实际配置和真实转发必须正确；这些请求不计入正式窗口 |
| 预热 | 100/s 30 秒、500/s 30 秒、1000/s 60 秒 | 保留所有失败，预热结果单独报告 |
| 短测 | 1000/s，两次各 120 秒 | 两次均健康才继续 |
| 入场确认 | 内存检查点之后 1000/s 30 秒 | 健康才进入长测，避免把诊断间隔当作热态 |
| 长测 | 1000/s，3600 秒 | 实际完成后按全部门槛判定，不以 HTTP 200 独立宣称通过 |
| 降载 | 100/s 120 秒 | 观察资源、审计和响应恢复 |
| 空闲 | 600 秒 | 继续记录内存、连接池、线程与积压；不触发 GC 或 malloc trim |

网关固定 cpuset 4–7、容器内存 1 GiB、G1、堆 256–512 MiB、直接内存上限 256 MiB；这些是逻辑 CPU 限制而非独占物理核心。Redis cpuset 0–1/256 MiB，上游 2–3/256 MiB，生成器 8–11/512 MiB。宿主其他程序、Docker Desktop 和 Windows 调度仍可能影响结果。本轮只有一个承载流量的网关，没有额外空闲 B 实例。

沿用 `capacity` 启动 profile：限流 8 个工作线程、128 个排队名额、500 ms 预算，交接关闭，两项故障策略均为 allow；额度 10000/s、容量 10000、单次成本 1。32 条路由均启用熔断；监控和审计开启。小 HTTP GET 响应、无 TLS；专属单 Redis 不开启持久化。不能外推为生产 Redis 持久化、复杂上游、大响应或流式业务的容量。

健康要求：全部已发请求收到 200，零传输失败，故障放行/保护性拒绝/扣费未知/取消/绕过为零，正常许可与转发及确认扣费均与请求数一致；审计收到、确认写入及完成统计和上游接收逐阶段对账。生成器到达缺口 ≤1%，P95 ≤50 ms、P99 ≤100 ms、从计划到达计算的 P99 ≤150 ms。资源不能越界，采样缺失、计数器重置及版本变化均判失败。无负载不等于通过。

版本门禁覆盖全部已完成响应的 `versions` 计数：计数必须为正整数、总和等于 `finished`，每个响应都使用窗口基准的路由版本，缺失响应头不能通过。窗口前后和**每个诊断采样**都核对实例身份、运行配置及路由采用版本、存储观察版本、同步状态与过期标志；同步失败累计数增加或重置也会失败，包括采样间失败后已恢复的情况。基准允许已有历史失败计数，但窗口内不能增加。此入口只验证单个承载流量的实例，不将全局响应版本计数外推为多个实例的逐实例证明。运行配置版本来自诊断采样，响应头只证明路由采用版本。

本地诊断及 Prometheus 约每 2 秒采样，RSS/cgroup 约每 10 秒采样；实际时间戳保留。NMT summary、GC.heap_info、codecache 和 smaps 在负载窗口之外读取。NMT 是 HotSpot 跟踪的分配/保留信息，不能直接等同 RSS。GC 与 safepoint 日志同时归档；不主动执行 Full GC。审计存储最多保留最近 5000 条，整场对账依靠累计计数，不能宣称保留了数百万条逐请求历史。

驱动只有 256 个在途请求；8 秒请求上限，阶段总时长加 45 秒的容器截止时间。正常停止先请求网关 shutdown（5 秒），`docker wait` 最多 45 秒，随后最多 5 秒读取容器状态；判定预算最多 55 秒，不含最后的资源删除。只有管理请求获确认、实际退出码为 0，且 `inspect` 确认已退出、无 OOM 或容器错误并与退出码一致，才标记 `AGraceful=true`。命令行成功不等于容器退出成功。原始 stdout、退出码、容器状态、错误与时间保存在 `cleanup.AShutdown`，删除容器前先保存；异常退出使整场 `passed=false` 和工具退出码非零。最后只移除带本轮随机 owner 标签的容器、匿名卷、网络和凭据。失败窗口及退出失败都保留，失败短测不会自动降低速率或进入一小时。

工具检查：`node --test benchmarks/conservative-capacity-gates.test.mjs benchmarks/conservative-capacity-shutdown.test.mjs benchmarks/stability-load.test.mjs`。门禁及退出测试均纳入统一验收工具清单。夹具只检验判定逻辑，不能代替真实容量实验。历史 4000/s 一小时失败结论不受本实验影响。

实验结束后运行 `node benchmarks/conservative-capacity-report.mjs <实验目录>`，使用该实验归档的判定源码重新计算各阶段门槛，并生成 `analysis.json` 与 `memory-series.json`。报告同时给出 RSS 起止值、前后五分钟中位数、末二十分钟趋势和 NMT 检查点；短阶段的前后五分钟可能重叠，不能把这些重叠窗口当作长期平台证据。

已封存证据不要再用上述命令覆盖。2026-10-07 两项 P2 的补验入口为：

```powershell
node verification/conservative-capacity-p2-live.mjs <原实验目录> <尚不存在的新输出目录>
```

此专项入口只读原始 `summary.json`，按归档阈值用当前门禁重算全部窗口，将 8 个内存修改副本与旧门禁对照；再运行两个真实隔离 Node 容器（退出码 0 / 23）和当前工具的实际退出分支。需要已缓存的固定摘要 Node 镜像与 Docker；管理 shutdown 确认使用夹具，不启动新网关、不重跑一小时。输出源码身份、各项判定、容器状态及清理证据到新目录。它不会把旧 `AGraceful` 布尔值补写成从未采集过的容器 inspect 记录。原始证据缺少响应版本或诊断信息时应判证据不足，不能补零或默认健康。补验结果见[修复记录](../docs/backend-conservative-capacity-p2.md)。

本轮发现的诊断边界：`peakCommandsInFlight` 在预热中为 9，原包受控回调夹具证明“结果已认领、计数稍后扣减”可造成短暂高估。它不能直接当作真实 Redis 并行执行数。`healthy` 是预先定义的窗口与定期采样判定，不等于已穷尽证明每个瞬时资源峰值。报告必须同时列出自启动累计峰值、窗口采样峰值及这个限制，见[实际报告](../docs/backend-conservative-capacity.md)。

计数修复的专项短回归可显式设置 `CAPACITY_BASELINE_MODE=command-counter-short`。它使用独立的预声明计划：100/s 10 秒→500/s 10 秒→1000/s 40 秒预热，两段 1000/s × 60 秒，100/s × 15 秒降载及连接池回收。资源、额度、健康阈值不变；跳过一小时、600 秒空闲和 NMT 检查点，`longValidated` 必须为 null。没有设置该变量时，仍执行上面的完整容量计划。对两个包分别指定新的输出目录，切勿覆盖旧容量证据。该短模式及实际对照结果见[计数生命周期修复记录](../docs/backend-limiter-command-counter.md)。

RSS 专项显式设置 `CAPACITY_BASELINE_MODE=rss-investigation`。负载时长、资源和既有健康阈值与完整容量计划相同，额外要求累计命令峰值不超过工作槽位；预热或任一短测失败即停止后续升压，仍保留降载和空闲观察。长测和空闲期间每五分钟追加只读检查点，最多 24 次，记录 NMT、堆地址、代码缓存地址、smaps、cgroup stat/events 及每项诊断的时间。每条容器内命令由 `timeout` 限制为 5 秒，另有 1 秒强制结束宽限；Docker 调用最多 8 秒。检查点 20 秒预算在命令之间核对，因此可能多出至多一次 8 秒调用。诊断失败、累计命令峰值越界或观测到 cgroup 用量达到 900 MiB 时终止负载并保留失败现场。容量健康仍由完整门禁判定，内存平台是独立判断。

```powershell
$env:CAPACITY_BASELINE_MODE = 'rss-investigation'
$env:CAPACITY_BASELINE_JAR = 'D:/evidence/fixed/gateway.jar'
$env:CAPACITY_BASELINE_OUTPUT = 'D:/evidence/rss-run-01' # 必须尚不存在
node benchmarks/conservative-capacity.mjs
node benchmarks/rss-report.mjs D:/evidence/rss-run-01 D:/evidence/rss-analysis-01
python benchmarks/rss-plot.py D:/evidence/rss-analysis-01
```

`rss-report.mjs` 只读输入证据，输出必须是输入目录之外、尚不存在的新目录；可用于复算旧样本。绘图依赖 Python 与 Matplotlib，生成 PNG/SVG。图中 NMT committed、heap used/committed、进程 RSS 和 cgroup 用量不能相加；Java 堆与代码缓存的 RSS 来自地址范围对应的完整 VMA，跨界 VMA 单独归为 `ambiguous`，不按比例猜测。GC 后占用须与 GC 类型一起读取，年轻代回收后的旧代占用不等于精确存活集。平台筛查阈值、实验身份和限制见 [RSS 专项报告](../docs/backend-rss-investigation.md)。未知模式值拒绝启动。

有明确原生分配器保留假设时，可以在**独立的新输出目录**显式选择 `CAPACITY_BASELINE_MODE=rss-native-retention`。这不是容量默认流程：资源、预热、两个 120 秒短测和入场确认相同，固定负载缩短为 600 秒，随后 120 秒降载与 120 秒自然空闲。在全部流量门禁通过、发生器停止且工作排空后，读取 `System.native_heap_info`，仅对 owner 标签匹配的本轮网关执行一次 `System.trim_native_heap`，再采集检查点及原生堆信息，观察 60 秒。每次 jcmd 同样有 5+1 秒容器内限制和 8 秒 Docker 限制；结果不确认时不重试。

干预是 Linux/glibc 环境中的原生分配器回收请求，没有执行 `GC.run`，不更换 JVM 或分配器配置。`nativeTrim` 单独记录时间、输出、耗时和 `capacityEvidence=false`；后续阶段为 `diagnostic-idle`。该模式只生成 `diagnosticLoadValidated`，`longValidated` 保持 null。它可以验证同一空闲进程有没有可归还的分配器页，不能将干预后的 RSS 下降当作自然稳定、泄漏消失或一小时容量结论。只在已保存的有限实验计划中使用，不做自动周期 trim。
