代理可靠性 P2 独立复核 · 2026-10-03

结论：本轮通过。上次两项 P2 均已关闭；在本次审查与 Windows/NIO 独立验证范围内，未发现新的阻塞问题。

本轮独立执行了完整后端、前端测试与构建，上次两份原始复现脚本，以及更新后的真实故障矩阵。产品代码没有修改，现有开发实例没有升级；本报告和测试证据使用新路径，原验收记录保留。

**真实 TCP 重置：已关闭**

审查确认，[UpstreamTransportErrors.java](D:/Java/ZenithGateway/backend/src/main/java/com/zch/proxy/UpstreamTransportErrors.java:9) 仅安装在自有 HTTP 客户端的上游物理通道，在此处标记 SocketException / NativeIoException，并保留异常原因。[ProxyFailure.java](D:/Java/ZenithGateway/backend/src/main/java/com/zch/proxy/ProxyFailure.java:33) 识别该标记；过滤器链其他位置的裸 SocketException、普通 IOException 不被无依据地归为上游断连。连接、TLS 和超时原有分类保持不变。

- 响应前真实 RST：实际返回 502 / upstream_disconnect，入口 POST 只到达上游一次。
- 客户端已收到前缀后 RST：保留原 200，正文恰为 prefix-before-reset，响应中断，没有追加 JSON；outcome=error，熔断失败数增加 1。
- 一次成功预热后连续三次 RST：bufferedCalls=4、failedCalls=3，断路器进入 OPEN；正式矩阵确认后续请求返回 503，上游收到 0 次。
- 普通客户端取消及下游主动 RST，在响应前、响应后均未增加熔断成功或失败样本；连接池拒绝、排队超时同样不增加这些样本。

证据：[原始复现结果](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/rst/report.json) · [对应网关日志](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/rst/gateway.log) · [完整故障矩阵](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/live/report.json)。正常 204、304 和 HEAD 也通过，没有被误判为取消。

**协议名大小写：已关闭**

[ProxyResilienceFilter.java](D:/Java/ZenithGateway/backend/src/main/java/com/zch/proxy/ProxyResilienceFilter.java:30) 仅对 scheme 做 equalsIgnoreCase 比较，不修改完整 URI 或路径。

- 原始 HTTP / HtTp 复现通过：上游业务 500 记为 upstream_5xx 并触发熔断；连续输出响应在约 1623.38ms 被 1600ms 总预算结束，无需测试客户端主动终止。
- 正式矩阵逐一验证 http、HTTP、HtTp、https、HTTPS、HtTpS：持续输出受到总预算保护；活动请求正确计数；取消不记成功；熔断打开后请求不再到达上游。
- 保存的 /MiXeD/Target URI 原值保持不变，真实转发的 CaseSensitive-* 请求路径保持大小写。
- 同一独立 Redis 下重启网关，未重新写入或刷新路由；六种存量路由均恢复并受到保护。重启前后共 12 次协议变体总预算观测为 1603.30–1621.01ms，配置值 1600ms。

证据：[原始复现结果](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/scheme/report.json) · [六种变体及重启结果](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/live/report.json) · [重启网关日志](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/live/gateway-restarted.log)。

**独立验证结果**

| 检查 | 本次结果 |
| --- | --- |
| 后端完整 verify 与打包 | 158 项通过，失败、错误、跳过均为 0；使用专属 Redis 随机端口 |
| 前端测试 | 87 项通过，失败、取消、跳过均为 0 |
| 前端类型检查及生产构建 | 通过；原有图表块约 502.99 kB 提示保留 |
| 两份原始缺陷复现脚本 | 原样执行，均退出 0，observedIssues 均为空 |
| 更新后的真实故障矩阵 | 24 组、102 个入口请求记录通过 |
| 启动拒绝 | 非法总预算、意外 Retry 过滤器均按预期拒绝 |
| 管理 SSE | 4 帧，约 2628ms，超过 1600ms 代理预算；未计入代理完成统计 |
| 存量路由重启 | 六种 HTTP/HTTPS 协议写法通过，重启后路由写入数为 0 |

[后端测试日志](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/backend.log) · [前端测试日志](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/frontend-tests.log) · [类型检查日志](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/frontend-typecheck.log) · [前端构建日志](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/frontend-build.log) · [执行退出码](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/live-runs.json) · [机器可读汇总](D:/Java/ZenithGateway/.dev/proxy-resilience-p2-acceptance-1a101a6bb0d/acceptance-summary.json)。

**证据身份与复核边界**

测试 JAR SHA-256 为 13237d9543e92c3cc1f16372e30162ecb1935a417d875e713d21a7b82301c0d8，与本次交付一致。修改文件与验证入口的散列匹配交付索引；对照修复前归档，已有 52 份文档/JSON 均未变化。

旧验收 124 项、11 个入口及代理新增配置查询为 0 的结果，本次核对了交付记录与相应产物身份；交付索引的 24 份产物散列全部匹配。本次没有重新执行这 124 项、浏览器交互回归或额外的配置查询计量，不将其列为独立复跑结果。

真实 RST 本次仍在 Windows/JDK 21 NIO 环境验证。Linux 原生传输、其他 TLS 关闭变体及 HTTP/2、WebSocket、gRPC 不在本次实测范围内。该边界已明确记录，不影响本轮两项 P2 在既定范围内关闭。

**清理与交付状态**

后端测试专属 Redis 及两份复现、正式矩阵的独立网关和上游均已退出，相关 Redis 容器已移除；正式矩阵的临时 TLS 私钥文件已删除。按本轮专属容器名称及进程标识再次核查，剩余容器、进程均为空，详见汇总 JSON 的 cleanup。

修复验收已完成。部署与后续功能开发可单独推进，本次未执行开发实例升级。
