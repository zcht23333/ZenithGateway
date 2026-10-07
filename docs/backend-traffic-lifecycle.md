# 冷启动接流量与安全退出

日期：2026-10-06。交付状态：实现和隔离验证完成，待独立验收。现有开发实例未升级。

本轮建立了“恢复完成 → 小流量核对 → 分阶段增加 → 停止准入 → 在途请求结束 → 审计终态 → 释放客户端”的操作流程。接流量的权重调整由验收发生器执行，产品没有新增负载均衡或自动扩容机制。readiness 继续表示启动恢复完成，不代表能够立即承受目标流量。

**结论范围：相同最终包、每网关 2 CPU / 1 GiB、固定测试上游下，三次新 JVM 立即接 1000 req/s 均未通过，三次逐步接流量最终通过 1000 req/s × 20 秒窗口。一次首阶段因 P99 超标暂停，再次核对后才继续。4000 req/s 一小时未通过、没有已通过一小时验证的健康容量档位，这两个结论保持不变。**

## 1. 检查到的缺口与实现选择

原有运行参数、路由启动恢复以及 readiness 门禁已存在；Redis 连接或路由恢复失败不会伪装就绪。原有 Netty 优雅停机和审计排空也存在，但缺少可观察、可提前执行的业务准入关闭边界。仅凭 readiness 和一次探测不能证明代理连接池、限流工作线程及审计链路已经能承受突增。

本轮没有向任意业务路由发送自动预热请求，也没有扩大资源默认值。小流量验证使用隔离环境的无副作用 GET。真实部署需要自己指定允许探测的路由、合成账号及适用业务；不能自动重放写请求“预热”。

源码核查与本轮实测分开：

