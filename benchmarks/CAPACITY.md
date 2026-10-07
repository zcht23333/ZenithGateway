# 当前版本容量与资源稳定性验证

本入口用于已完成路由版本发布后的容量研究。它与已有 `run.mjs`、`profile.mjs`、故障验收脚本并存，不改写它们的结果。当前实测结论见 [容量研究](../docs/backend-capacity-study.md)。

## 前提和隔离

从仓库根目录运行；需要 Node.js 24、Docker CLI、已构建的 JDK 21 应用 JAR。汇总需要 Python 3；绘图额外需要 matplotlib。Docker 至少分配 **16 个逻辑 CPU**。镜像按摘要固定，运行器使用 `--pull=never`，本地没有镜像会明确退出：

```powershell
docker pull redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
docker pull node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
docker pull mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5
```

这些命令下载公开运行镜像。每轮自建网络、临时 Redis、上游、Redis 故障代理、网关和压测进程；宿主端口随机分配且只绑定 127.0.0.1。网关、Redis、代理和发压容器使用独立逻辑 CPU 集合。网关 A 分配 4–7，双实例验证中的 B 分配 13–15；B 与 A 的 CPU 数量不同，双实例实验只验证有负载时的正确性，不用于计算横向扩容收益。

所有资源带本轮所有权标签，清理时核对标签。输出目录必须不存在，父目录必须存在；拒绝覆盖已有证据。测试令牌只写到本轮独立 secrets 目录，挂载只读；运行结束删除本轮令牌和容器，保留结果与日志。失败同样保留结果。不要在测量期间同时运行其他压测、构建或大型分析任务。强制杀掉整个宿主进程可能绕过 finally，届时只按本轮日志中的名称和所有权标签清理资源。

## 参数与口径

所有正常样本都开启限流、监控、审计及每条路由的熔断，使用 32 条路由、固定小响应、同一个 Redis 主库，无持久化和副本。发压进程轮询全部路由，双实例时轮询两个实例。初始化令牌速率、容量为受支持的 10,000，每次扣 1，业务限流保持开启；此值仅用于隔离压测的空配置初始化，不修改任何现有环境。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| CAPACITY_OUTPUT | .dev/capacity-随机值 | 必须是新目录 |
| CAPACITY_JAR | backend/target/zg-1.0.0.jar | 推荐先复制并冻结 JAR |
| CAPACITY_PHASE | pilot | pilot / ramp / compare / profile / soak / faults / mutations |
| CAPACITY_RATE | 1000 | 固定到达率，1–10000 |
| CAPACITY_WORKERS | 8 | 限流连接/工作槽位，1–64 |
| CAPACITY_PROFILE | 空 | 空或 capacity；capacity 从打包配置读取队列值 |
| CAPACITY_QUEUE | 64；capacity 时为 128 | 无 profile 时直接设置；有 profile 时作为实际值断言 |
| CAPACITY_ROUTES | 32 | 1–256 |
| CAPACITY_SECONDS | 30 | pilot / compare / ramp 的测量秒数 |
| CAPACITY_REPETITIONS | 3 | pilot / compare / ramp 的重复数，1–5 |
| CAPACITY_WARMUP | 30 | 预热秒数，5–120 |
| CAPACITY_WARMUP_RATE | min(rate, 1000) | 受控比较应显式设为被比较的速率 |
| CAPACITY_SOAK_SECONDS | 900 | 持续负载，900–1800 秒 |
| CAPACITY_RATES | 1000,2000,4000,6000,8000 | ramp 速率列表；偶数轮反转顺序 |

发压上限为 256 个在途请求；超过该上限的计划槽位记录为 capacityMisses。调度器最多追赶 10 ms，来不及派发的较老槽位记录为 schedulerMisses。未发出的请求不伪造延迟样本。每个已派发请求有 8 秒绝对客户端期限，响应异常只有一次终态计数。所有 HTTP 状态、传输失败及分状态延迟分开保留。延迟包含实际派发到响应体结束；scheduledLatency 另外包含已派发请求的调度延迟。

`requestsPerSecond` 包括错误响应；`successfulRequestsPerSecond` 只计算 HTTP 200。**即使 HTTP 全部 200，只要存在限流故障放行，也不算健康容量。**

每个阶段结束后排空请求和审计，自动对账：

- offered = issued + schedulerMisses + capacityMisses。
- issued = finished；监控完成数 = 审计接收数 = 发压完成数 + 本轮主动探测。
- 审计接收数 = 确认数 + 明确丢弃数 + 结果不确定数 + pending 增量。
- Redis 最近保留的 5000 条事件 ID 不重复；全量对账依靠累计确认计数，不把列表长度当成全量记录。
- 采样中的审计、限流连接、等待队列和定时任务不越过已配置上界。

