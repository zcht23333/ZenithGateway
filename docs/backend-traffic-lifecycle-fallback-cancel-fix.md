# 安全退出补修：超时回退期间取消的终态

2026-10-06。本轮相邻 P2 已修复并完成补验，等待独立验收。仅调整 `RequestCompletionRecorder` 的终态判断，扩展 `DrainTerminalRaceTest`；上一轮 `ReadinessFilter` 的超时仲裁修复保留，运行参数、接口、审计格式和停机预算不变。开发实例未升级。

## 修复行为与计数含义

原判断将 `shutdownForced=true` 当成排除所有取消的条件。超时已胜出、但回退尚未结束时，最外层真正收到 CANCEL 仍可能记录为 completed。

现在最外层 CANCEL 始终记录为 **cancelled**。只有内层 `client_cancelled` 原因会在已选中停机回退时被抑制：截止本身会取消业务源，不能因此把一个正常结束的 503 回退误记成客户端取消。超时归因继续使用 `shutdown_deadline`。

| 超时回退已选中之后 | 修复前 | 修复后 |
|---|---|---|
| 响应未提交，客户端在回退结束前取消 | 0 / completed | **0 / cancelled** |
| 已提交 200 和部分响应体，客户端取消 | 200 / completed | **200 / cancelled** |
| 未取消，未提交响应的回退正常结束 | 503 / http_error | 503 / http_error |
| 未取消，部分响应被截止中断 | 200 / error | 200 / error |

以上四种情况的原因均为 shutdown_deadline。状态 0 表示取消时没有已提交的 HTTP 状态，200/cancelled 表示响应曾开始但没有正常完成，不能按 200 判定成功。原有 `recorded` 与 lease 的原子一次性保护保持不变，审计和请求指标只记一次。

本地生命周期诊断的 `completed` 是已经终止的 lease 总数，包含错误与取消；不是 HTTP 成功数。`deadlineTerminated` 保留原因优先级：业务源已经由截止取消，随后外层再取消，仍归入该计数，不另加 `clientCancelled`。实际请求终态应查看请求指标和审计的 `outcome`。本轮没有把归因计数改成另一套终态计数，也没有改变指标标签或存储格式。

## 受控复现与回归

从新增复核目录复制 Java / PowerShell 复现入口到本轮独立证据目录，复制内容未改动；先保存原实现失败，再使用同一入口验证修复。未在复核方目录编译或覆盖文件。新复现四种输出均正确，上一轮“截止尚未赢得仲裁”的原复现四种输出也保持正确。

回归类由 6 项扩为 **8 项**，新增两项用真实 `ReadinessFilter`、`TrafficLifecycle`、完成记录器和审计发布器，响应传输采用 Spring mock。屏障只暂停已经选中的回退第一次查询提交状态，不伪造状态或终态；确认业务源已取消、shutdownForced 已设置，再由外层订阅发出取消。核对取消时的状态、cancelled 指标、shutdown_deadline 计数、唯一审计、lease 释放和审计确认；释放屏障后再核对，迟到回调不能改变已记录结果或重复计数。等待上限 3–5 秒，不靠 sleep 碰撞。

原有未取消回退的两项控制用例同时模拟内层取消原因，验证它不会把正常回退也改成 cancelled。已提交响应保留原 prefix，不追加错误 JSON。

新用例在旧实现上 **8 项中 2 项失败**，恰为两个取消时序；修复后 8 项全部通过。此为受控线程/信号测试，**不冒称真实 TCP 下精确撞中了该窗口**。真实网关回归另列。

新增测试编写中的两次失败输出也保留：第一次读取预注册计时器时漏选 status 标签，取得了零值序列；第二次对 mock 回退恢复后的内部提交状态作了过强假设。最终按取消发生时的提交状态、对应完整标签、已记录事件和已发送前缀核对；没有更改真实链路入口或放宽真实业务断言。见 `attempt-01-*`、`attempt-02-*`。

## 本轮实际验证

| 验证 | 结果 | 证据目录内入口 |
|---|---|---|
| 新验收复现副本 | 修复前失败，修复后四种输出正确 | `repro-before.log`、`repro-after.log` |
| 上一轮原仲裁复现副本 | 四种输出正确 | `original-race-after.log` |
| 就绪、生命周期、完成统计、审计相关回归 | **39 项通过** | `focused-after.log` |
| 后端完整 Maven verify，启用独立真实 Redis 集成测试 | **252 项，零失败、错误、跳过；生产构建通过** | `backend-verify.log`、`surefire/` |
| 真实网关功能检查 | **4 组通过** | `functional/report.json` |
| 直接 SIGTERM | **1 组通过** | `signal/report.json` |

