# 运行配置安全回滚

日期：2026-09-27。范围是六字段运行配置；选择一次成功提交完成后的完整快照，经版本检查恢复为新版本。开发实例未执行部署或迁移，本轮写入仅发生在独立测试环境。

## 1. 恢复的含义

当前版本 18，选择来源版本 12，确认后生成 19；六字段取自版本 12 的提交后快照。不会把版本号退回 12，不删除原操作，也不直接修改 Redis 版本。相同参数的恢复仍产生新版本和恢复回执，预览明确提示“六项参数完全一致”。

初始化不是成功提交历史，因此不能假造一条初始化历史供选择。首版只恢复完整六字段，不支持字段级合并，也不恢复令牌桶余额、请求日志、旧监控样本或执行中的请求状态。

实现入口：[原子脚本](../backend/src/main/resources/runtime-config.lua)、[持久化与采用](../backend/src/main/java/com/zch/config/RuntimeConfigPersistence.java)、[来源引用](../backend/src/main/java/com/zch/config/RuntimeConfigSource.java)、[管理接口](../backend/src/main/java/com/zch/config/RuntimeConfigController.java)、[前端状态](../frontend/src/settings/editor.ts)、[历史核对区](../frontend/src/components/SettingsHistory.vue)。

## 2. 接口与来源

所有接口沿用管理 Bearer 认证、启动 readiness 门禁和 `Cache-Control: no-store`。

| 接口 | 行为 |
| --- | --- |
| GET `/settings/runtime/history?limit=20&cursor=...` | 原有成功历史分页；增加 `operationType`，恢复记录还包含 `source` |
| GET `/settings/runtime/rollback-preview?sourceVersion=...&sourceOperationId=...` | 同一次 Redis 脚本读取当前配置和指定历史；返回 `current`、`target`、`source`、`checkedAt`、`noChanges`、`origin: redis-history`，另附响应时本实例 `adopted` |
| PUT `/settings/runtime/rollback` | 按来源引用恢复；必须携带核对时版本和新操作 ID |
| GET `/settings/runtime/operations/{operationId}` | 查询原恢复事实；历史回执不作为当前配置采用 |
| GET `/settings/runtime/adopted`、`/settings/runtime/sync` | 原有纯本地观察接口，不查询 Redis |

恢复请求只接受三个顶层字段：

```json
{
  "operationId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "expectedVersion": "11111111-1111-4111-8111-111111111111:18",
  "source": {
    "version": "11111111-1111-4111-8111-111111111111:12",
    "operationId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
  }
}
```

来源必须同时匹配历史的 `after.version` 和原 `operationId`，且仍在 history 中、未超过 7 天。恢复接口不接受前端传来的六字段，附加这些参数会返回 400。服务端查找的是保留的成功历史，不会因 operations 中仍有一条被裁剪来源的回执，就继续允许新的恢复。

预览是核对依据，不是锁或保留预约。它不写 Redis，也不把历史目标采用为本地配置。`current` 是此次原子读取确认的存储快照；`adopted` 可以不同。提交时重新验证来源与 expectedVersion。

主要结果：

| 响应 | 含义 |
| --- | --- |
| 200 | 本次原始成功回执、新版本有效值、`replayed`、独立的 `adopted` |
| 400 / 428 | 请求或来源格式错误 / 缺少版本或 ID；未进入写入 |
| 409 `CONFIG_VERSION_CONFLICT` | 本次恢复未写入配置；返回决定时的 current、拒绝回执，要求重新核对 |
| 409 `CONFIG_OPERATION_MISMATCH` | 同 ID 绑定了不同类型、来源或预期版本；不改原回执与配置 |
| 410 `CONFIG_HISTORY_UNAVAILABLE` | 新恢复的来源不匹配、过期或被裁剪；此次未写入，不使用客户端缓存继续 |
| 429 `CONFIG_RECEIPT_CAPACITY` | 512 条未过期回执已满；不提前淘汰保证窗口内的回执 |
| 503 `CONFIG_WRITE_UNCONFIRMED` | 未取得可靠写入确认，原操作结果未知；保留 ID 并查询 |
| 503 `CONFIG_ADOPTION_FAILED`，outcome committed | 存储确认已经写入，但本实例采用失败；不把成功改成未知 |

410 等入口拒绝不另建持久回执。该 HTTP 响应是**这次到达请求没有新增写入**的依据；之后按 ID 查不到可用回执仍返回 unknown，不能推出原请求从未执行。版本冲突继续保存可靠的拒绝回执。

## 3. 操作身份与原子决策

