# 冷启动与安全退出：终态竞争 P2 修复

2026-10-06。修复及补验已完成，待独立验收。本轮只修改业务过滤器的停机超时标志设置时机，新增针对性回归；既有失败策略、预算和运行协议保持原样，开发实例未升级。

## 问题与修复

原 `ReadinessFilter` 在截止通知的 `doOnSuccess` 中设置 `shutdownForced=true`。通知执行到这里时，Reactor 还没有决定超时是否胜过源的完成、错误或取消。先完成的正常请求因此可能被归为 shutdown_deadline；先取消的请求可能被归为 completed，并错误增加强制终止计数。

现在截止 publisher 只负责通知，按订阅通过 `Mono.defer(lifecycle::deadline)` 取得。标志只在 `timeout` 选中并订阅 **fallback 的 Mono.defer** 时设置；响应未提交仍返回原有 503，已经提交仍中断原响应，不追加错误 JSON。没有改动 `RequestCompletionRecorder`、审计协议或计数规则来掩盖问题。

核查了项目实际使用的 **reactor-core 3.8.7** 字节码：`TimeoutMainSubscriber.doTimeout` 先做版本/index 比较和 CAS，只有成功后才调用 `handleTimeout`、取消原订阅并订阅 fallback。正常完成或取消先结束时，迟到的截止通知不会进入这一回退分支。依据保存在 `reactor-timeout-bytecode.txt`，修复差异在 `fix.patch`。

## 可控制的复现与回归

在新证据目录复制验收方的 Java 和 PowerShell 复现入口，**未改动复制内容**。修复前先执行并保存失败，修复后再次执行同一入口，四个结果（两种顺序 × 完成/取消）全部正确。原独立复核目录全部文件哈希再次核对一致。

| 截止信号已到达、但尚未完成仲裁时的胜出者 | 修复前 | 修复后 |
|---|---|---|
| 正常完成 200 | reason=shutdown_deadline，强制终止=1 | reason=none，completed，强制终止=0 |
| 客户端取消 | outcome=completed，取消=0，强制终止=1 | outcome=cancelled，reason=client_cancelled，取消=1，强制终止=0 |

新增 `DrainTerminalRaceTest` 共 **6 个用例**：

- 截止信号在仲裁前由屏障暂停，让正常完成、未提交响应的取消、已提交响应的取消或错误先胜出。分别核对实际终态、监控、审计、lease 计数；释放迟到信号后再核对一次，不能改写结果或重复记录。
- 超时先胜出的未提交/已提交两种响应：分别验证 503/http_error 与原 200/error，转发被取消、强制终止只加一次；原响应体不追加 JSON，迟到业务完成不会产生第二条记录。

测试使用 CountDownLatch 控制明确的信号边界，不靠 sleep 碰撞。测试类隔离执行，仅在一次订阅期间安装 Reactor hook，并在 finally 释放屏障、撤销 hook。该接缝针对固定的 Reactor 3.8.7；依赖升级改变内部订阅者时，屏障等待会明确失败，不能静默跳过。

新用例在旧实现上 **6 项中 4 项失败、2 项通过**；修复后 **6 项全部通过**。既有真正超时行为同时受到正向验证。

## 本轮亲自执行的检查

| 检查 | 结果 | 原始证据 |
|---|---|---|
| 验收方原复现入口的副本 | 旧版复现失败；修复后四种输出正确 | `race-before.log` / `race-after.log` |
| 新屏障回归 | 旧版 4 失败；新版 6 通过 | `new-tests-before.log/xml`、Surefire XML |
| 生命周期、就绪、审计及完成统计针对性回归 | 37 项通过 | `focused-after.log` |
| 后端完整 verify，含独立 Redis 集成测试 | 250 项，0 失败/错误/跳过；生产构建通过 | `backend-verify.log`、`surefire/` |
| 真实网关功能补验 | 4 组通过 | `functional/report.json` |
| 直接 SIGTERM 补验 | 1 组通过 | `signal/report.json` |

37 项针对性测试和 6 项新增测试均包含在 250 项总数内，不能相加作为总测试数。18 项工具测试、前端/浏览器、全套代理与限流专项、冷启动三轮对照、容量长测本轮未重复执行；仅核查已有记录。本次生产变更仅涉及退出仲裁，真实生命周期流程针对这一修改补验。

真实功能检查使用独立 Redis、随机端口、随机管理凭据、受控上游和独立网关进程；没有以单元夹具代替真实链路：

- DRAIN 实例：250 个准备请求以外，5 个业务终态对应 5 条唯一审计，其中主动取消 1、真正 deadline 2；新 keep-alive 请求拒绝 1，不到上游。所有 255 条审计确认，pending/unknown/drop 均为 0。
- Redis 故障：严格策略 75 个保护性 503、上游 0；默认策略 75 个故障放行、上游 75；均停止提升，恢复后重新评估。
- 离线审计排空：累计 received=1610、persisted=1575、uncertain=8、shutdown dropped=27、pending=0。unknown 与未发送丢弃分开结算；恢复后真实 Redis 记录交叉验证。
- 不提前调用 drain 的 SIGTERM：慢请求及部分响应按既有预算结束，新请求被拒绝，审计完成后才关闭 Netty；SIGNAL 进程观察到约 4.721 秒退出，143 为正常 TERM 退出码。所有停机流程检查了终态唯一性和资源释放。

## 产物、复现入口与保留情况

新 JAR SHA-256：`f196b3423d272b23a335ec05730de9cd62434bfafb764034bb327ab0c5c959c4`。

旧 JAR `c81145b3a5dbdc7e55a5320e94424b0948b236297239c3ee6b6d0f2caa2485a0` 和修复前源文件另存；旧验收、原冷启动/容量证据及其 JSON **没有覆盖**。旧包的冷启动对照没有移用成新包的性能证明，4000 req/s 一小时未通过、尚无健康一小时容量档位的结论不变。

证据目录：`../.dev/traffic-lifecycle-p2-20261006-9b6b79a2/`。机器入口：[validation.json](../.dev/traffic-lifecycle-p2-20261006-9b6b79a2/validation.json)。包含产物哈希、修复前后原始输出、测试 XML、真实请求/审计、清理及原文件保留检查。

在 JDK 21 / Maven 3.9 环境下，从项目根目录重复确定性回归，无需 Redis：

```powershell
mvn -B -f backend/pom.xml "-Dtest=DrainTerminalRaceTest,TrafficLifecycleTest,ReadinessFilterTest,RequestCompletionRecorderTest,AuditEventPublisherTest" test
```

实际流程沿用原入口及固定镜像准备步骤，使用全新输出目录：

```powershell
node verification/traffic-lifecycle-live.mjs --mode functional --jar backend/target/zg-1.0.0.jar --out .dev/traffic-p2-review-functional-unique
node verification/traffic-lifecycle-live.mjs --mode signal --jar backend/target/zg-1.0.0.jar --out .dev/traffic-p2-review-signal-unique
```

本轮自建容器、网络、匿名卷、测试凭据及匹配证据路径的原生进程已清理。原有 6 个容器、10 个镜像、168 个卷与初始集合一致；其他网络标识一致。默认 bridge 从 `586e5d2ff8a6` 变为 `9dec8e92b997`，原因仍未归因，前后快照保留，不宣称环境完全没有变化，也未尝试改回它。

本轮停在验收。未验证的容量与部署边界继续以原说明为准，不扩大结论。