39 项及 8 项均包含在 252 项内，不叠加计算。构建后冻结一个包，两个真实入口使用同一包；JAR 内记录器字节码与全量测试所用 class 哈希一致。

实际网关、Redis、受控上游均使用本轮自建容器、随机端口、独立命名空间和测试凭据。故障按受控条件触发，保持已有预算与健康标准：

- DRAIN 实例在 250 次准备请求后，对 5 个业务终态取得 5 条唯一审计：2 次正常完成、1 次客户端取消、2 次 deadline。未提交响应截止为 503/http_error，部分响应截止为 200/error；已有 keep-alive 上的新请求被拒绝且没有到上游。全部 255 条审计确认，pending/unknown/drop 为 0。
- Redis 故障时严格策略 75 次保护性 503、上游 0；默认策略 75 次故障放行、上游 75。两者都停止提升。恢复后 25 和 100 req/s 的各 10 秒观察窗口重新通过；这不是容量定标。
- 审计丢回复并离线排空：received=1610、persisted=1575、uncertain=8、shutdown dropped=27、pending=0。恢复后的真实 Redis 记录 1583 条，证明这 8 条 unknown 已执行，不能把未知等同于丢失。约 1.066 秒观察到排空结束。
- 不提前调用 drain，直接 SIGTERM：新业务被拒绝，慢请求 503，已提交的流只中断、不追加 JSON；2 条唯一审计。SIGNAL 实例从发出 TERM 到观察进程退出约 **4.696 秒**，退出码 143、非 OOM；停机顺序、限流/同步资源释放和最后 Redis 客户端列表检查通过。

功能入口另外保留 2150 条观察窗口请求和 42 条单独流程请求，SIGTERM 入口保留 3 条单独请求；这些是本轮原始记录量，不作为并发容量结论。

未重跑：前端测试与构建、浏览器、18 项发生器/工具单测、独立代理/限流/配置/路由的完整 live 矩阵、冷启动重复对照、容量长测及 RSS 专项。前端和验证工具没有修改；相关 Java 回归随完整 verify 执行。本轮没有把以前的专项通过记录当作此次实跑。

## 复现、产物与清理

证据根目录：`../.dev/traffic-lifecycle-fallback-cancel-20261006-f602c928/`。
机器入口：[validation.json](../.dev/traffic-lifecycle-fallback-cancel-20261006-f602c928/validation.json)；精确代码差异 `fix.patch`，原始文件哈希 `artifact-index.json`。原样复现脚本也在该目录内，可在 Maven 编译测试后直接运行。

新 JAR SHA-256：`fbe42aac9cf1ede1c4ee5e9dd4223771d4f1329e6358ba070bd51ee39db16391`。
修复前 JAR SHA-256：`f196b3423d272b23a335ec05730de9cd62434bfafb764034bb327ab0c5c959c4`。两者均保留，旧文档和复核结果没有覆盖。

配置 JDK 21 / Maven 3.9 后，在项目根目录重复针对性测试：

```powershell
mvn -B -f backend/pom.xml "-Dtest=DrainTerminalRaceTest,TrafficLifecycleTest,ReadinessFilterTest,RequestCompletionRecorderTest,AuditEventPublisherTest" test
```

真实入口沿用[运行流程说明](backend-traffic-lifecycle.md)的固定镜像准备步骤，Node 24、Docker Linux 容器可用，使用全新输出目录：

```powershell
node verification/traffic-lifecycle-live.mjs --mode functional --jar backend/target/zg-1.0.0.jar --out .dev/fallback-review-functional-unique
node verification/traffic-lifecycle-live.mjs --mode signal --jar backend/target/zg-1.0.0.jar --out .dev/fallback-review-signal-unique
```

本轮自建容器、网络、匿名卷、凭据和匹配证据路径的原生进程均已清理。原有 6 个容器、10 个镜像、168 个卷集合保持一致；本次纳入保护检查的上一轮交付和新增复核共 **187 个文件**哈希一致，包含此前的 144 份交付证据。默认 bridge 标识由 `dec984d4ef72` 变为 `4930f6519c9e`，原因尚未归因，完整前后快照保留在 `baseline.json` 和 `cleanup.json`；其他网络标识不变，未尝试修改回默认网络。

无需 Redis 数据迁移或前端协议升级。现有开发实例保持原版本，部署升级另行执行。**4000 req/s 一小时未通过、尚无经过一小时验证的健康容量档位**的结论保持不变；本次功能补验不扩展容量或部署保证。完成后停在验收。
