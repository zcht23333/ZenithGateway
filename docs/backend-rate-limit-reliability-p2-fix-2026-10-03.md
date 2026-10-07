# 限流 P2 修复与补验 · 2026-10-03

本次修复已完成，提交独立复验。对应 [独立验收中的 JSON false 问题](D:/Java/ZenithGateway/docs/backend-rate-limit-reliability-acceptance-2026-10-03.md)。原验收报告、原失败证据及此前交付文档保持原样，本文记录修复后的行为与本次实际执行结果。

## 修复与边界

Redis GET 对缺失键返回 Lua false；字符串 `false` 经 cjson.decode 也成为 Lua false。原 read() 将后者作为有效解码值返回，后续存在性判断因此进入初始化分支。

现在先区分 Redis 原始缺失回复，再对已存数据解码并检查类型。解码失败或非 table 值立即返回非法状态；table 值继续经过原有 schema、字段和版本校验。空数组、空对象仍不符合策略或桶结构，不能因为 Lua 中同为 table 就被接纳。整个校验发生在写入前。

| 存储状态 | 修复后行为 |
| --- | --- |
| 策略、桶确实都不存在 | 按现有协议初始化，正常扣一次成本 |
| 有有效策略、桶确实不存在 | 按现有策略创建桶并扣费，不重写策略 |
| 桶为 JSON false 或其他非法结构 | 保留桶和策略原始字节；redis_fail_open / bucket_invalid / not_written |
| 策略为 JSON false 或其他非法结构 | 保留策略及已有桶；无桶时不建桶；redis_fail_open / policy_invalid / not_written |

默认故障放行不变：这些格式错误仍可转发并获得上游 HTTP 200，但诊断明确记录故障放行，不计为正常额度确认。修复不自动恢复旧版本已经覆盖的数据或返还已扣额度。

生产改动仅在 [rate-limit.lua](D:/Java/ZenithGateway/backend/src/main/resources/rate-limit.lua:15)。新旧 JAR 逐项比较，唯一内容变化为 BOOT-INF/classes/rate-limit.lua。Redis 键、schema=2、运行配置、管理接口、前端协议及版本门槛均未改变，无新增存储迁移。此前 v1→v2 的部署与迁移说明仍然有效。

现有开发实例未升级。后续部署需让所有网关加载修复后的 JAR；旧实例仍携带此缺陷，混用期间不能宣称全体请求具备修复行为。回退旧二进制不需要格式转换，但会恢复该缺陷。

## 本次亲自执行的补验

| 检查 | 实际结果 |
| --- | --- |
| 修复前原始复现脚本 | 14 例执行完成，其中 false 桶、false 策略两例失败；保留 HTTP、Redis、诊断及退出码 1 证据 |
| 后端完整 verify 与生产构建 | **192** 项，失败、错误、跳过均为 **0**；其中限流 Lua 集成测试 28 项，新增 16 项 |
| 修复后运行同一原始复现脚本 | **14/14** 通过；脚本文件未修改 |
| 新增正式格式验证入口 | **17** 组检查通过：7 种非法值在桶、策略＋无桶、策略＋已有桶下共 **21** 次异常请求；另两组真实缺失初始化、一组恢复 |
| 原限流真实矩阵 | **22** 组通过；184 个 HTTP 请求，其中 6 次预热/路由就绪探测、178 次正式请求 |

新增 JUnit 格式回归使用未替换时间源的生产 Lua，连接自建真实 Redis。覆盖 false、null、true、0、字符串、空数组、空对象；检查原字节保留、错误原因、not_written 和真实缺失初始化。

新增 [正式验证入口](D:/Java/ZenithGateway/verification/rate-limit-malformed-live.mjs) 使用真实网关、Redis、上游及受管理认证保护的诊断接口；同时核对故障放行计数增加、正常放行计数不变。17 组共发出 26 个 HTTP 请求，包含 2 次预热/路由就绪探测。手工恢复仅操作隔离测试键，不代表应用自动修复损坏数据。

22 组矩阵继续覆盖双实例配额、参数异步采用、时间夹具、断连、阻塞与回复丢失、取消、无重试、审计对账及资源释放。本次共享桶实际扣除 20 个令牌，计入补充后的上界为 **20.093**。饱和状态为 2 条实际在途命令、4 个排队决策、7 个定时项，94 次压力请求中最长入口等待 **416.30ms**（配置决策预算 400ms，入口耗时还含调度、网络及转发）。10 次代理请求及 20 次本地诊断新增运行配置查询仍为 **0**。

修复前 JAR SHA-256：bd6b93f07883153239e1a87757d84e2131a68c1e9ddaad28054e1964d2dcb1e8。

修复后 JAR SHA-256：f803d536bc1df1d09be9ac19fde493ebb50d954cd9cd1f5affe5ff415850a636。上述三个修复后真实验证入口均使用这一个产物；新旧 JAR 均已留档。

## 重复执行与证据

先准备 Java 21、Node 24、已缓存的 Redis 7.4.11 锁定镜像，并构建当前后端 JAR。从仓库根目录执行；每次使用新目录保留旧证据：

```powershell
Set-Location -LiteralPath 'D:/Java/ZenithGateway'
. ./.dev/upgrade-tools/env.ps1
$env:RATE_LIMIT_OUTPUT = '.dev/rate-limit-format-' + [guid]::NewGuid().ToString('N')
node verification/rate-limit-malformed-live.mjs
$env:RATE_LIMIT_OUTPUT = '.dev/rate-limit-matrix-' + [guid]::NewGuid().ToString('N')
node verification/rate-limit-reliability-live.mjs
```

两个入口自行创建随机端口、独立 Redis 与命名空间、测试网关和上游，结束后清理。后端完整 verify 本次同样使用独立随机端口 Redis，具体端口与命令见验证索引，未使用 env.ps1 中的默认测试端口。

- [修复前原脚本结果](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/before/report.json) 与 [修复后同脚本结果](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/after-original/report.json)。
- [17 组正式格式补验](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/format-regression/report.json) 与 [22 组限流矩阵](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/limiter/report.json)。
- [后端测试日志](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/backend-verify.log)、[逐套件统计](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/backend-tests.json)；原始 XML 已另行归档。
- [清理核查](D:/Java/ZenithGateway/.dev/rate-limit-false-fix-1791037925516/cleanup-check.json)：本次 5 个专属 Redis 容器均不存在，4 组命名空间对应网关进程均不存在；所有真实网关正常退出，代理和上游关闭。
- [机器可读验证索引](D:/Java/ZenithGateway/docs/backend-rate-limit-reliability-p2-validation-2026-10-03.json)：命令、产物身份、报告摘要、原始证据散列与隔离参数。

开始时记录的 316 份既有文件中，只修改了 Lua 和对应测试类；其余 314 份保持原字节，包括 141 份既有 docs 文件和 42 份前端源文件。新文档及验证入口单独新增，不替换原失败证据。

## 没有重跑与剩余取舍

本次未修改前端、HTTP 代理保护或配置协议，因此未重新执行前端 88 项测试/前端生产构建、24 组代理故障矩阵、独立启动拒绝检查、完整配置同步/回执/回滚联调或浏览器验收；这些旧结果只依据已核查的上一轮验收记录，不计为本次新实测。后端完整测试包含现有代理及配置测试，限流矩阵包含其相关真实交互，但不代替上述完整独立矩阵。

故障放行仍不保证坏数据期间的总放行量；本次修复使原因与存储状态准确，并不建设自动数据修复机制。Redis 持久化、故障切换、TLS/ACL 矩阵及长期生产负载边界沿用原文档，没有新增保证。本次完成后停在验收。
