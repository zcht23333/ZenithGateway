# 运行配置变更一致性

日期：2026-09-26  
状态：实现完成，独立 Redis 7.4 与浏览器验证通过，待本轮验收。范围为六字段运行配置；前端沿用阶段 B/C 视觉。

## 1. 为什么先做这一轮

方向合理。旧表单覆盖已经在独立真实网关 + Redis 中复现，直接影响管理面的可靠性；完整快照、原子条件写入、结果确认也能为后续多实例同步建立明确基础。此轮没有把运行参数、动态路由和审计存储合并成一个事务系统。

| 实施前问题 | 证据性质 | 实际结果 |
| --- | --- | --- |
| A 保存窗口 30 秒，B 旧表单提交补充速率 40 | **真实旧网关 + 独立 Redis** | B 被接受，Redis 中窗口回到 10 秒 |
| 限流与监控两个 AtomicReference 的组合读取 | **受控 Java 复现**：屏障停在两组更新之间 | 读到新速率 40 + 旧窗口 10，而提交目标为 40 + 30 |
| A 的成功响应属于谁 | **受控 Java 复现**：暂停 A 回调，让 B 完成 | A 提交窗口 30，却返回 B 的 40 |
| Redis 写入后确认丢失 | 实施前为**模拟存储边界**；本轮另有真实 TCP 故障验证 | 旧逻辑中存储 30、本地和 GET 仍为 10 |
| 原有并发测试 | 既有测试覆盖 | 只证明限流单组对象的可见性，不证明六字段和提交版本归属 |

[实施前真实记录](backend-config-consistency-before.json)、[旧逻辑受控复现源码](../verification/legacy/RuntimeConfigLegacyEvidenceTest.java)。该测试源码针对旧接口，故不放入新版 Maven 测试目录。旧包和源码快照保存在本地 `.dev/config-consistency/before.jar`、`before.zip`，不作为生产交付物。

## 2. 三种状态与原子边界

- **存储确认快照**：Lua 执行时 Redis 中的一份完整配置，包含版本与六字段。
- **本实例采用快照**：一个 `AtomicReference<RuntimeConfigSnapshot>`。限流、监控及版本一次发布，响应不会分别拼接两个引用。
- **客户端基准**：最近一次 GET / PUT 返回的存储版本。它不是对整个编辑期间“仍然最新”的承诺。

AtomicReference 解决单进程完整对象的安全发布、跨线程可见性和本地版本不回退。它不能阻止另一个进程或旧表单覆盖 Redis。条件写入解决后者：**比较预期版本、生成下一版本、SET 完整 JSON，全部发生在同一段 Redis Lua 执行中**。

