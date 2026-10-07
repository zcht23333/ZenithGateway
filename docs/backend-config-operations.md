# 运行配置提交记录与结果确认

本轮在已验收的版本条件写入与多实例同步之上，增加操作身份、提交回执、按操作查询和轻量历史。范围仍是一个 Redis 权威存储下的六字段运行配置；不包含历史配置回滚、Redis 故障切换后的永久 exactly-once、账号体系或路由同步。

现有开发实例没有升级。本轮验证只启动专属 Redis、随机端口和独立 JVM。此前验收文档、JSON、截图及用户改动保留；改动前源码归档在 `.dev/config-operations/before.zip`。

## 1. 为什么当前值不能证明原提交成功

A 发起操作 X，回复丢失；随后 B 提交 Y。读取当前配置得到 Y，只能说明读取那一刻的配置。即使当前六个值恰好与 X 相同，也可能由 B 写入，不能归因于 X。

新协议记录的是“操作 X 以版本 V 为前提，是否生成了 V+1”，并把该事实与配置一起写入。查询 X 直接读取这份事实，不比较草稿与当前值，不使用本地采用版本冒充存储结果。

`GET /settings/runtime` 仍然在 Redis 读取当前完整快照并尝试本地采用。`GET /settings/runtime/adopted` 与 `/settings/runtime/sync` 仍只观察本地状态。新增结果查询与历史查询都不采用历史配置。

## 2. 操作协议与生命周期

`PUT /settings/runtime` 请求包含六字段、`expectedVersion` 和小写 UUID `operationId`：

```json
{
  "operationId": "11111111-1111-4111-8111-111111111111",
  "expectedVersion": "22222222-2222-4222-8222-222222222222:8",
  "rateLimitEnabled": true,
  "replenishRate": 40,
  "burstCapacity": 80,
  "requestedTokens": 1,
  "monitorWindowSeconds": 30,
  "emitIntervalSeconds": 2
}
```

- 一次明确提交创建一次 ID；网络重试保留整个原请求，包括 ID 与 expectedVersion。
- 修改任一配置值或 expectedVersion，以及冲突核对后再次提交，都是新操作。
- ID 在同一配置 Redis 键内唯一，不绑定某个网关连接。不同实例可查询和重放同一操作。
- 先按原有范围把 JSON 数值规范化为整数和布尔值，再绑定六字段与完整 expectedVersion。Lua 逐字段比较规范化值，不比较原始 JSON 字节；键顺序和 `32` / `32.0` 不改变操作身份。
- 相同 ID、相同请求且回执未过期：返回原结果，`replayed: true`，不重新判断当前版本、不新增历史、不写配置、不续期回执。
- 相同 ID、不同规范化请求：`409 CONFIG_OPERATION_MISMATCH`；原回执和配置不变。
- 新操作遇到版本冲突：记录明确拒绝回执，返回 `409 CONFIG_VERSION_CONFLICT`。重试该 ID 仍返回原拒绝事实。
- 缺少 operationId 或 expectedVersion 返回 428；不隐式生成 ID，不提供绕过 CAS 的兼容路径。

成功响应保留原有平铺六字段、version、source、confirmation 与 adopted，并增加 `receipt` 和 `replayed`。回执字段：

| 字段 | 含义 |
| --- | --- |
| operationId / expectedVersion | 操作身份 / 提交所基于的完整版本 |
| request | 规范化后的六字段请求 |
| status | committed 或 rejected |
| before | 作出提交决定时的版本与六字段 |
| after | 成功生成的版本与有效六字段；拒绝回执没有此项 |
| code | 拒绝原因，目前持久记录 CONFIG_VERSION_CONFLICT |
| recordedAt / expiresAt | Redis TIME 提供的 Unix 毫秒时间 / 保证回执保留截止时间 |
| instanceId | 原提交被记录时的接收实例；重放保留该身份 |