普通修改的类型由 PUT `/settings/runtime` 确定为 `update`；恢复的类型由新接口确定为 `rollback`。操作类型是回执和幂等绑定的一部分，不能通过向普通修改请求附加“历史参数”来制造恢复事实。

- 普通修改绑定：类型 + expectedVersion + 规范化六字段。
- 历史恢复绑定：类型 + expectedVersion + source.version + source.operationId。
- 两条历史即使六字段相同，来源不同仍是不同请求。
- 同一次逻辑请求的网络重试使用原 ID 和原内容；更换来源、预期版本或冲突核对后的再次提交必须换 ID。
- 前端结果未知时保留原请求，只提供原操作查询；不会自动换 ID 重发。

在完整权威文档校验成功的前提下，一次 Lua 决策按以下顺序进行：

1. 检查已有且未过期的操作回执。绑定相同则返回原结果；不同则拒绝。
2. 仅对新操作，从当前权威 history 核实来源，取得完整六字段。
3. 检查活动回执容量及 expectedVersion，生成成功或版本冲突事实。
4. 成功时递增当前版本，把来源六字段放入新快照，构造回执及保留策略处理后的历史。
5. **预先编码完整新文档和响应，再执行唯一 SET。** 配置、操作回执和历史一起发布，成功后只返回预先准备的响应。

因此已经成功的恢复在来源后来被裁剪或过期时，仍能在有效回执窗口内返回原成功；不重新做 CAS，也不覆盖后续版本。查到旧成功只证明原操作，不证明当前配置仍是那个版本。非法或损坏的权威文档仍按受控恢复边界拒绝读取，不从其中挑一段记录冒充可靠事实。

