代理可靠性独立验收 · 2026-10-03

结论：本轮暂未通过，存在两项 P2。基础测试和原有真实故障矩阵均通过，但新增的真实 TCP 重置与协议名大小写补验失败。应修复这两项后补验，再推进下一阶段。

本轮只审查实现、运行隔离验证并保存证据，没有修改产品代码或升级现有开发实例。

**P2：真实上游 TCP 重置被误归为内部错误，且不计入熔断失败**

位置：[ProxyFailure.java](D:/Java/ZenithGateway/backend/src/main/java/com/zch/proxy/ProxyFailure.java:29)。分类器识别 PrematureCloseException，但此次真实连接重置抛出 java.net.SocketException: Connection reset，最终落入 proxy_internal_error / 500 / breakerFailure=false。[ProxyBreakers.java](D:/Java/ZenithGateway/backend/src/main/java/com/zch/proxy/ProxyBreakers.java:26) 因而忽略该异常。

复现使用独立 Node 上游，在接收 POST 请求后调用 socket.resetAndDestroy()。它发送 TCP RST，区别于原矩阵中普通 socket.destroy() 覆盖的关闭路径。

- 响应头发出前重置：实际返回 500、reason=proxy_internal_error；预期为上游断连 502，并计入上游失败。
- 客户端已收到 prefix-before-reset 后再重置：响应保持原 200 并中断，没有追加 JSON，这部分正确；但原因仍为 proxy_internal_error，熔断失败数为 0。
- 新断路器窗口 4、最少样本 4、失败阈值 50%；一次成功预热后连续三次真实重置，仍为 CLOSED、bufferedCalls=1、failedCalls=0。本应收录三次失败并打开熔断。

修复应在明确上游传输来源的边界识别真实重置及其异常链，覆盖响应头前和响应体阶段；不要将所有 IOException 无条件算成上游失败，以免把客户端取消或本地资源问题纳入。补验需同时保留已提交响应只中断、不追加 JSON，以及客户端取消和连接池拒绝不误计熔断失败的规则。

证据：[断言结果](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/tcp-reset-confirmed/report.json) · [网关日志](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/tcp-reset-confirmed/gateway.log) · [独立复现入口](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/tcp-reset-repro.mjs)。同一脚本也验证正常 204、304 空响应，均为 completed / reason=none。

**P2：已接受的大写或混合大小写 HTTP 协议名绕过保护层**

位置：[ProxyResilienceFilter.java](D:/Java/ZenithGateway/backend/src/main/java/com/zch/proxy/ProxyResilienceFilter.java:30)。此处 Set.of("http", "https").contains(scheme) 按大小写区分，而[路由校验](D:/Java/ZenithGateway/backend/src/main/java/com/zch/route/RouteValidator.java:34) 按大小写无关方式接受 HTTP、HtTp，并保留原始 URI；实际转发仍然成功。因此有效路由会直接跳过整个新保护层。

- 通过真实管理接口创建 HTTP://127.0.0.1:端口，开启熔断；成功预热后连续三次上游 500，全部转发，reason=none，对应断路器未创建。
- 创建 HtTp://127.0.0.1:端口，上游每 30ms 输出数据，避免触发读取空闲超时。总预算设为 1600ms，响应在约 2317ms 时仍未结束，由测试客户端主动终止；endedWithoutClientAbort=false。
- 上述流式请求进行中 activeProxyRequests=0，最终还被记为 completed / reason=none，说明总预算、熔断和生命周期记录都被绕过。

修复应在保护层入口按大小写无关方式识别 HTTP/HTTPS，兼容已经保存的混合大小写 URI。不要小写化整个 URI，以免改变大小写敏感的路径。补验需覆盖小写、大写、混合大小写协议名的相同行为，确认总预算生效、上游失败触发熔断、取消不计成功。

证据：[断言结果](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/scheme-confirmed/report.json) · [网关日志](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/scheme-confirmed/gateway.log) · [独立复现入口](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/scheme-repro.mjs)。

**独立执行结果与范围**

| 检查 | 本轮独立结果 |
| --- | --- |
| 后端完整测试与打包 | 137 项通过，失败、错误、跳过均为 0 |
| 前端测试 | 87 项通过，失败、取消、跳过均为 0 |
| 前端类型检查与生产构建 | 通过；图表块约 502.99 kB 提示仍存在 |
| 原有真实故障入口 | 14 组、50 条入口请求记录通过 |
| 启动拒绝 | 2 项通过，均按预期拒绝启动 |
| 管理 SSE 独立于代理预算 | 4 帧，持续约 2452ms，超过测试代理预算 1600ms |
| TCP 重置专项 | 执行完成；3 项缺陷断言失败，204/304 两项通过 |
| 协议名大小写专项 | 执行完成；2 项缺陷断言失败 |

[后端日志](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/backend.log) · [前端测试](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/frontend-tests.log) · [类型检查日志](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/frontend-typecheck.log) · [前端构建日志](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/frontend-build.log) · [14 组真实故障结果](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/live/report.json) · [汇总 JSON](D:/Java/ZenithGateway/.dev/proxy-resilience-acceptance-aaacbdf3/acceptance-summary.json)。

本轮未重新执行交付所列的旧验收 124 项完整入口，也未重新执行浏览器交互回归；因此不把这两部分算作本轮独立通过。已查看交付截图并检查相关前端改动。本轮没有另行独立计量“代理新增配置查询为 0”。

两个正式缺陷复现脚本均以断言失败退出，退出码为 1，报告同时记录 executionCompleted=true、passed=false；这是产品行为未达预期，并非环境启动失败。早期 edges、scheme 目录属于探索性采样，其 passed 只代表采样执行完成；验收结论以 tcp-reset-confirmed 与 scheme-confirmed 的正式断言结果为准。

**复现与补验**

需先在修复后重新构建后端 JAR，使用项目已有 JDK、Node 和可用 Docker，从仓库根目录依次运行下面两个入口。每次创建独立输出目录，不覆盖本次证据；当前未修复版本两条命令均预期退出 1。

```powershell
Set-Location -LiteralPath 'D:\Java\ZenithGateway'
$env:JAVA_HOME = 'D:\Java\ZenithGateway\.dev\toolchains\jdk-21.0.12.1+1'
Remove-Item Env:PROXY_RESILIENCE_OUTPUT -ErrorAction SilentlyContinue
& 'D:\Java\ZenithGateway\.dev\toolchains\node-v24.21.0-win-x64\node.exe' 'D:\Java\ZenithGateway\.dev\proxy-resilience-acceptance-aaacbdf3\tcp-reset-repro.mjs'
& 'D:\Java\ZenithGateway\.dev\toolchains\node-v24.21.0-win-x64\node.exe' 'D:\Java\ZenithGateway\.dev\proxy-resilience-acceptance-aaacbdf3\scheme-repro.mjs'
```

修复后应把这两类真实故障纳入正式验证入口，并复跑受影响的取消、已提交响应、熔断样本与原 14 组故障矩阵。全部通过后再提交补验；本报告没有替代修复实现。

**产物身份与清理**

实际测试 JAR SHA-256：f61482cc2356fda01ad057a20decba153970704bf79c83fdaf2ea6800358fd05，与交付记录一致；交付设计文档、真实故障入口、回归入口的散列也匹配。

后端测试和全部独立网关、上游、Redis 均使用自建资源；相关报告记录网关退出 0、上游关闭、Redis 容器移除。结束后按本轮容器名称和进程标识核查，剩余自建容器与进程均为空。原有工作区改动、历史证据及开发实例保留。