健康标准：全部 HTTP 200、传输失败为 0、限流故障放行为 0、审计丢弃/不确定为 0、对账差为 0、采样失败为 0，且漏发比例不超过 1%。soak 和 faults 最后的恢复阶段会断言健康。ramp / compare / profile 保留不健康样本供分析；**summary.passed 只表示实验执行与断言通过，不能替代 stages[].assessment.healthy**。故障阶段允许预期的拒绝、故障放行及审计丢弃，但必须保留计数与完整对账。

## 实际运行

先把当前包复制到新的文件名，后续构建不覆盖被测对象：

```powershell
$capacityJar = Join-Path $PWD ('.dev/capacity-frozen-' + [guid]::NewGuid().ToString('N') + '.jar')
Copy-Item -LiteralPath backend/target/zg-1.0.0.jar -Destination $capacityJar
$env:CAPACITY_JAR = $capacityJar
$env:CAPACITY_ROUTES = '32'
$env:CAPACITY_WORKERS = '8'
$env:CAPACITY_PROFILE = ''
$env:CAPACITY_QUEUE = '64'
$env:CAPACITY_RATE = '6000'
$env:CAPACITY_WARMUP = '60'
$env:CAPACITY_WARMUP_RATE = '6000'
$env:CAPACITY_SECONDS = '30'
$env:CAPACITY_REPETITIONS = '3'
$env:CAPACITY_PHASE = 'compare'
$env:CAPACITY_OUTPUT = Join-Path $PWD ('.dev/capacity-compare-' + [guid]::NewGuid().ToString('N'))
node benchmarks/capacity.mjs
```

比较另一个队列值时，只改 CAPACITY_QUEUE，使用另一个新输出目录。先设回 8 个 workers，防止之前的环境变量残留。一个进程里的三次连续测量不是三个独立 JVM 样本；报告须说明预热、顺序和每轮原始结果。

测试新包中的可选 profile，并持续测量 15 分钟：

```powershell
$env:CAPACITY_PROFILE = 'capacity'
$env:CAPACITY_QUEUE = '128'
$env:CAPACITY_WORKERS = '8'
$env:CAPACITY_RATE = '4000'
$env:CAPACITY_WARMUP = '60'
$env:CAPACITY_WARMUP_RATE = '4000'
$env:CAPACITY_SOAK_SECONDS = '900'
$env:CAPACITY_PHASE = 'soak'
$env:CAPACITY_OUTPUT = Join-Path $PWD ('.dev/capacity-soak-' + [guid]::NewGuid().ToString('N'))
node benchmarks/capacity.mjs
```

可选 profile 只把限流等待队列从 64 调到 128，不改变令牌速率、超时、故障放行策略或任何存储协议。普通启动仍为 64。若用于其他环境，正常保留原有鉴权、Redis 和运行参数，并在原有 Spring profiles 列表中加入 capacity；移除它并重启即可撤销该队列设置。不要把隔离实验的 10,000 令牌参数直接用于真实业务。

故障实验建议保留资源余量，设 CAPACITY_RATE 和 CAPACITY_WARMUP_RATE 为 2000，并更换输出目录：

- `CAPACITY_PHASE=faults`：50 秒阶段中第 10–30 秒延迟所有 Redis 回复 50 ms；另一 50 秒阶段第 10–25 秒断连；60 秒阶段第 10–30 秒让上游延迟 2500 ms；最后 30 秒完全恢复。故障代理本身的缓冲、定时项、CPU、溢出计数也有证据。
- `CAPACITY_PHASE=mutations`：两实例下运行 70 秒；第 10、38 秒更新监控窗口，第 23、51 秒把一条路由切到 V2 再恢复 V1。核对两实例运行版本，并对路由同时检查真实响应体和 X-Zenith-Route-Version。两个实例依次探测，elapsedMs 是从提交开始到观察的上界，不是精确内部采用时间。

`CAPACITY_PHASE=profile` 单独运行至少 60 秒 JFR，不能混入未录制样本的容量对比。随后用现有 `benchmarks/analyze-jfr.py` 分析。保留原 .jfr；抽样热点不是精确的因果 CPU 分摊，也不直接证明锁争用或内存泄漏。

## 验证入口与证据

```powershell
node --test benchmarks/capacity-load.test.mjs
python benchmarks/summarize-capacity.py <一个或多个 summary.json 路径> --output <新的汇总.json>
python benchmarks/plot-capacity.py <汇总.json> --output-dir <新的图片目录>
```

每轮包含：固定包 SHA-256、运行脚本哈希、镜像摘要、VM 参数、实际生效限流配置、每秒发压统计、约每 2 秒网关资源与状态、约每 10 秒 RSS、阶段前后对账、原始日志、清理状态。汇总保留预热、诊断、失败和故障样本，不平均多个 P99。

Docker 逻辑 CPU 绑定不等于物理核心独占；本实验没有验证生产容量、HTTPS/大包/长流、Redis 持久化与主从切换、跨主机网络、所有客户端 IP 分布或数小时以上稳定性。配置同步管理查询由采样和后台触发；本轮没有增添逐请求配置查询，也不把每次转发本来就需要的 Redis 限流调用算作配置查询。