- 启动恢复、代理超时/熔断、限流决策、同步和审计原有协议的依据在既有实现及 [启动记录](backend-stability-and-startup.md)、[容量记录](backend-capacity-calibration.md)、[故障策略](backend-limiter-failure-policy.md)、[监控语义](backend-limiter-monitoring.md)。本轮未对旧包重新做性能对照。
- 使用本轮最终包的立即/逐步接流量对照，再次实际复现 readiness 后的连接池拒绝、故障放行及延迟退化。没有把源码推断写成实验结论。
- 实际依赖 Spring Boot 4.1.1 的 `WebServerGracefulShutdownLifecycle` phase 为 `2147482623`，服务停止 phase 为 `2147481599`。本轮协调器 phase 为 `2147483647`，审计保留 phase 0 作为兜底。反编译输出保存在证据根目录 `framework-lifecycle.txt`；真实退出日志验证了次序。
- [Boot 官方停机说明](https://docs.spring.io/spring-boot/reference/web/graceful-shutdown.html)中的超时是**每个生命周期阶段**的预算，不能当成总停机上限。Netty 停止网络接收以后管理端口也不能继续提供观察，因此本轮在它之前执行业务排空。

主要实现：`TrafficLifecycle` / `TrafficLifecycleProperties` / `TrafficLifecycleController`、`ReadinessFilter`、`RequestCompletionRecorder`；审计停止改为幂等且连接关闭有界。运行参数六字段、版本协议、路由协议、额度算法、失败策略默认 allow 和交接默认 false 均不变。没有前端修改。

## 2. 状态、执行主体和接口

| 状态 | 执行主体与含义 | 允许的行为 |
|---|---|---|
| `starting` | 配置及路由从权威存储恢复；尚未满足 readiness | 健康探针可用；业务不准入 |
| `ready` | 网关已恢复；诊断中列出本地采用的独立配置/路由版本 | 外层发生器或部署控制器仍可给它零权重 |
| 小流量、递增、目标窗口 | **外层流程的状态**，不是 readiness 的新含义 | 逐阶段计数并评估，不通过就不增加 |
| `requests` | drain 边界已成立，readiness 变为拒绝 | 已取得准入 lease 的业务继续；新业务 503 |
| `cancelling` | 请求预算到期 | 取消剩余转发；已提交响应只中断流 |
| `audit` | 请求终态已记录，关闭审计入队，按预算排空 | 本地诊断仍可读；没有新业务或新管理写操作 |
| `drained` | 在途数和审计 pending 为 0，审计 worker 已结束 | 可以发送 SIGTERM；**不表示每条审计都已存储确认** |
| `incomplete` | 预算内未确认全部结束，或协调失败 | 保留诊断；由外层期限决定终止，不能宣称无损 |
| 进程结束 | Netty 关闭后，销毁同步/限流/Redis 等客户端 | 不再提供 HTTP 诊断 |

受现有管理 Bearer 认证保护、响应 `Cache-Control: no-store`：

- `GET /settings/lifecycle`：纯本地观察，不读取 Redis、不推动同步。包含 instanceId、adoptedRuntimeVersion、adoptedRouteVersion、阶段、开始/结束时间、在途数、admitted/completed/rejectedBeforeAdmission/clientCancelled/deadlineTerminated、预算和审计计数。两种版本相互独立，不承诺这两个读取构成跨协议的原子事务。
- `POST /settings/lifecycle/drain`：202，关闭本 JVM 的新业务准入并开始排空。重复、并发调用加入同一次操作，返回同一个 drainStartedAt，不延期、不新建后台队列。此操作不可撤销；恢复接流量需要新进程。它不直接退出 JVM，也不转发给其他实例。

drain 期间仍允许受认证的本地 GET：上述接口、`/settings/runtime/adopted`、`/settings/runtime/sync`、`/settings/routes/adopted`、`/settings/routes/diagnostics`、`/settings/proxy/diagnostics`、`/settings/rate-limit/diagnostics`、`/monitor/audit/status`。已有 actuator 探针和管理认证规则保持不变；liveness 不因 draining 或共享 Redis 故障变成死亡。其他新的管理请求在 drain 后被拒绝；**进入边界以前已经开始的管理操作不在业务 lease 内，不承诺回滚它们**。部署时应先停止向退出实例发送管理写请求。

## 3. 接流量流程和提前确定的门槛

验收入口会先写 `plan.json`，再创建实例；不根据失败结果放宽门槛。A 先完成 25/100/200 req/s 准备窗口，再按 200 req/s 的连续 5 秒发生器窗口服务。新 B 的每次比较都使用新 JVM。比较顺序固定为：立即、逐步、逐步、立即、立即、逐步。

| 阶段 | 目标及观察窗口 | 最长等待/失败处理 |
|---|---|---|
| 启动恢复 | readiness UP，核对本地实际采用的配置和路由版本 | readiness 60 秒；不通过停止该次实验 |
| 首档 | B 25 req/s，10 秒 | 任何健康条件不满足都暂停提升 |
| 递增档 | 100、250、500 req/s，各 10 秒 | 原档最多 3 个完整窗口；版本变化、资源未恢复或重复失败则不升档 |
| 目标档 | 1000 req/s，20 秒 | 同样执行全部条件，不只看 200 或平均延迟 |
| 恢复复查 | 真实运输状态 healthy、同步 ok、审计/请求无积压 | 15 秒；然后重新观察当前档的完整窗口 |
| 交接 | 停止向 A 分配新请求，B 继续 1000 req/s × 20 秒 | A drain 后 SIGTERM；B 窗口仍需全部通过 |

健康窗口必须同时满足：

1. 客户端全部完成为 200；意外 5xx、传输错误、客户端取消均为零。
2. 额度拒绝、故障放行、保护性拒绝、扣费未知的**增量**为零；正常场景容量/速度提前设为 10000、成本 1，两实例合计目标远低于配额。
3. P95 ≤ 100 ms、P99 ≤ 250 ms；发生器 `(schedulerMisses + capacityMisses) / offered ≤ 1%`。客户端最大在途 256、单请求 8 秒；不足时记缺口，不无界排队。
4. 每 500 ms 读取本地诊断：限流队列 ≤ 64、真实命令 ≤ 8、retained ≤ admissionCapacity；代理连接/等待队列不越配置上限；连续两次 I/O 队列占用 > 75% 即停止提升。采样失败也不判健康。周期样本不能证明两次采样之间没有瞬时峰值，故同时检查累计故障/拒绝计数。
5. before/after 实例身份、版本不变、同步状态正常；请求终态、上游接收和审计增量对账。健康窗口审计须在 15 秒内全部确认，unknown/dropped/pending 为零。

故障窗口单独标注 `declaredFault`：严格 Redis 策略的 503 是预期动作，上游应为 0，但该窗口仍**不允许升档**；默认 allow 的 200 只要带故障放行，也不允许升档。unknown 与动作是交叉维度，不重复计入请求总数。`traffic-lifecycle-gates.mjs` 的纯判定测试覆盖这些区别。

控制 API 单次 3 秒、Docker 管理命令一般 30 秒、Redis 取证命令 10 秒；轮询间隔 50 ms。阶段等待还有末次有界探测的耗时，不声称硬实时调度保证。每个窗口、重复次数、生成器任务/在途数、辅助服务内存及证据写缓冲都有界。

## 4. 退出边界、预算和记录语义

业务准入和开始 drain 共用一把短锁。锁内先取得 lease 的请求允许继续；边界之后即使来自同一条已建立的 HTTP/1.1 keep-alive 连接，也返回 `503 {reason: instance_draining}`、`Connection: close`，不会到上游。它不会自动重试到 B；需要外层提前撤权重。启动未就绪返回 `instance_not_ready`。

终态记录在最外层 `RequestCompletionRecorder`，完成统计及审计发布之后才释放 lease，避免审计先关闭而最后一个业务记录尚未入队。一次入口只产生一个代理终态。准入前拒绝没有匹配路由，不冒充一次代理完成/上游访问/业务审计，而是记入 `rejectedBeforeAdmission`。验收单独核对它。

请求预算从 drain **锁内确立边界的单调时钟**开始，晚调度不能延长它；UTC 时间只用于展示。到期取消尚未完成的转发：

- 响应未提交：503、`shutdown_deadline`；可能已经产生上游副作用，不能据此重试写请求。
- 已提交响应：保留原状态和已发送字节，直接中断；记录 `reason=shutdown_deadline`、error，不拼接错误 JSON、不伪造新状态码。
- 客户端主动取消：独立 cancelled 终态；释放 lease 和相应转发资源。不是成功，也不是熔断失败。
- 原有代理总超时可能早于 drain 超时先结束请求。两者各按实际先发生的原因记录；本地 shutdown 不计上游熔断失败。已有代理自动重试继续关闭，取消不能撤销上游副作用。

| 预算 | 产品默认 | 本轮隔离实验 |
|---|---:|---:|
| `zenith.lifecycle.request-drain-timeout-ms` | 10000（校验 100–60000） | 2000 |
| `zenith.lifecycle.cancellation-settle-timeout-ms` | 1000（校验 100–5000） | 1000 |
| 审计排空 / 单次命令 | 5000 / 1000 | 1000 / 250 |
| 审计 stop 上界（排空 + 命令 + 2500） | 8500 | 3750 |
| 协调器合计预算 | 19500 | 6750 |
| Spring 每 phase 超时 | 30 秒 | 10 秒 |
| 外层进程退出监视 | 部署方配置 | SIGTERM 起 45 秒；超时 SIGKILL 管理命令另有 3 秒上限 |

Spring phase 小于“协调器预算 + 500 ms”时拒绝启动。审计 stop 使用同一个完成通知；重复停机不再延长排空期限或重复关闭 writer。审计连接关闭最多等 1 秒，Lettuce shutdown 最多 1 秒，另留协调余量。资源回收不在网关事件循环中阻塞。

实际顺序为：关业务准入 → 等待/终止已准入请求 → 审计排空并结算 → Netty graceful → 同步任务及限流客户端销毁。每 JVM 只有一个 traffic 虚拟协调线程、一个 audit stop 协调线程；没有停机任务队列。同步和限流保留原有有界队列/关闭机制。实测日志同时检查 commands/active/queued/retained 为零、同步线程结束、Redis 命名客户端消失。

工具对显式 drain 等待最多 12 秒（末次 HTTP 探测另最多 3 秒），然后发送 SIGTERM 并最多等待 45 秒；当前脚本对进程轮询共享绝对截止时间，TERM/KILL 控制调用各最多 3 秒。可把这一流程预留为 **65 秒外层操作预算**，证据导出和 Docker 清理另计。正式默认参数更长，建议部署控制器先分配至少 120 秒总终止宽限并在自身平台验证；这是外层硬终止预算，**不是 Spring 保证 120 秒内无损退出**。操作系统挂起、不可中断第三方代码、管理平面失联等仍可能阻止优雅完成。

已建立的监控 SSE 在业务 drain 阶段继续工作，不能再新建非白名单管理长连接；进入 Netty 停机后受 HTTP graceful 阶段预算约束。本轮验证了 drain 中 SSE 继续发数据，并由客户端关闭；未测试无限监控 SSE 耗尽整个 Netty 阶段预算。普通代理流式响应则实际验证了超出业务预算后的部分响应中断。

## 5. 审计排空、未知与损失

保持既有守恒式：`received = persisted + pending + uncertain + dropped`。

- persisted：已收到 Redis 批次确认，不等于持久化/主从故障切换保证。
- uncertain：已经尝试发送、但预算内未取得确认；可能写入，也可能未执行。不能当作丢失，更不能当作确认。
- shutdown dropped：仍未交给 writer 的排队事件，或停止接纳后才到达的事件；主动放弃，不能显示为已送达。
- pending：尚未结算，不能隐藏为零。若强制终止前仍有 pending，最后一份诊断只能说明当时状态。

若 cancellation settle 结束后仍有 lease 或审计 worker 未结束，状态为 incomplete；后续回调不会使已经关闭的审计入队重新开放。外层 SIGKILL 会跳过尚未完成的 hook，未结算内存记录可能丢失、在途写入可能未知；不能保证导出最后一份计数。**本轮没有人为 SIGSTOP 卡死 JVM 后强杀的实验，不对这种异常作无损声明。**

## 6. 固定产物、环境及复现入口

最终 JAR SHA-256：`c81145b3a5dbdc7e55a5320e94424b0948b236297239c3ee6b6d0f2caa2485a0`。正式对照、功能补验、SIGTERM 补验、代理和限流策略回归均使用这一字节相同的包。冻结副本在证据 `final-01/gateway.jar`，不使用在实验中重建的候选包。

每网关 Linux/JDK 21：2 CPU、1 GiB、512 PIDs、G1、ActiveProcessorCount=2、Xms256m/Xmx512m、直接内存 256 MiB。限流 8 workers / 队列 64 / handoff=false；两种失败策略默认 allow，只有故障严格实例显式 reject。Redis 1 CPU / 512 MiB、maxmemory 384mb、noeviction、关闭持久化；上游 1 CPU / 256 MiB；Linux 发生器 2 CPU / 256 MiB / 同时最多 2 个任务 / 4 MiB 证据写缓冲。完整 args、版本、镜像摘要、资源配置在各报告/inspect/plan 中。

实例通过一个独立 Docker 网络共享 Redis；随机宿主端口、随机认证凭据、独立 `zg:entry:<id>` 键空间。测试审计保留扩为每实例 200000，确保完整取证；这不是产品默认修改。慢请求专项临时设置 headers=10s/read-idle=11s/total=15s，使请求排空预算先到期；冷启动比较使用原有代理默认值。

复现需要 Docker Linux 容器、Node 24、JDK 21 / Maven 3.9（若要重新构建）。先准备固定摘要镜像；入口刻意使用 `--pull=never`，无缓存不能跳过此步骤：

```powershell
docker pull redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
docker pull node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
docker pull mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5
node verification/traffic-lifecycle-live.mjs --mode all --jar backend/target/zg-1.0.0.jar --out .dev/traffic-lifecycle-review-unique
```

`--out` 必须是未使用的新目录；run-marker 使用排他创建，防止覆盖旧证据。可用 `--mode functional`、`cold`、`signal` 单独重复。入口创建时记录容器 inspect/挂载归属，并在 finally 中只删除 owned 容器、它们的匿名卷、网络和临时认证文件，不做 prune，不操作开发容器。若 Docker 控制平面失联导致清理失败，报告会记为未通过，按 created.json 中的精确归属人工处理。

发生器 200 req/s 的连续 5 秒窗口之间存在控制往返间隙；实际到达/缺口被记录，没有把墙钟总时长乘目标速率当作实收。上游仅 `/quick`、可控制释放的 `/hold` 与部分输出 `/stream`；审计回复丢失代理只丢回复、限制最多 16 个连接，Redis 是否执行另由真实列表记录交叉证明。

## 7. 实测结果与证据

证据根目录：`../.dev/traffic-lifecycle-20261006-a798801c/`。机器入口：[backend-traffic-lifecycle-validation.json](backend-traffic-lifecycle-validation.json)。所有失败样本均保留，不覆盖、不从重复组中剔除。

正式 `final-01`：6 类流程检查、30 个观察窗口、11 个网关进程。立即接入前只有 readiness 和本地版本诊断，没有业务预热，首个窗口在 readiness 后约 86–126 ms 开始。逐步组同样从新 JVM 开始。

| 比较实例 | 实收/计划 20000 | HTTP / 传输结果 | 故障放行 | P95 / P99 ms | 结论 |
|---|---:|---|---:|---:|---|
| B1 立即 | 16872 / 20000 | 16830×200，42×503 | 4 | 583.679 / 1020.927 | 未通过 |
| B2 逐步，目标窗口 | 20000 / 20000 | 全部 200 | 0 | 2.219 / 3.461 | 通过该窗口 |
| B3 逐步，目标窗口 | 20000 / 20000 | 全部 200 | 0 | 1.717 / 2.535 | 通过该窗口 |
| B4 立即 | 16872 / 20000 | 16854×200，18 次传输错误 | 6 | 384.255 / 735.231 | 未通过 |
| B5 立即 | 9249 / 20000 | 7304×200，1939×503，4×504，2×502 | 4 | 1489.919 / 2283.519 | 未通过 |
| B6 逐步，目标窗口 | 20000 / 20000 | 全部 200 | 0 | 2.519 / 9.439 | 通过该窗口 |

B6 首个 25 req/s 窗口 P99=264.191 ms 超过预先规定的 250 ms，所以保留失败、未升档；同档第二窗口 P99=6.711 ms 后继续。三个立即组还有发生器到达缺口，故不能把它们描述为“网关完整承受了 1000 req/s”；仅能认定立即接入目标负载的流程失败。

B1 的 42 个 503 均为 proxy_pool_full。B5 的 1939 个 503 为 1793 pool_full + 146 pool_timeout，另有 4 headers_timeout、2 upstream_disconnect。B4 服务端有 16855 个 completed 和 17 个 cancelled，而客户端收到 16854 个 200 和 18 个传输错误：服务端完成不保证客户端取得完整响应。原始响应、上游接收和审计三方保留，未把这一个差异改成成功。没有将尾延迟统一归因到 Redis 或 JVM 某个单独因素。

A 的 67 个 5 秒窗口计划 67000、完成 66990，最大单窗口缺口 0.6%；全部 200，故障放行/保护性拒绝/unknown 为 0，审计增量 66990，最大窗口 P95=10.799 ms、P99=19.551 ms。交接后 B 的 20000 次请求全部 200、上游 20000、审计确认 20000、P99=3.161 ms，A 同时正常退出。

功能证据：

- 已有 keep-alive 的同一客户端 socket 在 drain 后发送的新请求实际返回 503，上游无对应记录；不是换一条连接的模拟。
- 准入前 5 个业务请求最终恰有 5 条唯一审计：正常/暖连接 2、主动取消 1、预算超时未提交响应 503 一条、预算超时部分响应 200/error 一条。后两条 shutdown_deadline；熔断失败数没有增加。
- 严格 Redis 故障窗口 75 个保护性 503、上游 0；默认窗口 75 个 200、75 次故障放行、上游 75；两者均停止提升。恢复后 25/100 req/s 完整窗口重新通过。
- 35 个已经正常响应、尚待审计确认的请求，在丢审计回复并暂停 Redis 后排空：9 条 uncertain、26 条 shutdown dropped。累计 received=1610、persisted=1575、uncertain=9、dropped=26、pending=0；恢复 Redis 后实际列表 1584 条，恰好证明 9 条 unknown 已经执行。
- 直接 SIGTERM、不预先调用 drain 也关业务准入、取消超预算请求、完成审计再进入 Netty shutdown。新请求被拒绝、慢请求 503、流式响应仅截断。原 `final-01` 的进程等待 4.737 秒；正常预排空后的 SIGTERM 为 2.638–2.986 秒。Linux JVM 正常收到 TERM 后退出码 143，不能据此误报异常。

正式原始报告的故障窗口理由曾把预期 503 也归为 unexpected。原文件没有改动；`stage-reassessment.json` 使用最终纯判定重新核对，所有窗口的通过/失败结论不变；`final-functional-02` 用同一包实跑最终分类，预期 503 的 unexpectedHttpResponses=0。`final-signal-03` 再验证绝对退出截止与匿名卷清理；最终 `final-health-04` 补查 Redis 失联时 readiness/liveness 均为 200，drain 后分别为 503/200，匿名诊断及匿名 POST drain 为 401、不会启动排空，并再次验证功能流程与清理。各版本的入口哈希单独记录，避免声称后来编辑过的脚本就是早期原样执行的脚本。

先前工具迭代记录：functional-01 的慢请求夹具违反 read-idle ≥ headers 校验，启动拒绝；functional-02 把正常 SIGTERM 143 错当作 0，已修正验收器（它记录的 forced 字段来自验收器误判，KILL 命令面对已退出进程，没有实际杀死服务）；functional-03 在 Windows 发生器上出现到达缺口，三个窗口均暂停，未放宽阈值，改用限定资源的 Linux 发生器；functional-04 通过。它们不是正式最终包的冷启动对照，仍全部保留。

## 8. 检查范围、清理和部署前提

亲自执行：后端完整 Maven verify **244 tests、0 failure/error/skip，生产 JAR 构建成功**；发生器和阶段判定 **18 项 Node 测试**；实际双实例接流量/退出流程；代理故障回归 **24 组 / 102 请求**；限流故障策略回归 **25 组 / 70 请求**（含四种策略、明确饱和、取消、恢复及实际启动拒绝）。真实 Redis 集成测试使用本轮自建测试 Redis，没有跳过。详细日志与 JAR 身份见机器报告。

未重跑：前端测试/构建、浏览器、所有独立配置提交/回滚/路由发布 live 全矩阵、Prometheus/Grafana 实验、容量一小时及 RSS 专项；本轮没有修改前端、配置存储/写协议、路由发布协议或监控消费者。相关 Java 回归随完整测试执行；没有把旧验收记录计作本轮亲自实跑。未验证 HTTP/2/WebSocket 停机、真实外部负载均衡器的连接复用/摘除传播、OS 卡死强杀、无限管理 SSE 持有整个停机阶段。

环境限制：初始默认 bridge 标识为 `47ebbbd9d765`，开始隔离流程时为 `3cfb7d693d01`，原因仍未归因；六次正式比较及补验期间未再变化，全部使用独立网络。保留 baseline.json、docker-info.json、各 host-before/after 和资源清理记录，不能宣称整轮环境完全没有变化。本轮对早期入口留下的自建匿名 Redis 卷单独核实归属并清理；最终入口已使用 owned 容器 inspect + `rm -fv` + 卷不存在检查。清理后原有 6 个容器、10 个镜像、168 个卷均与初始集合一致，4 个网络名称保留，仅上述 bridge 标识差异另行记录。原有容器、卷和其他网络不清理。

实际部署前必须完成：外层先保持新实例零权重；核对两个本地已采用版本；选定无副作用探测及与自身资源匹配的窗口；能按实例读取故障、队列、延迟、审计增量；任何退化暂停升档；准备退出时先撤新流量和管理写流量，再调用 drain/轮询本地终态、发送 SIGTERM，设置独立强杀期限并归档最后诊断。已建立连接的新请求也要经过本实例准入门禁。不得只把 readiness UP 当成全量权重开关。

升级不涉及 Redis 格式迁移；新增的两个启动预算必须与 Spring phase 匹配。老包不认识新的生命周期控制接口，混合部署期间不能假定每个实例都具备该操作。回退代码后也需恢复对应的外层摘流/停机流程，不能只保留新接口调用。现有开发实例保持原版本，本轮停在验收。