Lua 负责并发隔离，单文档 SET 负责共同发布。脚本执行错误不是通用事务回滚；本实现避免配置先写、回执后补的两步窗口。真实验证覆盖唯一 SET 被 ACL 拒绝和 SET 前注入错误，完整文档均不变。参见 [Redis Lua 原子执行](https://redis.io/docs/latest/develop/programmability/eval-intro/) 和 [运行期事务错误的边界](https://redis.io/docs/latest/develop/using-commands/transactions/)。

## 4. 回执与 schema 3

继续使用现有单个 Redis String 权威键，结构为：

```text
{ schemaVersion: 3, version, 六字段,
  operations: { operationId: receipt, ... },
  history: [成功 receipt，版本降序，...] }
```

恢复成功回执包含：

```text
operationType: rollback
operationId, expectedVersion, instanceId, recordedAt, expiresAt
source: {version, operationId, recordedAt}
request: 从来源取得的规范化六字段
before: 决策前的版本和六字段
after: 本次生成的新版本和六字段
status: committed
```

普通修改回执为 `operationType: update`，没有 source。恢复的版本冲突回执也记录类型、来源及目标六字段，status 为 rejected，带 `CONFIG_VERSION_CONFLICT`，没有 after。source 的版本与 ID 是绑定内容；source.recordedAt 是服务端读取并保存的来源时间。

保留策略未变：operations 回执从首次记录起 24 小时，最多 512 条活动记录；history 最多 100 条、最长 7 天。时间来自 Redis TIME。查询按有效期过滤；下一笔可记录提交时物理清理过期项。历史裁剪不删除仍在承诺窗口内的操作回执。

历史仍按严格小于游标版本翻页，新提交不会把后续页向前挤动；过期和清理可能造成缺项，不保证跨页事务快照。列表不自动伪装为实时更新，显示最近查询时间，提供最新记录和较早记录入口。

## 5. 前端操作与生命周期

历史核对区与普通参数编辑区分开。选择历史保留现有草稿；表格显示全部六字段，包括不变项，标注单位、预览时当前版本、来源版本及时间。完整版本和来源 ID 可展开查看、选中复制。

确认恢复需要先勾选已核对，再明确确认。若存在普通草稿，确认框说明：草稿不参与恢复，成功后用确认值替换，失败仍保留。来源选择期间普通保存受保护，关闭历史核对可回到原草稿。

版本冲突保留恢复来源、旧核对依据和普通草稿。重新读取恢复预览后再次勾选确认，才允许生成新 operationId 提交。普通刷新即使取得新版本，也不会自动重绑、重发旧恢复请求。

回执查询只更新原操作事实，再独立读取当前配置；历史回执不回退当前基准。认证失效保留草稿、来源和原请求 ID。明确丢弃会分别失效配置读取、历史加载、来源预览和回执查询，并中止网络请求；所有迟到成功、失败、finally 以及后续读取都受代次检查。取消离开不执行清理，恢复提交仍在进行时继续阻止离开。

实际截图及请求证据见下节；截图中的所有配置请求都到本轮独立真实网关与 Redis。前端生命周期单元测试还特意使用忽略 AbortSignal 的客户端，确保正确性不只依赖网络能否取消。

## 6. 兼容、部署与格式回退

| 旧数据 / 调用方 | 新版行为 |
| --- | --- |
| 无版本六字段 / schema 1 | 仅启动初始化迁移至 schema 3，沿用原版本规则 |
| 合法 schema 2 | 仅启动迁移；保留六字段、世代、序号及全部原回执/历史，为旧普通记录补 operationType:update，不延长有效期 |
| schema 3 | 校验恢复，启动后台同步 |
| 旧 schema 2 实例 | 拒绝新格式的读取、写入和初始化；不能作为混跑升级方案 |
| 普通 HTTP 写入脚本 | 六字段 + expectedVersion + operationId 继续可用；类型由接口确定 |
| 新恢复调用方 | 必须使用来源引用的新接口；不得提交客户端缓存六字段代替服务端查证 |

schema 2 的原操作在迁移后仍能按原 ID、expectedVersion、六字段重放，保持原 recordedAt、expiresAt 和接收实例。多个实例并发初始化只迁移一次，配置版本不递增。新的前端还能读取旧普通回执的形状，但旧服务端没有恢复接口，因此推荐后端、前端和维护脚本一起切换。

部署步骤供后续执行，本轮没有部署到现有开发实例：

1. 停止共享该配置键的全部旧实例及配置写入任务，保留旧包。
2. 使用新版维护工具完整备份原始键，确认备份文件不可覆盖；不要只备份六字段。
3. 部署新后端、前端和脚本。首个实例启动迁移，检查 readiness、schema 3、原回执和本地 adopted 后再启动其他实例。
4. 验证后台 sync，以及一笔正常提交和按 ID 查询。运行期读写不自动迁移旧格式、修复坏数据或重建缺键。

若需要回到上一版 schema 2，使用**离线格式回退**，不是业务上的安全恢复：

```powershell
# 停止所有实例与写入任务后，替换下方实际端口、键及独立备份路径。
node verification/runtime-config-storage.mjs backup --port PORT --key KEY --file FULL-BACKUP.json
node verification/runtime-config-storage.mjs downgrade-v2 --port PORT --key KEY --file FULL-BACKUP.json --maintenance --acknowledge-receipt-loss
```

该命令保留当前六字段，生成新世代 `:1` 和空 operations/history。schema 2 无法忠实表达恢复操作类型与来源，因此不能无声剥掉新字段、宣称原幂等保证仍在。必须明确承认回执保证终止，并永久保留本次完整备份用于人工追溯；原幂等窗口内有待决请求时应先处置。

工具先比较存储是否仍与备份相同，再原子替换；拒绝覆盖备份后的新变化。已有 downgrade / downgrade-v1 同样要求承认回执丢失。restore 从 schema 2/3 备份恢复时产生新世代 schema 3、空记录集合；不是复制旧版本号或旧回执继续保证。完整旧备份的字节、键与 SHA-256 验证规则保持。

## 7. 重复验证入口

前提：Java 21、Node 24、Docker、本项目现有 Edge / Playwright；Redis 固定为 7.4.11 digest。工具链可使用 `. ./.dev/upgrade-tools/env.ps1`。后端集成测试的 `ZENITH_TEST_REDIS_PORT` 必须指向自己新建的独立 Redis，不能沿用开发端口。

```powershell
# Java / Maven 按项目既有方式运行；完整 verify 需上述独立 Redis 端口。
mvn -f backend/pom.xml verify
npm --prefix frontend test
npm --prefix frontend run build

node verification/config-rollback-storage.mjs
node verification/config-rollback-live.mjs
# 串行复跑最终恢复、同步、提交回执、一致性、迁移、格式回退和 P2 浏览器入口：
node verification/config-rollback-regression.mjs
```

- [storage](../verification/config-rollback-storage.mjs)：自建 Redis，10 组原子决策、8 路同 ID 并发、来源过期/裁剪、容量与清理边界、唯一 SET 前/SET 拒绝、schema 2 真脚本兼容及完整格式回退验证。
- [live](../verification/config-rollback-live.mjs)：自建 Redis、随机端口、两个独立 JVM、独立 HTTP 上游和生产浏览器；12 组故障、真实代理行为、截图、认证恢复、迟到响应及重启验证。
- [regression](../verification/config-rollback-regression.mjs)：串行执行旧入口，避免测量收敛时间时多个验证负载互相影响；每次生成新报告，不覆盖旧验收证据。

并发通过公共门闩释放请求；故障按 RESP 命令/回复和真实 HTTP 返回边界触发。前端迟到回调使用明确 Promise 屏障。等待有上限；过期只修改专属测试数据的合法时间，不修改生产时钟。真实 Redis 结果与纯前端夹具回归分开记录。

## 8. 实际证据

本轮完成时间：2026-09-27；以下均为此次构建后的最终验证。构建、报告及源码 SHA-256 索引见 [验证清单](backend-config-rollback-validation.json)。

| 验证层次 | 实际结果 | 证据 |
| --- | --- | --- |
| 后端完整 verify | 125 项通过，0 失败、0 错误、0 跳过；生产 JAR 构建成功 | [日志](../.dev/config-rollback/backend-tests.log) |
| 前端状态与交互单元测试 | 86 项通过，含本轮 13 项恢复/生命周期测试 | [日志](../.dev/config-rollback/frontend-tests.log) |
| 前端生产构建 | 通过；保留既有 ECharts 分块大于 500 kB 的提示 | [日志](../.dev/config-rollback/frontend-build.log) |
| 独立真实 Redis 原子与格式验证 | 10 组通过；包含实际旧 schema 2 Lua | [报告](../.dev/config-rollback/storage-be2a3f4d/report.json) |
| 两个真实网关与生产浏览器 | 12 组通过 | [报告](../.dev/config-rollback/regression-41f7c2f1/rollback-live/report.json) |
| 多实例后台同步回归 | 10 组通过，含仅 B 断连、恢复、旧响应、坏数据、任务关闭 | [报告](../.dev/config-rollback/regression-41f7c2f1/sync/report.json) |
| 提交回执故障回归 | 12 组通过 | [报告](../.dev/config-rollback/regression-41f7c2f1/operations/report.json) |
| 既有一致性 / 冲突基准 P2 / 配置页 | 20 / 6 / 16 组通过 | [入口结果](../.dev/config-operations/compatibility-7b0e2be6/report.json) |
| 旧格式迁移 / 维护格式回退 | 5 / 8 组通过 | [迁移](../.dev/config-operations/migration-2e543ba3/report.json)、[格式回退](../.dev/config-rollback/regression-41f7c2f1/config-consistency-rollback.mjs.log) |
| 上一轮“查询期间丢弃”P2 | 9 组生产浏览器检查通过，包括 390px | [报告](../.dev/config-operations-p2/browser-4d6fbb06/report.json) |

配置页旧回归和上一轮 P2 使用明确标注的隔离 HTTP 夹具，不作为真实 Redis 证据。本轮 live 的历史、预览、PUT 和回执均来自真实网关与 Redis；跳转概览时只用空 SSE 连接夹具避免验证等待持续流。

### 8.1 双实例与业务证据

同一世代 `5264418e-ebfa-4200-899a-371b1e1879eb`：来源版本 **2**，恢复前 **3**，恢复后 **4**；六字段由 `{true, 1, 1, 2, 30, 3}` 完整恢复为 `{false, 20, 40, 1, 10, 1}`，顺序为限流开关、补充速率、桶容量、请求消耗、统计窗口、推送间隔。

恢复 operationId：`5a226691-6376-48c4-b93e-b1c343b5f79a`。A 确认于 **2026-09-27T12:52:39.598Z**；B 最近采用时间 **2026-09-27T12:52:41.561305100Z**，本地诊断观测于 **2026-09-27T12:52:41.622Z**；从客户端取得 A 确认至观测 B 采用为 **2023.756 毫秒**。默认周期 2 秒、单次超时 1 秒；这是一次受控环境测量，不是全环境延迟承诺。

恢复前同一受控业务请求返回 **429**，恢复后返回 **200**。持有一个后台配置读取时发起 20 次代理请求和 10 次纯本地诊断，配置 Redis 命令新增 **0**。B 的验收观察没有调用 `/settings/runtime`：受禁前台读取计数为 **0**。

双实例同 ID 并发都取得同一原回执，只增加一个版本、一条历史。正常修改与恢复竞争相同 expectedVersion 时只有一个成功。B 重启后恢复到后续版本 **15**，仍可查到版本 4 的原恢复回执。

### 8.2 丢失响应与保留边界

- Redis 已执行后丢回复：`1eaefe98-ea08-4f66-90a8-dbd188f496c2` 原请求返回 503 / 结果未知；另一实例查询证明生成版本 **9**。后续版本 **10** 已存在，再次提交原 ID 返回原版本 9，版本 10 不变。
- HTTP 成功回复丢失：`c9394212-c55a-4ea8-bf39-5b6477c729b5` 在真实 Redis 生成版本 **14**，前端进入待确认；认证恢复后按原 ID 查询，当前基准仍是后续版本 **15**，普通新草稿继续保留，自动 PUT 为 **0**。
- 新恢复确认前裁剪来源：返回 410，文档不变；同一来源此前成功的恢复仍由有效回执查询/重放，不再次写入。7 天过期、24 小时回执过期、512 条活动容量、唯一 SET 拒绝和写前失败均在独立真实 Redis 验证。
- 实际浏览器分别扣留历史和预览响应，先取消离开再确认丢弃，返回后新建值 **45**；迟到响应不重开历史、不恢复旧操作、不覆盖新草稿，自动 PUT 为 **0**。忽略 AbortSignal 的单元测试另覆盖迟到 401 与新旧请求交错。

完整请求与 RESP 观察可见 [管理请求](../.dev/config-rollback/regression-41f7c2f1/rollback-live/management-requests.json)、[B 配置命令](../.dev/config-rollback/regression-41f7c2f1/rollback-live/B-redis-frames.json)。

### 8.3 实际浏览器截图

均为隔离真实双实例环境，截图显式标注数据来源；桌面视口宽 1440px，以下为完整页面截图。

| 场景 | 截图 |
| --- | --- |
| 历史选择，现有草稿保持 43 | [查看](../.dev/config-rollback/regression-41f7c2f1/rollback-live/history-selection-1440.png) |
| 当前与来源的全部六字段核对 | [查看](../.dev/config-rollback/regression-41f7c2f1/rollback-live/rollback-differences-1440.png) |
| 真实并发冲突，保留来源、旧预览与草稿 | [查看](../.dev/config-rollback/regression-41f7c2f1/rollback-live/rollback-conflict-1440.png) |
| 重新核对后恢复成功，展示来源和新回执 | [查看](../.dev/config-rollback/regression-41f7c2f1/rollback-live/rollback-success-1440.png) |
| 390px 手机，无参数变化预览 | [查看](../.dev/config-rollback/regression-41f7c2f1/rollback-live/rollback-differences-390.png) |
| 查询旧成功与当前版本分别呈现 | [查看](../.dev/config-rollback/regression-41f7c2f1/rollback-live/rollback-old-receipt-current-1440.png) |

### 8.4 清理与验证修正

最终回归入口全部以 0 退出；A、B、重启 B 正常关闭，专属 Redis 已删除，故障代理、上游、浏览器和预览服务均释放。结束后再次检查，运行容器与本轮验证进程均无残留。原开发实例未升级，前几轮证据未覆盖。

开发中两次先行验证失败保留了记录：一次后端旧断言仍要求 schema 2，已改为当前 schema 3；一次验证脚本按 JSON 属性顺序比较等价回执，改为结构比较。修正后完整重跑通过。首轮真实浏览器截图还促使预览明确标注“预览时当前值”并增加重新核对入口；最终截图和回归均来自这版构建。

## 9. 保证和取舍

一次恢复成功表示：该 operationId 的条件检查在指定权威 Redis 被接受，新的完整配置、回执及历史作为一个文档发布。响应中的主快照属于该恢复；本实例 adopted 单独观察，其他实例通过既有后台同步追上。AtomicReference 保证本地完整发布和单调采用，不替代 Redis 上的并发条件检查。

Redis 回复或 HTTP 回复丢失时，原 ID 的有效回执能够证明原恢复成功，即使当前配置已经有后续更新；仅看当前值相等不能归因原操作。无可用回执、读取不可用或文档损坏时，仍可能无法确认。

24 小时窗口之外不承诺永久去重或结果可恢复。Redis 数据丢失、备份恢复、键驱逐、协议外改写和故障切换仍可能破坏回执保留前提；单次成功响应不等于已经 fsync 或复制到未来主节点。参见 [Redis 持久性边界](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)。

本方案沿用有界文档，新增来源元数据有存储和解析成本；每笔管理提交重写整个文档，适合低频运行配置管理。未引入账号体系、永久提交档案、部分字段恢复、集群强同步、Redis 主从切换保证或历史指标回放。手机将目录和核对区纵向排列，需要滚动；普通草稿单独保留，使页面比仅有参数表更长。
