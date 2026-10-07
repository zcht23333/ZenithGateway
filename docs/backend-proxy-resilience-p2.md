# 代理链路 P2 修复与补验

日期：2026-10-03。本次仅修复 [独立验收报告](backend-proxy-resilience-acceptance-2026-10-03.md) 的两项 P2，并补充真实故障回归；不进入下一轮。既有 [行为协议](backend-proxy-resilience.md)、[原交付证据](backend-proxy-resilience-validation.json) 与验收记录保持原样。本次结果另存 [P2 验证 JSON](backend-proxy-resilience-p2-validation.json)。

## 1. 修复前后实际行为

先保留当前源文件和 JAR，再原样运行验收方的两个独立脚本。旧 JAR 的两个脚本均退出 1，复现报告所述缺陷；修复后的同一 JAR 两个脚本均退出 0，没有修改原复现脚本。

| 真实触发 | 修复前 | 修复后 |
| --- | --- | --- |
| 上游读完 POST 后主动 TCP RST | 500 / proxy_internal_error，熔断忽略 | 502 / upstream_disconnect，计失败；正式矩阵实测 5.82ms，上游接收 1 次 |
| 客户端确认收到前缀后，上游 TCP RST | 原 200 中断，但记录内部错误、失败数不增加 | 保留 200，仅中断原响应，正文恰为 prefix-before-reset；reason=upstream_disconnect，outcome=error，失败数增加 1 |
| 1 次正常预热后 3 次 RST，窗口/最小调用均为 4 | CLOSED，buffered=1，failed=0 | OPEN，buffered=4，failed=3；后续新请求 503，上游接收 0 次 |
| 大写 HTTP 路由连续上游 500 | 状态/正文转发，但 reason=none，未建立断路器 | 保留业务 500 和正文，reason=upstream_5xx，达到阈值打开熔断 |
| 混合大小写 HtTp 持续输出 | 1600ms 总预算被绕过；约 2320ms 由测试客户端终止 | 自动按总预算结束；原复现脚本实测 1609.11ms，outcome=error，无需客户端终止 |

修复前证据：[TCP RST](../.dev/proxy-resilience-p2/baseline-rst/report.json)、[协议名](../.dev/proxy-resilience-p2/baseline-scheme/report.json)。原脚本补验：[TCP RST](../.dev/proxy-resilience-p2/fixed-rst/report.json)、[协议名](../.dev/proxy-resilience-p2/fixed-scheme/report.json)。这些目录均为本轮新建，没有覆盖验收方原始记录。

## 2. 错误来源必须明确

新建 [UpstreamTransportErrors](../backend/src/main/java/com/zch/proxy/UpstreamTransportErrors.java)，只安装在网关自有 HTTP 客户端的**上游物理通道**。在 Reactor Netty 把通道错误交给响应流之前，将 SocketException 或 Netty NativeIoException 标为 UpstreamDisconnect，并保留原 cause。全局失败分类只认这个标记和原有明确的异常类型，不将任意 IOException 当成上游故障，也不依赖英文错误消息匹配。

已有 ConnectException、TCP/TLS/读取超时、SSL 错误等保留原分类。普通本地 IOException、连接池拒绝/等待超时、客户端取消不因此变成熔断失败。尤其是：**同样的裸 SocketException 出现在整个过滤器链的其他位置，不足以证明来自上游。** 单元测试明确验证这个差异。