`before` / `after` 可以准确还原每项变更；无效请求、认证拒绝、ID 绑定冲突、容量拒绝、存储不可用等不生成“成功记录”。本轮没有建设操作排队系统，也不会将查无回执标成 pending 或 not-executed。

PUT 的 `outcome: not-written` 表示**此次到达的请求没有新增配置写入**。例如原请求已成功后，一次重试可能被认证拒绝；不能因此改写原操作的历史事实。查询接口只有读到持久化的拒绝回执才报告 rejected。

## 3. 存储结构与原子提交

仍使用 `zenith.runtime.redis-key` 对应的单个 Redis String，升级到 schemaVersion 2：

```text
{
  schemaVersion: 2,
  version, 六字段,
  operations: { operationId: receipt, ... },
  history: [成功 receipt，按生成版本从新到旧，...]
}
```

Redis cjson 可能把空 history 编码为 `{}`；存储校验兼容空对象与空数组，HTTP 历史接口始终返回 `entries: []`。

选择“有界文档 + 单次 SET”，而不是依次 SET 配置、SET 回执、ZADD 历史索引。Redis Lua 的原子执行解决并发交错，不提供任意命令失败时的事务回滚。官方说明：[Lua 执行与错误处理](https://redis.io/docs/latest/develop/programmability/eval-intro/)、[事务运行期错误与不支持回滚](https://redis.io/docs/latest/develop/using-commands/transactions/)。

一次新提交的执行顺序：

1. GET 并校验现有 schema、版本、六字段、回执结构及有界历史。
2. 读取 Redis TIME，查已有回执并比较请求；重放在 CAS 和容量检查之前返回。
3. 对新操作检查活动回执容量，比较 expectedVersion。
4. 在 Lua 局部表中生成完整配置、成功或冲突回执、过期清理后的回执集合与有界历史。
5. **先编码完整存储文档和完整响应**；之后执行唯一的 `SET`。
6. SET 成功后只返回已准备的响应，不再执行 Redis 命令或 JSON 编码。

这里必须一起保存的是新配置、绑定请求的结果回执及其有效期；历史副本也随同一个文档发布。没有独立的 ZSET/列表索引，因此没有“配置和回执成功但历史索引没更新”的额外故障点。history 是有界的成功回执副本：超过幂等窗口的历史副本可能是该事实仅存的来源，不能声称它在任意丢失后都能重建。

不同保证须分开理解：

- **并发原子性**：操作查重、CAS、版本递增和最终文档发布在同一个 Lua 执行内，不被其他提交插入。
- **中途命令失败**：GET/TIME/校验/编码失败发生在写入之前；SET 明确拒绝不会留下半份配置或半份回执。没有先修改配置、后补回执的窗口。
- **回复丢失**：客户端可能不知道 SET 是否已执行，状态为 unknown；同一权威 Redis 中若保存成功，配置与回执均已存在，可按 ID 查询或原样重试。
- **持久性边界**：不把 Redis 返回成功等同于已经落盘或复制到故障切换后的新主节点。实际 RDB/AOF 策略、崩溃、数据丢失和运维恢复仍可能丢失已确认文档；参见 [Redis 持久性说明](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)。本轮不提供跨这些边界的永久 exactly-once。

## 4. 查询与分页

均使用现有管理 Bearer 认证，并返回 `Cache-Control: no-store`；运行配置路径的认证、readiness、参数绑定失败也禁止缓存。

### 按操作查询

`GET /settings/runtime/operations/{operationId}`

- `200 {status: "committed", receipt, source: "redis-receipt", adopted, ...}`：证明该操作在回执记录的版本上成功。
- `200 {status: "rejected", receipt, ...}`：有持久拒绝事实，当前为版本冲突。
- `200 {status: "unknown", reason, ...}`：没有保证窗口内的可用回执，或配置键缺失。可能请求尚未到达、尚未执行、回执过期或数据丢失，不能推断未执行。
- Redis 不可读、文档非法：`503 CONFIG_OPERATION_UNAVAILABLE`，status / outcome 为 unknown。仍可显示本实例 adopted，但不能据此确认操作。
- `checkedAt`（可用时）只是本次查询时间，不更新 recordedAt、expiresAt，也不刷新同步确认时间。

查询一个旧成功操作只返回旧事实。当前存储可能已有多个后续版本；adopted 是响应时本实例的完整本地快照，二者分开。原成功操作重放同样保留原平铺 version、receipt 与独立 adopted。

冲突重放的 `current` 是原冲突决定时的快照，`receipt.before` 与之对应；它不冒充重放那一刻最新配置。要再次提交，必须重新读取并核对当前状态，使用新 ID。

### 轻量历史

`GET /settings/runtime/history?limit=20&cursor=...`

- limit 为 1–50，默认 20；entries 包含完整成功回执，便于查看前后差异。
- 按生成版本降序；`nextCursor` 是最后一条已返回版本，下一页使用严格“小于”的边界。cursor 不透明传回；不使用会被新提交挤动的 offset。
- 后续页面不会因新提交而重复已返回记录，也不插入比游标更新的记录。
- 不是长事务快照：翻页期间记录可能因数量或时间清理消失，允许缺页项。读到的每条记录仍是完整回执；游标世代变化返回 409，要求从第一页重新打开。
- 不进行 KEYS/SCAN 或无界列表读取。只有一个文档，最多检查 512 条操作回执与 100 条历史副本。

## 5. 保留、容量与清理

| 数据 | 有效期 | 数量限制 | 过期处理 |
| --- | --- | --- | --- |
| 成功和版本冲突的幂等回执 | 从首次 recordedAt 起 24 小时，截止时刻不再有效 | 最多 512 条活动回执 | 查询立即按时间过滤；下一次可记录的新提交一起物理清理 |
| 成功历史 | 最长 7 天，同时只留最新 100 条 | 100 条 | 查询按时间过滤；下一次可记录提交清理并裁剪 |

- 历史清理不删除 24 小时保证窗口内的 operations 回执；拒绝回执计入 512 条容量，但不进入成功历史。
- 活动回执满额时拒绝新操作：429 CONFIG_RECEIPT_CAPACITY。已有操作的原样重试仍可返回回执。
- 清理是单次写入的一部分，失败不会单独破坏回执。重放、结果查询、历史查询及后台同步全部只读，不回写、不重建配置键。
- 空闲时过期记录可能仍占空间，逻辑上已不可用；物理存储仍不超过 512 个回执和 100 个历史副本。输入文档还有 2 MiB 校验上限。
- 回执时间由 Redis 提供，不依赖各网关的时钟一致。有效期按 Redis 墙上时钟计算，运维需要避免大幅跳时。
- 24 小时后，不再承诺按 ID 找回结果或去重；历史中可能仍有该成功事实，但历史保留不延长已承诺的幂等窗口。客户端不得在窗口外继续盲重试旧 ID，应读当前状态并明确发起新操作。新操作仍经 CAS。
- 删除/驱逐 Redis 键、恢复备份或手工改写文档会破坏这项保留前提。不要给整个权威键设置 TTL；配置权威应避免键驱逐及协议外写入；这不是脚本能补偿的故障。

代价：每次管理读取与后台检查都要解码有界文档，每次新提交重写该文档。适合低频运行参数管理；不面向高频事件日志或大规模配置中心。容量满载的实测开销见验证证据。普通代理请求仍只读本地快照，不读取本回执文档。

## 6. 本地采用与前端流程

原有 AtomicReference 整体发布和版本单调规则保持不变。成功提交响应返回本次存储确认的版本；本实例可能已经采用更高版本，所以 adopted 单独返回。旧回执查询不触发 adopt，旧提交回调通过原有 adopt 规则也不能倒退版本。A 保存成功不代表其他实例已经采用。

前端沿用现有配置布局，增加可复制的操作 ID、“查询本次提交结果”和原提交回执说明：

- 保存创建并保留请求对象与 ID；防止并行重复提交。没有自动换 ID 重发，也没有透明写入重试。
- 不确定时保留草稿和 ID；普通读取不会解除原操作 unknown。认证失效后重新连接，仍保留这些状态。
- 查询成功只更新原操作事实，再独立读取当前配置；读取失败时，仍保留“原提交已成功”，但当前状态继续待核对。
- 查询历史成功不能把 current 回退到 receipt.after；迟到的低版本当前读取也被拒绝覆盖。用户在等待期间的新编辑继续保留。
- 冲突核对不被重新读取清空；明确再次保存生成新 ID 和最新 expectedVersion。
- 查无回执时，只有用户确认“结束确认，保留草稿”，再完成核对，才可决定是否创建新操作。该动作本身不提交。
- 后来查询不可用或回执过期，不会抹去页面此前已经可靠确认的成功事实。
- 草稿和 ID 延续现有的当前标签页内存策略，认证恢复不丢失；离开/刷新有提醒。并未把完整表单或管理凭证写入浏览器持久存储，关闭标签页后的恢复未加入本轮范围。

## 7. 协议迁移与格式回退

schema 2 仍是同一个 String 键、同样的六字段和世代版本协议。

启动恢复规则：

- 缺键：原有启动初始化，版本 UUID:1，空 operations/history。
- 旧六字段 JSON：启动时原子迁移，生成 UUID:1。
- schema 1：仅在启动 init 时迁移，**保留原有版本与全部六字段**，建立空记录集合。无法补造迁移之前的回执。
- schema 2：完整校验后恢复；非法元数据与非法配置一样阻止启动。
- 多个新实例同时 init：Lua 串行化迁移，一次迁移后其余实例读取同一结果。
- 运行期 read/write/sync 不迁移旧数据、不修复坏数据、不重建缺键。后台同步失败仍保留最后有效完整快照；readiness 的原有启动保护保留。

Redis ACL 除原有 GET / SET / EVAL / EVALSHA 权限外，新提交、回执查询及历史查询还需要 TIME；后台 read 分支不需要 TIME。应在切换前核对权限，禁止给业务代理增加配置查询。

上一版本 Lua 严格要求 schema 1 及其字段数，因此面对 schema 2 会拒绝读写和 init，不会无回执更新新文档。旧 HTTP 写入端缺少 ID 会收到 428；它们必须升级。README 示例、前端及 preview、公共脚本请求构造器、配置一致性/同步/P2 验证、路由验证、阶段 B/C 演示、observability 演示和存储维护工具均已检查或适配。专门复现早期缺陷的 baseline/legacy 文件仍用于旧版本，未改造成新协议调用方。

推荐部署：停止所有旧网关/配置写入任务，备份原始键，部署新后端及新调用方，启动首个实例完成迁移，检查当前配置、sync 与 history，再启动其他实例。不要把旧、新写入协议混用当成正常滚动升级保证。

维护工具可执行的**格式回退/灾难恢复**，并不是本轮未实现的“按历史安全回滚”：

```powershell
# 对指定环境操作；先停止所有网关和写入任务。认证仍使用既有 RUNTIME_REDIS_* 环境变量。
node verification/runtime-config-storage.mjs backup --port PORT --key KEY --file FULL-BACKUP.json

# schema 2 -> 上一版 schema 1。新世代防止旧浏览器版本误匹配。
node verification/runtime-config-storage.mjs downgrade-v1 --port PORT --key KEY --file FULL-BACKUP.json --maintenance --acknowledge-receipt-loss

# 若需要更早、无版本的六字段格式，使用 downgrade；同样必须承认回执保证终止。
# 从 schema 2 备份恢复六字段到新世代、空记录集合：
node verification/runtime-config-storage.mjs restore --port PORT --key KEY --file FULL-BACKUP.json --maintenance --acknowledge-receipt-loss
```

工具保留原始完整字节与 SHA-256，禁止覆盖备份；降级要求存储仍与备份相同，替换采用原子比较。schema 2 的恢复或降级未提供 `--acknowledge-receipt-loss` 时拒绝执行。回退会终止已有回执保留承诺，必须处理未决操作并保留原始备份证据；不能向客户端宣称旧 ID 仍受保证。回到新版后，查询旧操作将是 unknown。真正安全的历史配置回滚留待后续，届时应作为新版本提交。

## 8. 独立验证入口与证据

前提：Java 21、Node 24、Docker、已构建后端 JAR/前端 dist，项目既有 Playwright/Edge 验证依赖。使用本机现有工具链可先运行 `. ./.dev/upgrade-tools/env.ps1`。测试镜像固定 Redis 7.4.11 digest。

```powershell
node verification/config-operations-live.mjs
node verification/config-operations-migration.mjs
node verification/config-sync-live.mjs
node verification/config-operations-regression.mjs
```

- live：随机端口、隔离 Redis、两个真实 JVM、按 Redis 帧控制的执行前/执行后回复丢失、HTTP 回复丢失、网关重启、容量/过期/分页、实际浏览器认证/冲突/历史结果确认。写入后才丢弃真实 HTTP 响应，不模拟成功写入。
- migration：真实旧 Lua 拒绝新格式、两种旧格式并发初始化、完整备份、明确承认回执丢失后才允许格式回退。
- sync：只用 B 的本地诊断观察自动采用；独立验证 B 断连、恢复、旧读取晚到、完整快照、真实代理行为和零新增配置查询。
- regression：独立生产预览，复跑原一致性故障矩阵、P2 浏览器核对与配置预览入口，新报告写入独立目录，不覆盖前几轮证据。
- 过期测试通过本轮专属键中的合法记录时间跨过 24 小时/7 天边界，不等待一天，不修改生产脚本时钟。历史翻页间明确提交五笔更新，验证清理造成允许的缺项、没有重复。
- SET 拒绝使用真实 Redis ACL；另一个隔离脚本变体在唯一写入点之前注入错误。反例脚本也实测“SET 后 HSET 类型错误仍保留 SET”，不把并发原子性误称为错误回滚。

本轮实测与清理索引在 [backend-config-operations-validation.json](backend-config-operations-validation.json)，实际结果如下。

### 本轮实际结果

| 验证 | 结果与证据 |
| --- | --- |
| 后端完整 verify | 119 项通过，0 失败、0 错误、0 跳过；[日志](../.dev/config-operations/backend-final.log) |
| 前端测试与生产构建 | 63 项通过；类型检查、生产构建通过；保留原有 ECharts 502.99 kB 分包提示 |
| 新操作故障矩阵 | 12 组通过；[真实 Redis/JVM/浏览器报告](../.dev/config-operations/live-43e978db1d/report.json) |
| 原一致性与前端回归 | 20 组一致性、6 组 P2、16 组配置预览全部通过；[入口结果](../.dev/config-operations/compatibility-cbce5899/report.json) |
| 同步回归 | 10 组通过；[报告](../.dev/config-operations/sync-regression/report.json) |
| 迁移与回退 | 5 组新协议兼容、8 组既有回退检查通过；[新协议迁移报告](../.dev/config-operations/migration-6c1b08f2/report.json) |

具体事实（完整 UUID、时间和响应在上述报告中）：

- 操作 `decf2e27-bb96-4a4d-8c3f-7d4709fc67fc` 的两个实例并发请求基于版本 8，在 `2026-09-27T11:00:23.298Z` 放行，至 `11:00:23.320Z` 都返回版本 9 的同一回执。第二份请求特意改变 JSON 字段顺序并使用 `32.0`，仍识别为同一规范化请求。历史中仅一条该成功操作。
- 当前配置到版本 10 后，查询/重放该操作仍是版本 9，配置与本地采用值保持版本 10。
- 操作 `e8a529df-511e-442d-8c1f-5e40c7f5fb45` 的 Redis 写入回复被扣留，提交端报告 unknown；另一个实例查到原成功版本 12。随后配置到版本 13，重试原 ID 仍返回 12，不覆盖 13。
- 浏览器操作 `f55d1a68-7dfc-41e4-b14c-f59fb4f3297a` 的 HTTP 成功回复被丢弃；跨认证恢复保留 ID 和草稿。查询版本 14 的原回执后，页面当前基准保持版本 15，后续编辑 73 仍保留，查询期间没有额外 PUT。
- 历史已满 100 条时，翻页间新增五笔提交，遍历返回 95 条原范围记录、无重复；被裁出历史的原操作回执仍能确认。
- 512 条活动回执、100 条历史时文档为 497,250 字节；新操作收到容量拒绝，已有操作重放成功。10 次本地 Redis 命令往返约 12.4–17.6 ms，包含连接和客户端开销，不是单纯 Lua CPU 时间，也不是集群压力测试。
- 后台传播首次 1680.7 ms，四波连续更新 2005.2 / 1957.2 / 2001.9 / 1994.8 ms，重启后的下一次传播 1970.5 ms，断连解除后 56.3 ms。932 次仅本地观测均匹配真实提交账本；20 次代理请求加 10 次本地诊断新增配置 Redis 命令为 0。

实际浏览器截图：[桌面回执与当前基准](../.dev/config-operations/live-43e978db1d/old-receipt-current-baseline-1440.png)、[390px 手机](../.dev/config-operations/live-43e978db1d/old-receipt-current-baseline-390.png)。截图使用隔离测试的真实后端数据。

所有最终验证进程正常退出，专属 Redis、故障代理和预览服务已关闭。一次早期验证因测试预览 CORS 来源遗漏而中断，已补齐来源、捕获路由回调错误并显式清理当时的专属环境，之后完整重跑通过；一次旧浏览器用例补上了对保留核对基准的明确确认。失败的验证记录仍保留，没有覆盖前几轮验收证据。

## 9. 一致性边界与剩余取舍

一次成功保存保证：该操作的版本检查被接受，指定权威 Redis 中配置和完整成功回执作为一个文档发布；它不保证所有实例即时采用、磁盘已经同步、未来主从切换不丢失数据，或回执窗口外还能去重。

AtomicReference 解决本实例完整快照与单调采用；Lua 条件写入解决旧表单竞争；operationId 和同文档回执解决有限窗口内的操作归因与重复执行；后台轮询解决其他实例最终采用。四者承担不同职责。

尚未扩展：Redis 重启/故障切换持久性矩阵、大规模实例下满额文档的延迟压测、长期时钟跳变、代理/Redis 之外的基础设施故障、跨标签页草稿持久化、账号级责任归属和历史配置安全回滚。记录以接收实例标识操作来源，不冒充实名审计。

## 10. P2 补验：查询期间明确丢弃

2026-09-27 补充：明确丢弃会清空草稿和操作 ID，并使在途查询及其后续读取失效；认证恢复仍保留草稿。修复、73 项前端测试、9 组专项浏览器检查及 16 组配置页回归见 [P2 修复记录](backend-config-operations-p2-2026-09-27.md)。上文保留原轮次验证结果。

## 11. 后续：安全恢复与 schema 3

本文件保留操作回执轮次的 schema 2 设计和验收证据。新一轮恢复将成功历史作为新版本提交，回执区分 update / rollback 并记录来源，启动迁移保留原操作身份与有效期。当前部署、格式回退及验证请查阅 [运行配置安全回滚](backend-config-rollback.md)。
