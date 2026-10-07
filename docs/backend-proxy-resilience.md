# 代理链路的超时、失败分类与熔断恢复

日期：2026-10-03。范围：经动态路由管理的普通 HTTP/HTTPS 请求。六字段运行配置、版本、回执、历史与安全回滚协议不变；现有开发实例未升级。

## 1. 先核实生效参数

实际生产 JAR：Spring Boot 4.1.1、Spring Cloud 2025.1.3、Gateway WebFlux 5.0.3、Spring Cloud CircuitBreaker Resilience4j 5.0.3、Resilience4j 2.3.0、Reactor Netty 1.3.7 / Reactor Core 3.8.7。

旧配置将 TimeLimiter 的 2 秒和断路器的窗口 20 / 最小调用 10 / 开启 10 秒写在 `instances.default`。路由却默认生成 `cb-<路由ID>`。**名为 default 的实例不等于所有实例的默认配置。**

| 依据层次 | 结论 |
| --- | --- |
| 源码核实 | `ReactiveResilience4JCircuitBreakerFactory.create(id, group)` 与 `ReactiveResilience4JCircuitBreaker.buildCircuitBreakerAndTimeLimiter()` 按实例/组/注册表默认配置解析；普通名称未命中实例 default。普通名称采用库默认 TimeLimiter 1 秒，断路器计数窗口 100、最少 100、失败率 50%、开启 60 秒、半开 10 次 |
| 旧 JAR 实测 | 无响应头的同一上游：自动名称 1021.11ms 返回 503；显式 default 2010.94ms 返回 503；禁用熔断时在测试客户端 3208.63ms 主动终止前无响应。不把这个有限观察写成“永不超时” |
| 已有测试盲区 | 原慢请求联调显式指定 default，覆盖到 2 秒实例，却没有证明普通生成名称使用 2 秒；旧断路器包在响应体写出过滤器内部，不能证明保护完整响应 |
| 本轮实际修正 | 所有动态路由使用同一套经过校验的启动策略，名称只决定本实例断路器状态共享关系；超时和断路器开关解耦 |

旧实测保存在 `../.dev/proxy-resilience/baseline-report.json`、`baseline-gateway.log`，旧 JAR 为 `before.jar`，开始时源码快照为 `before.zip`。没有覆盖旧验收记录。

已核对 Maven Central 对应版本的源码包，解压位置为 `../.dev/proxy-resilience/sources/`：

- Gateway：`NettyRoutingFilter`、`NettyWriteResponseFilter`、`SpringCloudCircuitBreakerFilterFactory`、`HttpClientFactory`、`HttpClientSslConfigurer`。
- Spring Cloud CircuitBreaker：`ReactiveResilience4JCircuitBreakerFactory`、`ReactiveResilience4JCircuitBreaker`。
- Reactor Netty：`HttpClient`、`HttpClientConnect`、`HttpClientOperations`。
- Resilience4j：`CircuitBreakerConfig`、`CircuitBreakerSubscriber`、`CircuitBreakerStateMachine`。