注册点为 HttpClient.doOnChannelInit，在 NettyPipeline.ReactiveBridge 前添加无状态处理器。依据锁定版本 [Reactor Netty 1.3.7 TransportConfig](https://raw.githubusercontent.com/reactor/reactor-netty/v1.3.7/reactor-netty-core/src/main/java/reactor/netty/transport/TransportConfig.java)，ReactiveBridge 在初始化回调之前安装。处理器每个物理通道安装一次，随连接池复用保留，随通道关闭释放；不携带请求状态、不创建队列或后台任务。使用直接 pipeline 注册，避免请求结束时自动移除连接级处理器。

没有改写最终响应处理：未提交时生成 502；已提交时继续传播原错误并关闭响应，不改成新的状态码、不追加错误 JSON。完成统计仍由原 recorder 负责一次性记账，断路器仍包住完整响应生命周期。真实下游主动 TCP RST 与普通主动关闭均已分别覆盖，未增加成功/失败样本。

## 3. 协议名一致处理，路径不改写

[ProxyResilienceFilter](../backend/src/main/java/com/zch/proxy/ProxyResilienceFilter.java) 使用 http/https 的 equalsIgnoreCase 判断，与 RouteValidator 和锁定版 Gateway NettyRoutingFilter 的路由范围一致。仅比较 scheme，不 lower-case 整个 URI，也不重新保存 Redis 路由，因此已有混合大小写路由直接生效。

正式脚本逐个验证 http、HTTP、HtTp、https、HTTPS、HtTpS：

- Redis 中保存的原始 URI（包含 /MiXeD/Target）保持原样；真实重写后的 CaseSensitive-* 请求路径保持大小写。
- 熔断关闭时，持续有正文也会触发完整处理预算；在途 activeProxyRequests 正确为 1。
- 熔断开启时，取消不计成功或失败；连续业务 500 打开熔断，打开后请求不触达上游。
- 关闭第一个测试网关，再从同一独立 Redis 启动新进程；不重新创建或刷新路由。六种持久化 URI 仍保留原值，均受总预算保护。

HTTPS 使用仅供该测试进程信任的临时自签证书，保留主机名校验。私钥容器文件在脚本结束时删除，未改变产品信任策略。URI 的 base path 不是本轮新增的转发语义；测试分别检查原始存储值与实际重写后的请求路径，不声称会把该 base path 拼接到代理请求。

## 4. 验证与证据

| 检查 | 本轮结果 |
| --- | --- |
| 完整后端 verify，包含独立真实 Redis 联调 | 158 项通过，失败/错误/跳过均为 0；较验收基线新增 21 项 |
| 前端测试及生产构建 | 87 项通过；类型检查和构建成功；没有修改前端源码 |
| 验收方原始复现脚本 | 2 个脚本均通过；空 204/304 保持 completed / none |
| 正式代理故障矩阵 | 24 组、102 个入口请求；涵盖原 14 组场景、两项 P2 和存量路由重启 |
| 非法启动配置 | 2 项按预期拒绝启动：非法总预算、意外 Retry 过滤器 |
| 六种 HTTP/HTTPS 变体及重启 | 全部通过；总预算实测 1602.82–1626.65ms（测试配置 1600ms） |
| 错误分类原有边界 | 响应头等待 508.08–512.17ms；读取停顿 706.22–710.48ms；TLS 握手停顿 167.53ms，均按原语义结束 |
| 下游取消、下游 RST、连接池耗尽与排队超时 | 每次最终统计仅 1 次，熔断成功/失败样本保持不变 |
| 旧配置与浏览器验收回归 | 11 个具体入口、124 项检查全部通过，包含同步/回执/安全回滚、两轮草稿 P2、路由预览 14 项与真实管理 12 项 |
| 本地监控 SSE | 4 帧，持续约 2566ms，超过 1600ms 代理预算；代理完成统计增量 0 |

逐请求记录、断路器读数、完成计数和清理结果：[正式 report.json](../.dev/proxy-resilience-p2/live/report.json)；[上游记录](../.dev/proxy-resilience-p2/live/upstream.json)；[网关日志](../.dev/proxy-resilience-p2/live/gateway.log)；[重启日志](../.dev/proxy-resilience-p2/live/gateway-restarted.log)。每组在有上限的等待内观察到活动代理请求、占用连接和排队数均为 0；这不是对生产环境释放延迟的硬实时承诺。

[后端日志](../.dev/proxy-resilience-p2/backend.log)、[前端测试](../.dev/proxy-resilience-p2/frontend-tests.log)、[构建日志](../.dev/proxy-resilience-p2/frontend-build.log)。既有图表包约 502.99kB 的构建提示仍保留，没有为修复后端 P2 扩大前端范围。

旧验收本轮已重新执行：[总索引](../.dev/proxy-resilience/regression-67b66102/report.json)、[配置回归索引](../.dev/config-rollback/regression-710f756d/report.json)。浏览器路由预览与真实管理流程的页面错误均为 0；在阻塞后台配置读取的明确窗口中，20 个代理请求与 10 次本地诊断的新增配置查询仍为 0，见 [同步证据 hotPath](../.dev/config-rollback/regression-710f756d/sync/report.json)。配置操作的网络故障证据来自真实隔离网关/Redis；部分页面生命周期回归仍使用明确标注的 HTTP 夹具，未将其当作真实 Redis 证明。

本轮自建网关均正常退出，独立 Redis、上游服务和浏览器预览已清理。对比开始时归档，已有 52 份文档/JSON 均未改变；原验收截图与日志不覆盖。实际修改仅涉及代理错误标记与分类、协议名判断、对应测试和验证入口，新增本补验说明与索引。

## 5. 重复执行

在仓库根目录，使用现有 JDK 21 / Node 24、Docker 和已锁定 Redis 镜像：

```powershell
. ./.dev/upgrade-tools/env.ps1
# 如需完整后端联调，ZENITH_TEST_REDIS_PORT 必须覆盖为本次自建 Redis 的随机端口。
# env.ps1 中的 16379 不是本脚本创建的环境，不直接复用它跑联调。
& $maven -f backend/pom.xml -DskipTests package
Remove-Item Env:PROXY_RESILIENCE_OUTPUT -ErrorAction SilentlyContinue
node verification/proxy-resilience-live.mjs
```

入口仍为 [verification/proxy-resilience-live.mjs](../verification/proxy-resilience-live.mjs)。每次默认生成新的 UUID 证据目录，创建随机端口和专属 Redis/键、受控 HTTP/HTTPS 上游、临时 TLS 身份、独立网关进程；读取实际响应字节后才触发正文 RST，确认请求到达后才取消，按诊断条件等待恢复。未使用任意 sleep 碰撞故障窗口。测试用 150/500/700/1600ms 预算，生产默认值未改动。

原始复现脚本保持不变，仍可按验收报告分别运行。补跑完整旧验收与浏览器路由回归可在前端构建后执行 node verification/proxy-resilience-regression.mjs，它也创建独立实例和新的证据目录。

## 6. 兼容性与剩余边界

没有修改六字段配置、版本/operationId/回执/回滚协议、Redis 存储格式、启动参数或前端交互；不需要数据迁移。部署新 JAR 后，存量大小写混合路由立即进入原定保护策略。现有开发实例保持未升级。回退旧 JAR 会重新带回这两项已确认缺陷，不作为修复方式。

真实网络故障运行于本机 Windows/JDK 21 的 NIO 传输。NativeIoException 已按类型纳入上游边界，但本轮没有声称实测 Linux epoll/macOS kqueue 或所有 TLS 关闭变体。普通 IOException 继续保留内部错误语义，以避免没有来源依据的过度归因。

代理自动重试继续关闭；本轮的 RST 写请求实际只到达上游 1 次，但不能证明其业务副作用未发生，网关取消也不能撤销上游执行。HTTP/2、WebSocket、gRPC、流式请求专用预算、分布式熔断状态等仍在原范围之外。本次完成后停在验收。