选择 [Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/) 而非 [WATCH / MULTI / EXEC](https://redis.io/docs/latest/develop/using-commands/transactions/)：这里只有一个键和固定六字段，短脚本能在一次常规 EVALSHA 中完成比较和写入；WATCH 需要保持同一连接、处理事务取消和显式重试。两种方案都能实现 CAS，本项目的响应式链路用 Lua 更直接。脚本加载缓存由 Spring Data Redis 管理，首次或缓存丢失时允许 EVAL 回退。

脚本在唯一 SET 之前完成读取、校验和 JSON 编码；已知 SET 拒绝返回 `not-written`。Lua 的原子性不等于事务回滚、磁盘 fsync 或副本持久化保证。脚本保持小型，不放业务 IO、扫描或等待。

代理处理仍使用本地快照，不增加运行配置 Redis 查询。真实测试还区分了限流本来就有的 Redis 命令。一次快照读取一致，不代表所有执行中的请求、限流阶段和统计定时任务在同一纳秒切换；本轮不固定整个请求生命周期的配置版本。

## 3. 版本与存储格式

版本是字符串：`<小写 UUID>:<十进制序号>`。初始化生成新 UUID，序号从 `1` 开始；接受一次 PUT 就递增一次，即使六字段值相同。序号不含前导零，最大为 `9007199254740991`，确保 Redis Lua 的数字运算保持精确。到达上限后拒绝提交，不环绕。

```json
{
  "schemaVersion": 1,
  "version": "11111111-1111-1111-1111-111111111111:2",
  "rateLimitEnabled": true,
  "replenishRate": 20,
  "burstCapacity": 20,
  "requestedTokens": 1,
  "monitorWindowSeconds": 30,
  "emitIntervalSeconds": 1
}
```

仍使用 `zenith.runtime.redis-key`（默认 `zg:runtime:config`），单个 Redis string、完整 JSON、无自动过期。UUID 世代防止删除键、恢复数据后旧客户端版本重新碰巧匹配；不能拿不同世代的序号比较大小。

同一世代只采用相同或更高版本；旧回调被忽略。同版本不同值、运行中更换世代会拒绝采用并显式报错，需要排查存储并受控重启。不能靠手动把 Redis 版本改小来回滚配置。

## 4. 接口约定

所有端点保留管理认证和 readiness 门禁，运行配置响应为 `Cache-Control: no-store`。认证探测改用本地采用状态接口，Redis 读取失败时仍可完成管理认证并查看失败、重试。

| 接口 / 状态 | 返回及含义 |
| --- | --- |
| GET `/settings/runtime` → 200 | 六字段、`version`、`source:"redis"`、`confirmation:"read"`、`adopted:{version,六字段}`。实际读取 Redis，成功验证后尝试单调采用 |
| GET `/settings/runtime/adopted` → 200 | 六字段、`version`、`source:"local"`。仅本实例内存，**不是 Redis 确认** |
| PUT `/settings/runtime` → 200 | 本次 CAS 创建的六字段和版本；`source:"redis"`、`confirmation:"committed"`；另外返回响应形成时的 `adopted` |
| PUT 缺 `expectedVersion` → 428 | `CONFIG_VERSION_REQUIRED`、`outcome:"not-written"`，不兼容绕过版本保护的老写法 |
| 版本格式 / 字段缺失 / 类型 / 范围非法 → 400 | `CONFIG_INVALID_REQUEST`、`field`、`outcome:"not-written"`；不静默补齐或夹取范围 |
| 版本不符 → 409 | `CONFIG_VERSION_CONFLICT`、`outcome:"not-written"`、`expectedVersion`、`current`（CAS 时存储快照）、`adopted` |
| 存储明确拒绝、缺键、非法数据、序号耗尽 → 503 | 分别为 `CONFIG_STORAGE_REJECTED/MISSING/INVALID/EXHAUSTED`；PUT 为 `not-written` |
| 写入确认无法可靠取得 → 503 | `CONFIG_WRITE_UNCONFIRMED`、`outcome:"unknown"`，保留本地已采用值 |
| GET 无法访问 Redis → 503 | `CONFIG_READ_UNAVAILABLE`；附 `adopted` 便于排查，不返回伪装成存储成功的 200 |
| 存储确认后本地无法采用 → 503 | `CONFIG_ADOPTION_FAILED`，含 `confirmed` 与 `adopted`；若本次 PUT 已提交，`outcome:"committed"` |

PUT 必须携带全部六字段及 `expectedVersion`。成功响应中的主快照归属于这一次 CAS，**不会再读取共享内存来替换它**。若响应处理期间另一个提交已采用更高版本，`adopted` 可以比主快照新；客户端先重新读取核对，不能误认旧主快照是实例当前值。

六字段边界保持业务含义：布尔开关；补充速率与容量整数 1–10000；请求消耗 1–100；窗口秒数 1–120；推送间隔秒数 1–5。请求消耗大于容量依旧是可提交但前端说明后果的组合，不新增后端组合约束。

## 5. 丢失确认后可以说什么

| 情况 | 可以确认 | 不能据此声称 |
| --- | --- | --- |
| 400 / 428 / 原子 CAS 冲突 / Redis 明确拒绝 SET | 本次没有写入 | 存储自此不会再变化 |
| 命令在代理执行前被截断 | 测试观察到未执行；网关端只知道缺少确认 | 网关不能从网络错误独自确定执行阶段 |
| Redis 返回成功但 TCP 回复被代理截住 | 测试可对照 Redis 新版本与实例旧版本 | 网关不能把旧内存当成“Redis 未写入” |
| PUT 已完成但 HTTP 返回被截断 | 服务端已提交采用；客户端仍缺少提交确认 | 客户端不能直接把草稿当成成功 |
| 后续 GET 读到与草稿相同值 | 这次读取时存储值与草稿一致 | 原请求一定执行过，或一定是它造成此值 |
| 后续 GET 读到另一个更新 | 当前存储版本和值；本地可收敛到它 | 原请求从未执行，或某个中间版本是谁提交的 |
| 后续 GET 也不可用 | 仅知道上次确认 / 本地采用状态 | 不能解除“无法确认”或自动重发 |

没有加入操作 ID、幂等重放账本或提交历史。`confirmation:"read"` 与 `confirmation:"committed"` 明确区分当前状态确认与这次提交确认。前端“已读取确认”不再被描述成原提交已经被证明成功。

## 6. 前端必要适配

保持浅色参数工作区、深色核对区、六字段验证及移动端核对入口。增加：

1. 提交携带基准版本；可展开并选中复制存储确认版本、本实例采用版本与最近提交的预期版本。
2. 冲突保留用户已改字段，未改字段从 CAS 返回的最新值重建。核对区列出“原基准 → 最新值”和“最新值 → 用户草稿”。例如 B 仅修改速率 40，窗口采用 A 的 30，不把旧窗口 10 带入下一次提交。
3. **先点“已核对，允许再次提交”，再明确保存**；不会自动换版本重发。如果核对后再发生竞争，下一次仍会冲突并重新要求核对。

无法确认、响应结构不完整、认证失效时继续保留草稿。读失败不清除草稿，成功保存后的读失败不撤销已有确认。已收到 committed 但本地采用失败时，分别展示存储与采用快照，恢复读取不会抹去已确认提交的事实。离开、刷新、断开提示和内存中的凭据策略保留。预览新增“版本冲突”场景，完全与管理 API 隔离。

[桌面冲突](images/config-consistency-conflict-1440.png) · [手机冲突完整页](images/config-consistency-conflict-390.png) · [无法确认](images/config-consistency-unconfirmed-1440.png) · [认证恢复后保存](images/config-consistency-confirmed-1440.png)。截图是实际 Edge 浏览器与独立真实后端；标牌说明隔离环境。冲突详情使页面更长，移动端继续通过“查看变更”定位摘要，本轮未重排已验收的页面主体。

## 7. 初始化与升级

| 存储情况 | 处理 |
| --- | --- |
| 启动时键缺失 | 原子初始化为该实例配置绑定得到的完整六字段、随机世代 `:1` |
| 完整合法的无版本旧 JSON | 原子迁移，原六字段不变，增加 schema 和版本 |
| 已有合法新版 JSON | 使用现存版本，不根据 application.yml 覆盖 |
| 多实例同时初始化或迁移 | 首个脚本写入；后续脚本返回同一存储快照 |
| 旧 JSON 缺字段、畸形、字段类型 / 范围错误、未知 schema、错误 Redis 类型 | 启动失败，不自动修正 / 填默认值 / 覆盖原数据 |
| 运行中丢键或格式损坏 | 管理 GET/PUT 明确报错，本地仍是最后确认快照；不在线重新初始化 |
| 运行中世代变化 | 报采用失败；受控恢复并重启，不进行隐式世代切换 |

readiness 继续在配置恢复完成前拒绝业务与管理请求。启动初始化有 5 秒上限，Redis 命令本身还有 3 秒边界；恢复失败使应用启动失败。在线 Redis 故障时保持现有限流 fail-open 等行为，此轮没有新增全局停服策略。

升级顺序：

1. 停止**所有**旧网关及配置写入方；备份 Redis 原 JSON，并保留旧构建产物。不能旧新写入者混跑：旧程序能无条件覆盖并移除版本。
2. 核对旧 JSON 是否有完整六字段且合法。老程序保存的正常记录符合此格式；手工留下的部分 JSON 需要人工确定缺少值，不能把未知值当成默认值静默修复。
3. 同时更新后端、前端及脚本调用方。新版先 GET、展示 / 核对、携带所读版本 PUT；遇 409 停止自动重试。
4. 启动新版，检查 readiness、存储 GET 与本地 adopted。保留迁移前备份。
5. 已迁移的演示 / 验证脚本显式带版本；测试清理时有意恢复独立实例的六字段，会产生新版本，不倒退序号。

## 8. 可执行回退与恢复

工具：[runtime-config-storage.mjs](../verification/runtime-config-storage.mjs)。默认本地 Redis、DB 0，支持 `--host`、`--database`，凭据通过 `RUNTIME_REDIS_USER` / `RUNTIME_REDIS_PASSWORD` 环境变量提供，不打印凭据。

**先停止所有网关与写入方。** 以下参数是操作示例，替换为实际 Redis 端口、数据库、配置键和备份文件；不要在生产运行中执行。

```powershell
node verification/runtime-config-storage.mjs backup --port 6379 --database 0 --key zg:runtime:config --file .dev/runtime-before-rollback.json
node verification/runtime-config-storage.mjs downgrade --port 6379 --database 0 --key zg:runtime:config --file .dev/runtime-before-rollback.json --maintenance
# 核对 Redis 仅剩原六字段后，启动保留的旧后端和匹配的旧前端。
```

backup 使用新文件独占创建并保存原始字节、键、数据库和 SHA-256。downgrade 只允许存储仍与备份完全相同时，以 Lua 原子比较原 JSON 再写旧六字段，拒绝覆盖备份后的新变化。旧程序无法保留并发保护，回退意味着主动放弃新版协议，不能继续使用新版前端。

恢复新版时，同样先停止所有进程：

```powershell
node verification/runtime-config-storage.mjs restore --port 6379 --database 0 --key zg:runtime:config --file .dev/runtime-before-rollback.json --maintenance
# 使用备份六字段创建新世代 :1，然后启动新版并重新读取，旧草稿必须再次核对。
```

restore 验证备份完整性，比较当前原始值（或缺失状态）后原子替换。新世代避免恢复时重用旧版本。操作若丢失网络确认，会明确提示可能已执行；先读存储排查，不能把命令失败当成未写入。此工具处理配置格式 / 值，不恢复路由、审计或 Redis 全库；Redis 错误类型等应先保留证据人工处置。

## 9. 验证与复现

20 组真实后端 / Redis / 浏览器一致性检查通过。完整记录见 [验收 JSON](backend-config-consistency-validation.json)，单元 / 回归汇总见 [检查汇总](backend-config-consistency-checks.json)。

- 后端 `mvn -f backend/pom.xml clean verify`：102 项，0 失败、0 错误、0 跳过，启用独立 Redis 集成测试，包括 readiness、认证、路由、审计和限流回归。
- 前端 51 项测试与生产构建通过；配置 16 组、概览 13 组、路由 10 组浏览器回归通过，另有配置真实后端 6 组回归、版本预览与完整版本复制 2 组检查。现有 ECharts 独立延迟加载块仍有超过 500 kB 的构建提醒。
- 新隔离流程验证同版本顺序提交、12 路并发、24 次存储写入 / 48 次 API 完整快照读取、12 路初始化 / 迁移、非法数据、Redis 明确拒绝、执行前截断、执行后回复截断、HTTP 回复丢失、确认期间又更新、重启、非法配置拒绝启动，以及真实浏览器草稿与认证恢复。
- 新 Lua 原子竞争使用共同门闩释放请求；Java 用屏障 / 可控 Mono 完成顺序。故障代理按 RESP 命令和回复边界触发，不靠任意 sleep 碰撞时序。轮询只用于服务就绪、连接恢复和路由发布。
- 存储 / 回退工具 8 组独立 Redis 检查通过：备份、防覆盖、转旧格式、重新生成世代、备份篡改拒绝、缺键恢复，以及版本最大值精确递增和错误 Redis 类型保护。
- 所有新集成流程只使用随机端口、随机凭据、随机键及专用可销毁 Redis，最后恢复原六字段、停止测试网关、删除测试容器。主开发实例与 Redis 未被这些流程写入。

建议用 Node 24、Java 21、项目 Maven 与 Docker（已有 `redis:7.4-alpine` 镜像）：

```powershell
# 前端预览服务用生产构建，端口与验证脚本一致；另一个终端运行验证。
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run preview -- --host 127.0.0.1 --port 15175
node verification/config-consistency-live.mjs
node verification/config-consistency-rollback.mjs
```

后端完整测试需将 `ZENITH_TEST_REDIS_PORT` 设置为**专用可销毁** Redis 端口，再运行 `mvn -f backend/pom.xml clean verify`。新 live 验证脚本自行建立独立 Redis / 网关；其 Edge 驱动沿用项目本地 `.dev/browser` Playwright 环境。基线复现脚本只针对保存的旧 jar，不能用于验证新版。

## 10. 一致性边界与剩余取舍

- 不承诺所有运行实例即时同步。本实例在启动、管理 GET、成功 PUT 或可解析的冲突回复时采用存储版本；没有后台轮询、发布订阅或通知补偿。后续同步机制可以复用版本和单调采用。
- Redis 单键 CAS 的执行顺序是当前权威边界。正常网关重启与 Redis 回复丢失已分别验证，未逐指令注入 JVM 崩溃。未验证 Redis Cluster、Sentinel 主从切换、磁盘故障和复制回退；AOF / 副本策略需另行设计，不能由一次成功响应推导。
- 没有历史 / 操作标识，读到相同值只能确认当前状态，不能归因原请求。没有把失败请求自动重试成另一个新提交。
- 人工直接 SET、旧写入者或恢复旧 Redis 备份会破坏版本协议；错误和版本差异会尽可能显露，但无法在没有操作历史的条件下检测所有外部回退。需要遵守停写迁移与新世代恢复流程。
- 单进程运行快照不会回退；不同世代的在线自动切换暂不支持。不可用时继续使用本地最后确认快照，运营策略需结合现有 fail-open 和 readiness 边界理解。
- 管理读写各增加一次存储确认往返；代理不增加配置查询。验收记录中的管理延迟是本机独立环境样本，不作为吞吐基准或生产 SLA。
