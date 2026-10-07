分布式限流独立验收 · 2026-10-03

结论：本轮暂未通过，需修复一项 P2。完整测试与原有真实故障矩阵均通过，但存储格式补验发现 JSON false 被当作键不存在，触发桶或策略门槛重建。

本轮只审查实现、执行隔离验证和保存证据，没有修改产品代码或升级现有开发实例。

**P2：区分已存储的 JSON false 与 Redis 键不存在**

位置：[rate-limit.lua](D:/Java/ZenithGateway/backend/src/main/resources/rate-limit.lua:18)。read() 对不存在的键返回 nil/true，对内容为 false 的已存在键则返回 Lua 布尔值 false/true。调用方使用 if fence / if bucket 判断存在性，两个状态因此走入同一初始化分支，跳过策略或桶格式校验。

复现前提是 Redis 键已经存在，内容恰为 JSON 布尔值 false。它是合法 JSON，但不符合本项目策略或桶的对象结构，应该走异常降级并保留原值。这是显式的数据损坏处理场景，不是声称正常写入流程会生成 false。

使用同一交付 JAR、真实 Redis 和独立网关，实际得到：

| 注入位置 | 实际行为 | 预期行为 |
| --- | --- | --- |
| 已存在的客户端桶，原值 false | 按容量 20 初始化，扣 1 后写回 tokensMilli=19000，覆盖原值；结果 allowed / quota_available / confirmed | 保留 false，返回 redis_fail_open / bucket_invalid，不重建正常额度 |
| 已存在的策略门槛，原值 false；使用尚无桶的新客户端 | 用当前请求参数重建门槛，同时创建新桶，扣 1 后剩 19；结果同样为正常额度确认 | 保留 false，返回 redis_fail_open / policy_invalid，不创建客户端桶 |

默认故障放行可以继续返回 HTTP 200；需要修复的是覆盖损坏状态并伪装成正常额度确认的行为。它与本轮“非法存储状态保留原值、明确降级”的约定不符。

建议在 read() 中明确区分缺失、解码失败和不符合对象结构的已存值，或返回独立的存在性标记；不要使用解码结果的真假判断键是否存在。桶与策略门槛都需要补充 JSON false 回归，同时保留真正缺失键的合法初始化行为。

证据：[完整断言结果](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/malformed/report.json) · [独立复现脚本](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/malformed-state-repro.mjs) · [运行日志](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/malformed.log) · [真实网关日志](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/malformed/A.log)。

脚本分别对桶和门槛注入 false、null、true、0、字符串、空数组和空对象，共 14 个格式用例。false 的两例失败，另外 12 例正确识别为异常并保留原值。脚本 executionCompleted=true、passed=false、退出 1，失败来自行为断言；网关启动和资源清理均成功。

**独立复跑结果**

| 检查 | 本次结果 |
| --- | --- |
| 后端完整 verify 与生产打包 | 176 项通过，失败、错误、跳过均为 0；使用独立 Redis 随机端口 |
| 前端测试、类型检查与生产构建 | 88 项通过；保留原有约 502.99 kB 图表块提示 |
| 限流真实矩阵 | 22 组通过，184 个 HTTP 请求记录，包含 6 次预热/路由就绪探测 |
| 代理真实故障回归 | 24 组、102 个请求通过，包含 TCP RST、协议大小写、重启、取消、半开与连接池边界 |
| 非法启动配置 | 2 项按预期拒绝启动 |
| 新增存储格式补验 | 14 例中 2 例失败，属于同一项 P2 |

[后端日志](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/backend.log) · [前端测试日志](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/frontend-tests.log) · [类型检查日志](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/frontend-typecheck.log) · [生产构建日志](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/frontend-build.log) · [22 组限流结果](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/live/report.json) · [24 组代理结果](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/proxy/report.json) · [汇总 JSON](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/acceptance-summary.json)。

本次独立测量中，共享桶实际扣除 20 个令牌，上界为 20.071，未超额。94 次积压/降级压力请求中，峰值为 2 条物理命令、4 个排队决策，饱和快照含 7 个定时项；最长入口等待约 419.87ms，测试决策预算为 400ms，入口耗时还包含网络与调度开销。

10 次代理请求及 20 次本地诊断的新增运行配置查询为 0。已执行后丢回复、取消、断连、真实 Redis 暂停、关闭资源和故障恢复均由原有真实矩阵复跑覆盖；共享额度、资源上限的保证仍限定在文档声明的条件内。

本次没有重新执行完整配置同步/回执/回滚与浏览器回归，也没有重新执行旧实现基线；已核对交付中的配置与浏览器总清单及其散列。TLS/ACL、Linux 原生传输、长期压力、持久化丢失及主从切换不在本次实测范围内。

**补验入口与关闭条件**

在修复后重新构建 JAR，从仓库根目录运行下面的原始补验脚本。每次指定一个新输出目录，保留当前失败证据。

```powershell
Set-Location -LiteralPath 'D:\Java\ZenithGateway'
$env:JAVA_HOME = 'D:\Java\ZenithGateway\.dev\toolchains\jdk-21.0.12.1+1'
$env:RATE_LIMIT_OUTPUT = 'D:\Java\ZenithGateway\.dev\rate-limit-false-recheck-' + [guid]::NewGuid().ToString('N')
& 'D:\Java\ZenithGateway\.dev\toolchains\node-v24.21.0-win-x64\node.exe' 'D:\Java\ZenithGateway\.dev\rate-limit-acceptance-1a1021e053f\malformed-state-repro.mjs'
```

关闭条件：上述 14 例全部通过；正常缺失桶仍能初始化；损坏策略和损坏桶均保留原值并返回对应降级原因；补充正式回归并复跑受影响的后端测试和 22 组限流矩阵。

**产物与清理**

实际测试 JAR SHA-256：bd6b93f07883153239e1a87757d84e2131a68c1e9ddaad28054e1964d2dcb1e8，与交付一致。175 份源文件清单散列全部匹配；与开始时归档相比，55 份既有文档/JSON 均未变化。

后端测试、限流矩阵、代理回归和新增补验使用的专属 Redis、网关、受控上游及故障代理均已清理。按本轮专属容器名称和进程标识再次核查，剩余自建容器与进程均为空。原有开发实例和历史证据保留。