官方概念参考：[配置优先级](https://docs.spring.io/spring-cloud-circuitbreaker/reference/spring-cloud-circuitbreaker-resilience4j/specific-circuit-breaker-configuration.html)、[Gateway HTTP 超时](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/http-timeouts-configuration.html)、[Reactor Netty HTTP 客户端](https://projectreactor.io/docs/netty/release/reference/http-client.html)。具体行为以以上锁定版本源码与本轮请求证据为准，不将滚动文档当成锁定版本保证。

## 2. 超时协议与启动参数

入口为 `zenith.proxy.resilience.*`，见 [application.yml](../backend/src/main/resources/application.yml) 与 [ProxyPolicy](../backend/src/main/java/com/zch/proxy/ProxyPolicy.java)。参数更改须重启；不进入运行配置 operationId/CAS 协议。

| 参数 | 默认 | 校验 / 含义 |
| --- | ---: | --- |
| connect-timeout-ms | 1000ms | 50–10000；每次 TCP 建连上限，也用于单次 DNS 查询与 TLS 握手 |
| headers-timeout-ms | 2000ms | connect ≤ headers ≤ 30000；等待可用响应头的绝对预算 |
| read-idle-timeout-ms | 3000ms | headers ≤ idle ≤ 60000；底层客户端读取停顿预算 |
| total-timeout-ms | 5000ms | idle < total ≤ 120000；本次代理处理总预算 |
| acquire-timeout-ms | 500ms | 50 ≤ acquire ≤ headers；连接池排队预算 |
| max-connections | 100 | 每个目标连接池 1–1000 条连接 |
| max-pending-acquires | 100 | 每个目标连接池 1–1000 个等待者；禁止无界队列 |
| sliding-window-size / minimum-calls | 20 / 10 | 2 ≤ minimum ≤ window ≤ 1000；按已完成调用计数 |
| failure-rate-threshold | 50% | 1–100；达到而非超过阈值即触发 |
| open-wait-ms | 10000ms | 100–300000；开启后等待探测的时间 |
| half-open-calls | 2 | 1–100；一次半开周期的调用许可数 |

默认值是普通短 HTTP 请求的起点：延续原先期望的 2 秒响应头等待，留 3 秒空闲读取和 5 秒完整处理预算；连接和排队应更快失败，避免把整个预算耗在排队上。它们不是所有上游的性能承诺，上线前应按上游延迟与客户端预算调整。

计时边界：

1. **连接池 / 建连 / TLS**：池等待独立限制；TCP 建连从连接尝试开始，DNS 是每次查询，不把多个地址解析的总时间声称为 1 秒。TLS 从握手开始。上述步骤还受响应头和总预算限制。
2. **响应头**：Gateway `NettyRoutingFilter` 订阅转发时开始；覆盖池等待、解析、建立连接、TLS、请求发送和等待响应头，收到响应头后结束。不是从上游接收请求时开始。
3. **读取停顿**：Reactor Netty `responseTimeout` 在请求发送完成后安装读取超时处理器；等待响应头及读取响应体时，两次读取间隔超过预算即失败。持续收到字节会延后它，因此它不能代替总预算。
4. **总处理预算**：限流通过后，在 `ProxyResilienceFilter` 订阅下游处理前开始，覆盖重写、转发及响应体写出。包括客户端上传/接收造成的停顿；不包含前面的管理认证与限流 Redis 等待。请求完成指标则从更外层入口开始，两者耗时起点不同。
5. 首个到期机制终止转发；没有把多个预算简单相加。响应头预算 ≤ 读取停顿预算，保证等待响应头时优先得到可解释的响应头超时。所有预算都依赖正常的调度，不是系统暂停下的硬实时保证。

**TLS 实际生效修复**：该版 Gateway 只有设置自定义证书/信任材料时才调用 `configureSslContext`，仅设置 handshakeTimeout 对默认 HTTPS 客户端不起作用。现在始终沿用该 SSL 构建器应用超时，保留默认信任链、hostname verification 和现有 SSL bundle 能力。真实 TCP 上游接受连接但不回复 TLS 握手的测试证明限制生效，并检查连接释放；没有开启不安全信任。

禁用断路器的路由仍有以上所有超时、错误分类、连接池限制。现有 `/monitor/stream` 为本地管理 SSE，不经过代理过滤器，实测持续时间超过代理总预算仍正常输出。

## 3. 过滤器和失败语义

处理顺序（负数在前）：外层 `RequestCompletionRecorder` → WebFilter 认证/readiness → Gateway `AuditLogFilter(-300)` → `RateLimitFilter(-200)` → **`ProxyResilienceFilter(-100)`** → `NettyWriteResponseFilter(-1)` → 路由 RewritePath → RouteToRequestUrl → NettyRouting。

响应沿相反方向完成。新保护层包住完整响应体，因此采用 Resilience4j 的 Reactor operator 直接保护整个转发 Mono；移除动态路由原来的原生 CircuitBreaker 过滤器，避免两层断路器/TimeLimiter 和内部 forward。路由页按“入口 → 限流 → 熔断准入 → 重写 → 目标”展示；准入节点同时说明它在响应完成时记账。

| 场景 | 响应尚未提交 | 响应已开始 | 固定 reason / 断路器计数 |
| --- | --- | --- | --- |
| 上游业务 2xx / 3xx / 4xx | 保留状态、响应体 | 保留 | none / 非失败 |
| 上游业务 5xx | 保留状态、响应体，不调用降级 | 保留 | upstream_5xx / 失败 |
| 连接被拒绝、解析失败 | 502 | — | upstream_connect_error / 失败 |
| 上游提前断开连接 | 502 | 终止原响应 | upstream_disconnect / 失败 |
| TCP / TLS / 响应头 / 读取停顿超时 | 504 | 终止原响应 | upstream_connect_timeout / upstream_tls_timeout / upstream_headers_timeout / upstream_read_idle；失败 |
| 总处理预算到期 | 504 | 终止原响应 | proxy_total_timeout / 失败 |
| TLS 协议或信任错误 | 502 | 终止原响应 | upstream_tls_error / 失败 |
| 断路器不允许准入 | 503，不创建上游请求 | — | circuit_open / 拒绝数，不是又一笔上游失败 |
| 本地池已满 / 排队超时 | 503 | — | proxy_pool_full / proxy_pool_timeout；忽略，不污染上游失败率 |
| 网关限流拒绝 | 429，保留原协议 | — | gateway_limited；在断路器外 |
| 客户端取消 | 不制造响应；未提交时统计 statusCode=0 | 保留已提交状态，统计 cancelled | client_cancelled；释放许可，不计成功或失败 |
| 未归类内部异常 | 500 | 终止原响应 | proxy_internal_error；忽略，不武断归为上游错误 |

错误 JSON 只在尚未提交时写出，包含 `code/reason/phase/message`，禁止缓存。已提交时传播异常，由服务器终止连接/响应；HTTP 200 开始后中断，就如实保留 200 并记 `outcome=error`，前端显示“已中断”和原因，不能伪造最终 504。每个入口只产生一个完成事件。

分类按异常 cause 链检查，包含该版本真正抛出的 `org.springframework.cloud.gateway.support.TimeoutException`；不能只匹配 JDK 同名异常。`phase` 为最近观察到的阶段：admission、request_sending、response_body；它是诊断线索，不证明上游已经/尚未执行业务。

超时、取消、断连都不证明上游业务未执行。总预算也可能被慢客户端消耗，因此其失败率不是纯粹的上游根因指标；本轮把这种未完成的代理调用计为失败，并通过不同 reason 保留诊断依据。

## 4. 熔断状态、隔离与在途请求

[ProxyBreakers](../backend/src/main/java/com/zch/proxy/ProxyBreakers.java) 明确创建配置，不再依赖 `instances.default` 的名称解析。所有名字（包括显式 default）使用上述策略。

- CLOSED：完整请求完成后记录结果；500–599 与已分类的上游异常/超时计为失败。4xx 表示一次正常完成的代理调用，不等于业务成功。
- 窗口达到 minimum-calls 后，失败率达到阈值则 OPEN。开启期间新请求立即 503，上游接收数为 0。
- 等待 open-wait 后，**下一次请求**触发 HALF_OPEN；不额外创建定时探测线程。诊断中的剩余等待为 0 不等于此刻已经半开。
- HALF_OPEN 最多发放 half-open-calls 个调用许可；超出的新请求返回 503。探测结果达到样本数后决定关闭或重新开启。取消/忽略异常释放许可，不伪装成功样本。每个探测仍受总预算约束。
- 默认名 `cb-<路由ID>` 彼此隔离；显式相同名字在**本实例**共享状态。不同网关没有共享断路器状态；重启从 CLOSED 开始。
- OPEN 不撤销此前已准入的请求。它们继续受各自预算约束并得到自己的最终结果，不能把“打开后所有请求都失败”作为断言。
- 不单独设置慢调用熔断阈值：慢调用阈值放在总预算之外，主要决策依据是完成结果与超时。在系统调度长暂停等极端情况下不声称精确的毫秒边界。

断路器名不是全局并发隔离仓；共享上游仍可能竞争同一个连接池。连接/排队限制按目标池设置，不是所有上游加起来的全局限制。已创建断路器名称保留到进程结束；大量管理端反复创建不同名称时，注册表清理是尚未实现的边界。

## 5. 不自动重试

动态路由不生成 Retry 过滤器；启动配置里出现 Gateway Retry 过滤器会拒绝启动。HTTP 客户端明确 `disableRetry(true)`，并关闭自动跟随重定向。依据锁定版 `HttpClientConnect`，Reactor Netty 原本可能在部分发送前连接 reset 场景重试一次；不能因为代码没有写 `.retry()` 就认为只有一次发送。

真实测试让 POST 上游读完请求、记录业务副作用后断开响应。入口得到 502，上游处理次数仍为 1。它证明网关本次没有自动重发，**不承诺业务 exactly-once**；客户端、外层负载均衡器或上游本身重试不在这个保证内。审计后台的批次重试与事件去重保持原职责，与代理 HTTP 请求无关。

## 6. 统计、诊断与资源

客户端在收到响应后关闭连接时，底层 `send()` 可能取消 body publisher，却完成外层写出 Mono。新增 `ProxyResponseLifecycle` 同时观察普通/流式响应体的取消信号；如果写出 Mono 完成而 body 实际被提前取消，保护层把它转换为不计入断路器样本的取消事实。取消超时任务本身不会覆盖已经产生的超时异常。

复用外层完成 recorder 和 AtomicBoolean 一次性门闩，不在超时/熔断处理器另记请求。保留原 `zenith.gateway.requests` 的 status/outcome 维度，增加固定枚举 `zenith.gateway.proxy.outcomes{reason}`，不把 URI、客户端或路由名做动态指标标签。审计/监控事件新增可选 `reason`、`phase`；旧记录缺失这些字段仍可读。

新增受原管理认证保护、`Cache-Control: no-store` 的 `GET /settings/proxy/diagnostics`，纯本地观察，不查 Redis、不发起请求、不触发半开：

- `source=local`、`observedAt` 与本实例实际采用的启动 `policy`。
- `activeProxyRequests`：保护层中尚未结束的调用，不包含提前被限流/认证拒绝的请求。
- `breakers`：名称、状态、最近状态切换及时间、窗口样本/失败/成功/拒绝数、失败率、距离允许探测的时间。未创建的名字不伪造记录；不足样本时失败率可能为 -1。
- `pool`：当前进程名为 zenith-proxy 的所有目标池连接/等待者合计。未注册对应 gauge 时为 null，不当作 0；这些读数并非原子集群快照。

自建 ConnectionProvider 在应用关闭时 dispose；每个池有连接上限、等待者上限和等待超时，空闲连接 30 秒、最大寿命 5 分钟、每 15 秒后台驱逐。正常 keep-alive 空闲连接可以保留，不把它们当成占用泄漏。实测逐组等待 activeProxyRequests、active.connections、pending.connections 全部归零；网关退出码、上游 socket 和容器清理另行记录。

取消会取消转发订阅并释放连接/等待许可，不承诺能够撤销上游已经产生的副作用。运行配置仍从本地完整快照读取；真实回滚/同步回归在阻塞后台配置读的明确窗口中发送 20 个代理请求，配置新增读取为 0。

## 7. 验证入口与证据

最终实际结果、耗时、统计、证据文件及清理结果见 [backend-proxy-resilience-validation.json](backend-proxy-resilience-validation.json)。新脚本默认每次生成 UUID 目录，不覆盖旧结果。

2026-10-03 最终验收运行：

| 验证 | 实际结果 |
| --- | --- |
| 后端完整 verify（独立 Redis） | 137 项，失败 / 错误 / 跳过均为 0，生产 JAR 打包成功 |
| 前端测试 / 生产构建 | 87 项通过，构建通过；保留既有 ECharts 分块超过 500kB 的构建提示 |
| 本轮真实故障 | 14 组、50 个入口请求逐个核对，一次最终完成计数；2 项非法启动 / Retry 配置拒绝检查通过 |
| 超时实测（缩短的测试策略） | 响应头 509.71–515.69ms → 504；TLS 停顿 212.15ms → 504；读取停顿 709.54–716.14ms、总预算 1612.52–1622.34ms 均终止已开始的 HTTP 200 |
| 客户端取消 | 响应前 statusCode=0；响应后保留 200；两者均 cancelled，未增加熔断成功/失败样本 |
| 旧验收回归 | 11 个具体入口报告、124 项检查全部通过，包括同步 10、回执 12、安全回滚 12、配置一致性 20、两轮 P2 与真实浏览器路由流程 |
| 业务请求配置读取 | 阻塞 B 的后台同步读期间，20 个代理请求和 10 个本地观察，新增配置查询 0 |
| 浏览器 | Edge 154；预览 14 项、真实路由管理 12 项；页面错误 0，预览后端调用 0；320–1440px、长名/32 条、节点展开、认证及恢复均通过 |
| 清理与保留 | 网关正常退出，上游关闭，测试容器移除；最终进程/容器观察无本轮残留；开始时的 132 份文档与证据逐字节未改变 |

最终故障原始记录：[report.json](../.dev/proxy-resilience/live-2228fc27/report.json)、[网关日志](../.dev/proxy-resilience/live-2228fc27/gateway.log)、[上游记录](../.dev/proxy-resilience/live-2228fc27/upstream.json)。兼容回归索引：[report.json](../.dev/proxy-resilience/regression-0e23958e/report.json)。明确标注“演示数据”的实际浏览器截图：[熔断节点](../.dev/proxy-resilience/regression-0e23958e/images/proxy-breaker-preview-1440.png)。这些本地原始文件在 `.dev` 下；本目录验证 JSON 同时保存摘要、逐请求结果及 SHA-256，便于提交展示。


```powershell
# 使用已有工具链，仓库根目录执行；Docker 需可用。
. ./.dev/upgrade-tools/env.ps1
# 先运行完整后端测试时，必须将 ZENITH_TEST_REDIS_PORT 改为自建 Redis 的随机端口。
# env.ps1 原值 16379 不是本轮测试环境，不直接拿它运行联调。
& $maven -f backend/pom.xml -DskipTests package
node verification/proxy-resilience-live.mjs
# 前端构建完成后可执行原配置验收 + 浏览器路由回归。
npm --prefix frontend test
npm --prefix frontend run build
node verification/proxy-resilience-regression.mjs
```

`proxy-resilience-live.mjs` 自动创建独立 Redis 7.4.11 容器、随机端口、UUID 配置/路由/审计键、随机管理凭据、一个真实网关进程与受控本地上游。使用现有生产 JAR；可设置 `PROXY_RESILIENCE_JAR`、`PROXY_RESILIENCE_OUTPUT`。本机已有锁定镜像才运行（`--pull=never`），不访问开发 Redis。

故障行为为明确的接受/不回复、读完写请求后断开、输出前缀后停顿、持续输出、可手动释放的请求屏障。时间断言依据配置预算，等待条件都有上限；轮询间隔不是用于碰撞故障窗口的猜测睡眠。测试用 150/500/700/1600ms 的建连/响应头/读取停顿/总预算，以及 4 连接、2 等待、250ms 排队、窗口 4、半开 2、开启等待 1000ms；生产默认另由原真实网关联调验证 2 秒响应头预算。

矩阵包含：正常与路径重写、400/500/302 原样保留、连接拒绝、响应前断连、延迟/不回复响应头（断路器开关各一次）、TLS 不回复、部分响应停顿、持续数据触发总预算、打开拒绝、半开成功/失败、故障路由隔离、显式同名共享、打开时在途请求、写请求处理后丢回复、响应前/后的主动取消、池耗尽/排队取消/超时、认证与限流隔离、本地监控 SSE、配置写入与回执，以及非法启动预算/意外 Retry 配置拒绝。

每个入口记录原始状态、响应或终止方式、实际耗时、上游到达次数、最终审计事件、断路器状态；每组核对完成计数增量和资源归零。最后再次检查全部上游次数和审计唯一性，避免只在最早一次回调时检查。

本轮真实测试过程中发现并修复：Gateway 非 JDK TimeoutException 未匹配（误分类为 500）；默认 TLS 未应用握手超时（响应头已超时而连接还占用）；响应开始后客户端断开，写出 Mono 完成导致成功误计（新增 body 生命周期判定）。失败迭代记录也保留，不将未通过的中间运行算入通过证据。

## 8. 兼容、部署与剩余边界

- 不改变 Redis 配置/路由存储格式、六字段运行协议、operationId 绑定、回执窗口、同步/readiness、历史或回滚流程。前端只改路径顺序、故障说明和审计原因展示，保留原认证/草稿生命周期。
- 旧 `fallbackPath=/fallback/default` 字段保留读写兼容，直接访问该旧本地接口仍为 503；代理故障不再内部转发至该接口。旧实例仍会有旧行为，因此上线应同时发布新后端与对应前端，并让调用方接受 502/504 的新分类。
- 旧 `resilience4j.*.instances.default` 已从应用配置移除；代理策略统一取 `zenith.proxy.resilience`。不要依赖旧 TimeLimiter/断路器实例配置覆盖新保护层，也不应另加原生 CircuitBreaker/Retry 过滤器叠加保护。
- 部署前保存旧程序和启动参数；启动新隔离实例检查 readiness 与诊断中的策略，执行本故障矩阵后再安排开发/部署实例切换。本轮未执行该切换。格式无需迁移；回退旧程序/前端与原启动文件即可，回退会恢复旧超时与 503 行为，不能声称仍有本轮保证。
- 普通代理的流式响应同样受总预算限制；不支持无限 SSE/大文件长流专用策略。WebSocket、gRPC、HTTP/2 多路复用、HTTP 代理服务器链、自定义底层客户端、复杂 DNS 多地址和系统级 SYN 丢包尚未做本轮端到端故障矩阵。TCP 超时分类有单元覆盖，真实建连验证是本地拒绝和 TLS 握手停顿，不把它写成真实 SYN 丢包实验。
- 自定义 SSL bundle 配置沿用框架实现，但本轮未新增证书矩阵。慢客户端造成总预算耗尽与纯上游慢需要结合 phase/上游日志判断。服务器发送错误响应本身不承诺客户端一定收到；记录已提交状态不会证明对端收到了完整内容。
- 测试验证在当前独立环境下的有界释放，不是长期压测或堆内存泄漏证明。断路器状态本地且不持久化，池限制按目标而非全局；未建设集群共享熔断、自动重试、动态故障策略或提交历史之外的新能力。
