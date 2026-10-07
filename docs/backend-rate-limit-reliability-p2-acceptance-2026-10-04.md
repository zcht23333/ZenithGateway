分布式限流 JSON false P2 重新验收 · 2026-10-04

验收通过，关闭上轮 JSON `false` 被当成缺失键的 P2。本轮独立检查未发现新的阻塞问题。只执行验收、构建和隔离验证，没有修改产品实现或升级现有开发实例。

修复位于 [rate-limit.lua](D:/Java/ZenithGateway/backend/src/main/resources/rate-limit.lua:15)：先识别 Redis GET 对缺失键返回的 `false`，再解析已有字符串；解析失败或解析结果不是表时返回无效状态。JSON 布尔值 `false` 因而不能再进入缺失键的初始化分支。对象和数组仍继续接受既有结构校验；计时、余额结算、策略版本和写入逻辑未变。

| 场景 | 本轮实际结果 |
| --- | --- |
| 已存在的桶值为 JSON `false` | 原始字节保留；`redis_fail_open / bucket_invalid / not_written` |
| 策略值为 JSON `false`，客户端桶缺失 | 策略原值保留，客户端桶仍不存在；`redis_fail_open / policy_invalid / not_written` |
| 策略值为 JSON `false`，客户端桶已存在 | 策略和桶原值均保留；明确记录 `policy_invalid` |
| 策略与客户端桶均缺失 | 正常初始化，仅扣一次；容量 20、消耗 1，剩余 19000 毫令牌 |
| 合法策略下客户端桶缺失 | 正常初始化并扣一次，策略原值不被改写 |
| 恢复合法测试策略后使用新客户端 | 恢复 `allowed / confirmed`，剩余 19000 毫令牌 |

无效数据场景仍按既有故障放行规则访问上游并返回 HTTP 200；这不表示限额已确认。格式回归还核对了降级计数递增、正常放行计数不递增。

| 独立执行项目 | 结果与证据 |
| --- | --- |
| 后端 verify 与生产 JAR 构建 | 192 项通过，失败、错误、跳过均为 0；其中 Lua 集成测试 28 项。[日志](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/backend.log)、[计数及归档 XML 索引](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/backend-tests.json) |
| 原始复现脚本原样执行 | 14/14 通过；16 个 HTTP 请求中含 2 个预热请求。[结果](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/original/report.json)、[原脚本](D:/Java/ZenithGateway/.dev/rate-limit-acceptance-1a1021e053f/malformed-state-repro.mjs) |
| 新增格式回归 | 17 组通过；包含 21 次无效值请求、2 次缺失键正向检查及 1 次恢复检查；加预热共 26 个请求。[结果](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/format/report.json) |
| 原限流矩阵 | 22 组通过，184 个 HTTP 请求中含 6 个预热请求。[结果](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/live/report.json) |

原始 14 个用例覆盖桶和策略中的 `false`、`null`、`true`、`0`、字符串、空数组、空对象。新增格式回归对每种无效策略同时验证缺失桶和已有桶，避免只覆盖其中一条路径。原始脚本 SHA-256 为 `aa8a6fdc00073c45d95d737a3c4d9f12bc56e3c481f61c5b613cca06961016ba`，与交付证据索引一致，没有修改断言。

限流矩阵本次实测：双实例共扣除 20 个令牌，含实际补充量的上界为 20.078；在途命令峰值 2、排队峰值 4，饱和时观测到 7 个定时项。配置的决策预算为 400ms，最长入口等待约 413.64ms，后者还包含 HTTP 和调度开销。释放故障后本次记录约 116ms 恢复。10 次代理请求和 20 次本地诊断读取新增运行配置查询均为 0。这些数值是本次隔离实验结果，不是生产时延承诺。

重建 JAR 与提交的候选 JAR 哈希一致：`f803d536bc1df1d09be9ac19fde493ebb50d954cd9cd1f5affe5ff415850a636`。逐项比较修复前后 JAR 内容，仅 `BOOT-INF/classes/rate-limit.lua` 发生变化，没有新增或移除条目。核对修复前 316 个文件的清单，只有 Lua 与对应测试类变化，另外 314 个文件保持一致，其中包括 42 个前端文件和 141 份既有文档。提交索引中的 61 份证据均通过哈希核对。

本轮没有重新执行前端测试、前端类型检查与构建、完整代理故障矩阵、独立启动拒绝检查，以及完整配置同步／回执／回滚／浏览器联调。上述范围没有变化，本轮的收敛验证足以覆盖这一 Lua 格式修复；不将历史通过记录计为本轮执行结果。TLS/ACL、长期压测、持久化丢失与主从切换仍未验证；旧版本已覆盖的数据也不会因本次修复自动恢复。

首次尝试在测试开始前遇到 Docker 服务未运行；启动本机已安装的 Docker Desktop 后成功重跑，保留了[首次环境记录](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/backend-attempt-1-environment.json)。所有实际测试使用专用随机端口、容器和命名空间。各轮网关、受控上游、故障代理及 Redis 均已清理，最后再次查询，属于本轮的残留容器和网关进程均为空。现有开发实例未升级。

验收开始时记录的 324 个文件在结束时均未变化，包含原始复现脚本和上轮失败证据。新增结果保存在独立目录，没有覆盖历史验收材料。

[验收汇总 JSON](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/acceptance-summary.json) · [清理核查](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/cleanup-check.json) · [构建产物比对](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/artifact-identity-before.json) · [串行验证执行记录](D:/Java/ZenithGateway/.dev/rate-limit-p2-acceptance-1a105148973/live-runs.json)
