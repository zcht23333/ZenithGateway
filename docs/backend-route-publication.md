# 动态路由发布一致性与真实生效确认

本轮范围是普通 HTTP 路由的版本发布、实际匹配、多实例同步和对应管理反馈。路由版本独立于六字段运行参数版本。本轮没有路由历史、业务回滚、灰度、操作回执或自动重试；现有开发实例没有升级。测试原始产物见 [验证索引](backend-route-publication-validation.json)。

## 现状证据与框架接入

修改前归档生产 JAR、源码及 SHA-256，使用两个共享 Hash 的真实进程复现：A 修改为上游 V2 后，B 仍转发至 V1；B 持有旧内容再次保存，可覆盖回 V1。该结果是实际复现，不是仅由源码推断。此前脚本第一次没有真正共享路由键，发现后修正隔离启动参数，并单独保存正确的 `baseline-shared/report.json`。

实际依赖是 Spring Boot 4.1.1、Spring Cloud 2025.1.3、Gateway Server WebFlux 5.0.3。检查了对应依赖源码：

- [GatewayAutoConfiguration](https://github.com/spring-cloud/spring-cloud-gateway/blob/v5.0.3/spring-cloud-gateway-server-webflux/src/main/java/org/springframework/cloud/gateway/config/GatewayAutoConfiguration.java) 默认创建名为 `cachedCompositeRouteLocator` 的主 RouteLocator；该名称已有 Bean 时自动配置退让。
- [CachingRouteLocator](https://github.com/spring-cloud/spring-cloud-gateway/blob/v5.0.3/spring-cloud-gateway-server-webflux/src/main/java/org/springframework/cloud/gateway/route/CachingRouteLocator.java) 对刷新事件启动异步读取，缓存发布没有项目版本条件。因此 Redis 写成功、RefreshRoutesEvent 发布成功、列表读取成功，都不足以绑定实际匹配版本。
- [RoutePredicateHandlerMapping](https://github.com/spring-cloud/spring-cloud-gateway/blob/v5.0.3/spring-cloud-gateway-server-webflux/src/main/java/org/springframework/cloud/gateway/handler/RoutePredicateHandlerMapping.java) 从主 RouteLocator 取路由，并把匹配的 Route 放入请求 exchange；后续转发使用这个对象。

本轮以同名主 RouteLocator 替换默认刷新缓存。`ActiveRoutes` 的一个 AtomicReference 同时保存不可变快照、真正构建好的 Route 列表和采用时间。每次请求匹配订阅只捕获一次该引用。代理请求不读取 Redis。通过真实 RouteDefinitionRouteLocator 及注册的工厂完整构建所有谓词、重写和保护元数据，全部成功才一次替换引用；没有跳过失败条目。继续沿用 Path、RewritePath 和已有 ProxyResilienceFilter 的熔断能力。

每个实际 Route 带 `zenith.route.version` 元数据；真实代理响应提供 `X-Zenith-Route-Version`、`X-Zenith-Instance` 作为匹配证据，不能用列表版本代替。头字段在响应提交前由网关覆盖写入，防止上游同名头混入；真实上游实验也故意返回错误的同名头，核对客户端最终只看到实际匹配版本与实例。未匹配时的 404 没有路由版本头，需结合纯本地诊断验证合法空集合。已经匹配的请求可按旧 Route 完成；边界是获取匹配快照，不是 TCP 建连时间。长连接/在途请求不强制中断。

旧响应在构建前可被跳过，构建结束仍由 AtomicReference 的同世代递增判断阻止回退。同版本不同内容、不同世代均拒绝替换。相同版本重复检查不刷新采用时间。Gateway 的内部启动探查发生在 ApplicationRunner 之前：此时 Locator 暂时返回无条目，**没有发布有效空快照**，业务 ReadinessFilter 仍拒绝请求；只有启动 Redis 读取、校验和完整构建成功之后 Boot 才接受业务流量。首次失败退出，不把失败伪装成空库。

为保证单一权威和避免旧 Route 的过滤器缓存持续增长，启动拒绝配置静态 `spring.cloud.gateway.server.webflux.routes`，也拒绝开启 `route-filter-cache-enabled`。默认关闭该缓存。路由同优先级按 ID 升序匹配；重叠 Path 应由管理员明确核对，不提供新优先级字段。

## 存储格式、版本与发布

`zenith.route.redis-key` 默认 `zg:routes`，现为一个无 TTL 的 String：

```json
{"schemaVersion":1,"version":"92f7b3c9-840a-41ef-9d10-c4d6456b3bb9:1","routes":[]}
```

上例为合法空集合。非空 routes 存放完整、规范化、按 ID 排序的路由对象；空集合严格为 `[]`。伴随无 TTL 的 `<key>:guard` 保存同一 UUID 世代，防止运行中丢失主键后把路由自动初始化为空。版本从 1 开始，上限为 9007199254740991；世代只比较相等，不按随机 UUID 字典序判新旧。版本号耗尽需要受控迁移。运行配置键和版本完全不变。

- 首次两个键均不存在：仅启动 `boot` 模式可在 Lua 中一次 MSET 建立空快照及 guard；双实例冷启动复用一个结果。
- 有 guard、主键丢失：启动和运行期都拒绝；后台从不重建。主键和 guard 都丢失时，下一次启动无法区分灾难性全丢与首次部署，必须依靠备份、持久化和外部部署记录防止误初始化；运行期 `read` 即便两者都丢失也拒绝。
- `false`、`null`、数组代替对象、非规范字段、过大或非法数据：拒绝，不改键，不采用部分条目。
- 合法空路由快照：正常构建、发布和同步，删除全部路由后新请求不再匹配。
- 旧 Hash：明确拒绝启动，提示离线迁移。不会静默忽略坏记录。

整份上限 256 条、UTF-8 JSON 256 KiB。字段上限按 Java String 长度：ID 100，Path 1024，URI 2048，正则 2048，替换 2048，熔断名称 200，兼容降级路径 128；复用原 URI/大小写归一化、正则及保护校验。不可变 Rule 与可变入参脱离。序列化和反序列化都检查上限。

发布顺序：读取并校验完整基准 → 校验 expectedVersion → 生成整份候选 → 完整构建 → Lua 检查世代、expectedVersion 和**基准原始 JSON 字节**仍相同 → 单条 SET 发布新快照 → 使用本次确认的候选进行本地原子采用。深层字段校验和工厂构建在 Java 中完成，原子脚本通过原始字节比较确保决策所依据的状态没有被换掉。HTTP 调用方不能提交任意整份快照或绕过校验；Redis 凭据持有者直接改键不属于受支持写入协议。

选择 Lua 的原因是每次决策集中在一次执行，冲突明确返回，无 WATCH 重试循环。普通发布只有一个 SET，初始化只有一个 MSET；不会先更新一部分路由再因后续命令出错留下半份快照。明确命令拒绝表示未写入；命令执行后回复丢失为未知。此保证是单 Redis 原子执行范围，不是 Redis 故障切换、未落盘崩溃后仍永久保留的保证。

## 管理接口与结果语义

所有接口沿用管理认证，响应禁止缓存。

| 接口 | 语义 |
| --- | --- |
| GET `/settings/routes` | 读取 Redis 完整快照，返回 `source=redis, version, routes, snapshot, instanceId, adoptedVersion, adoption`；**不采用**，不触发后台同步 |
| POST `/settings/routes` | `{expectedVersion, route}`；新增或同 ID 修改；201 为本次存储已确认 |
| DELETE `/settings/routes/{id}` | JSON `{expectedVersion}`；200 为本次存储已确认；不存在为 404，仍保留版本条件 |
| GET `/settings/routes/adopted` | 只读实际匹配快照与采用时间；无 Redis 请求 |
| GET `/settings/routes/diagnostics` | 只读本地版本、观察时间、故障、过期和资源状态；无 Redis 请求 |

成功写入另有 `outcome=committed`，`adoption` 为 `adopted` / `pending` / `newer`。`adopted` 说明响应采样时本实例使用该完整集合；`newer` 仅表示本实例已有更高同世代版本，不能推断原版本曾被本实例使用。`pending` 表示存储已确认但本实例没有采用它。任何值都不表示全体实例同步。

错误：缺少 expectedVersion 为 428；版本冲突 409 附当前完整快照；校验 400；完整构建拒绝 422；管理队列满或 Redis 不可用 503。`outcome=not-written` 仅在本次确定未提交时使用。连接/读取在发送写脚本之前失败可确定未写；写脚本发送后确认未返回为 `unknown`。HTTP 成功响应在传输中丢失也只能由调用方显示未知。没有 operationId / 回执接口，因此无安全自动重试；GET 只能核对当前状态，值相同也不能归因某次提交。用户需读取、比较、明确接受新基准，再主动发起新提交。

前端保持原深色路径画布和底部目录。顶部小条分别显示所读存储版本和本实例版本，详情明确目录与匹配的区别；冲突保留原核对基准、完整草稿、最新存储比较表。重复读取不清空未核对基准。认证失效保留内存草稿；明确丢弃增加生命周期代数并取消请求，迟到响应不能恢复旧草稿或覆盖新草稿。没有自动发布；刷新整个浏览器会丢失内存草稿，沿用离开提醒。预览仍使用明确演示数据。

## 后台同步、故障和资源所有权

启动配置 `zenith.route.publication`：

| 参数 | 默认 | 范围/解释 |
| --- | --- | --- |
| interval-ms | 1000 | 100–60000；每次检查完成后再等待，单实例只有一个同步任务 |
| timeout-ms | 750 | 100–5000；单次 Redis 连接建立＋命令确认的共同预算，使用单调时钟 |
| stale-after-ms | 5000 | 至少 interval + timeout，不超过 600000；距最新成功观察的年龄 |

每实例两条自有 Lettuce 连接通道：管理 1、同步 1；每条最多一个应用命令。同步单线程不排队；管理 1 个工作线程、16 个等待任务，满时明确拒绝且未写入。编译也只在这两个工作线程中进行，不阻塞网关事件循环。Lettuce 禁用自动重连和离线缓冲重放；协议握手请求队列上限 8，应用 EVAL 最多 1/连接。超时关闭连接，关闭尚未完成前不创建替代连接；迟到连接归原持有者关闭。关闭应用停止调度、排空/中断管理任务、关闭连接与自有 Netty 资源。没有逐请求路由键查询。

Redis 不可用、坏数据、权威键丢失或构建失败：继续最后有效路由，诊断 `failed` 或 `stale`；运行期保留业务 readiness，不宣称路由是最新。`lastObservedVersion/At` 是最近通过存储校验的观察，构建失败仍可能观察到新版本；`lastAdoptedAt` 只在实际集合切换时更新。一次一致检查不代表此刻全体一致。诊断不会为刷新状态而访问 Redis。

同世代恢复后下一次周期自动追赶。世代变化保留原集合并提示受控重启；不自行判定新世代优先。健康 Redis、完整一致的工厂配置、低调度争用、正常大小路由快照下目标约 3 秒内传播；不是全局切换事务或硬实时 SLA。构建数量与输入长度有上限，但任意外加自定义工厂没有硬 CPU 超时保证，本轮没有开放自定义工厂接口；默认 Path/RewritePath 构建为本地有限工作。同步间隔按检查完成后计算，CPU 饱和会扩大传播时间。

## 升级、迁移与格式回退

不能混跑旧 Hash 写入端与新 String 协议实例。**先停止所有路由写入口及旧/新网关，再迁移，再协调启动同版实例与页面/脚本**。保留 Redis 自身备份以及当前运行 JAR/配置。下面命令需指定真实端口、库、键；本轮没有在现有开发环境执行。`JAVA_HOME` 为 JDK 21，已打包 backend JAR；密码通过 `ROUTE_REDIS_PASSWORD`，用户通过 `ROUTE_REDIS_USER` 环境变量，别放命令行/证据中。

```powershell
node verification/route-storage.mjs check --host 127.0.0.1 --port 6379 --database 0 --key zg:routes
# 阅读所有条目校验结果；任何非法条目先人工修正或恢复，不静默删除。
node verification/route-storage.mjs migrate --host 127.0.0.1 --port 6379 --key zg:routes --maintenance --backup D:/Backups/routes-before-migration.json
node verification/route-storage.mjs verify --host 127.0.0.1 --port 6379 --key zg:routes
```

`check` 使用与产品相同 Java 校验器；Hash 字段 ID 必须等于对象 ID。`migrate` 先 CREATE_NEW 并 fsync 本地备份，再 Lua 比较原类型、每条原 JSON、条目数和 guard，全相同才单条 MSET 替换。备份目标必须不存在，父目录提前创建。迁移生成新的路由世代；运行参数和限流键不受影响。命令确认丢失时先检查快照、guard、备份，不盲目重试。

启动新 A/B 后，比较本地诊断，并分别向真实目标发请求核对版本头、路径及内容；仅 `verify` 校验文件格式不能证明 Gateway 工厂可构建和转发正确。若需回退二进制，先停全部写入者/网关：

```powershell
node verification/route-storage.mjs rollback --host 127.0.0.1 --port 6379 --key zg:routes --maintenance --backup D:/Backups/routes-before-format-rollback.json
# 校验旧 Hash 与备份，启动归档旧版，在真实请求核对后再开放旧管理入口。
```

工具把**当前**完整快照转换为旧 DTO Hash（不是恢复某个历史业务版本）。先构造专用临时 Hash，再 RENAME；构造失败不改权威键；空集合删除主键，保留 guard。旧二进制忽略 guard，但失去本轮 CAS 和同步能力。再次升级使用 `migrate`；确实是空集合格式回退时须显式添加 `--empty-legacy-confirmed`，不能把运行期丢键当空集合。工具仅支持本项目单 Redis TCP 部署；TLS Redis 的生产维护需先补工具 TLS 接入或通过受控本地隧道，未验证 Redis Cluster/Sentinel。

已更新前端写入口、README、压测/性能分析/生命周期工具，以及配置同步、回执/回滚、概览展示、代理和限流验证调用方。`benchmarks/route-client.mjs` 仅供隔离环境的一次性准备：读取一次版本、发一次请求，无冲突重试；交互编辑器必须持有核对时版本，不能用该辅助函数替换基准。

## 重复验证

```powershell
# 使用已有工程 JDK/工具链，先测试及打包；Redis 测试指向独立实例。
. ./.dev/upgrade-tools/env.ps1
# 设置 ZENITH_TEST_REDIS_PORT 为自建 Redis 随机端口，勿使用开发数据。
& $maven -f backend/pom.xml verify
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
$env:ROUTE_PUBLICATION_OUTPUT = '.dev/route-publication-new-run'
node verification/route-publication-live.mjs
$env:ROUTE_PUBLICATION_OUTPUT = '.dev/route-publication-browser-new-run'
node verification/route-publication-browser.mjs
```

入口要求本机已缓存锁定的 Redis 7.4.11 Alpine 镜像、Node 24、JDK 21；浏览器入口使用项目已有 `.dev/browser` Playwright 和 Edge。随机端口、UUID 键空间、随机测试凭据、自建上游及 Redis，结束关闭进程/服务并删除自己的容器。不要复用输出目录覆盖旧证据。可设置 `ROUTE_BASELINE_JAR` 指向旧版归档，在迁移场景追加旧二进制真实转发验证。

真实矩阵涵盖双实例冷启动及 V1→V2、同版本修改竞争、编辑/删除、删除重建、连续更新、旧读取回复、断连/恢复、坏数据/世代变化/丢键、真实工厂构建失败、合法空集合、在途删除、Redis 和 HTTP 回复丢失、无前台推动的采用、资源饱和/关闭、格式迁移回退。旧构建晚到使用单元测试屏障确定完成顺序；真实环境的工厂失败通过关闭 RewritePath 工厂造成，不用接口夹具假扮。

实际结果、时间、请求明细、Redis 协议帧、进程参数/日志、截图及清理位置由验证索引记录。失败的开发迭代日志亦保留，不能把未通过的首次执行当成最终证据。

## 剩余边界

- 单 Redis 权威的原子性不等于持久性或主从切换永久一致；保护键必须与快照一并备份且不设 TTL。Redis 管理员绕过协议、两键整体丢失、外部恢复为旧备份需停写受控处理。
- 没有路由 operationId/回执；回复丢失无法证明原提交。没有自动重发。不存在本轮承诺之外的安全重试/历史回滚接口。
- 采用是各实例本地原子切换，传播异步；故障保留旧路由可能继续访问管理员希望下线的目标，需结合摘流/网络控制处理紧急撤销。
- 版本头说明匹配选择，不代表上游业务成功、全体实例一致或外部调用无副作用。旧在途请求可继续按旧 Route 完成。
- 本轮未证明超大规模路由性能、集群故障切换、敌意正则执行时间及第三方工厂行为；上限保护内存/队列，不能替代这些独立主题。

## 本轮实际验收记录（2026-10-04）

| 检查 | 实际结果 |
| --- | --- |
| 后端完整测试 / 打包 | 216 项通过；0 失败、0 跳过 |
| 前端测试 / 生产构建 | 102 项通过；保留现有图表大包提示 |
| 独立双实例路由矩阵 | 19 组，410 次实际请求（含轮询与预热） |
| 最终生产页浏览器 | 10 组；冲突、认证、丢弃、后退/前进、迟到响应、待生效、手机与预览隔离 |
| 健康 V1→V2 传播 | 944.5 ms；A/B 真实转发与采用版本交叉核对 |
| B 断连恢复 | 70.2 ms；取样与轮询相位相关，并非最坏情况承诺 |
| 资源与查询 | 连接峰值 2、每连接应用命令最多 1、管理等待队列 16；12 次代理＋24 次本地诊断新增路由查询 0 |
| 原代理故障矩阵 | 24 组、102 个请求通过 |
| 原分布式限流矩阵 | 22 组通过 |
| 旧配置与路由回归 | 同步 10、回执 12、回滚 12；一致性、迁移、配置 P2、设置页、路由预览 14 / 正式页 12 组通过 |
| 压测入口冷启动 | 最短独立冒烟通过；不作吞吐性能比较 |

最终路由、浏览器、代理、限流矩阵绑定同一 JAR SHA-256：`6580adaa99dc42be8f4c99c442c9d56fa7302016389d0ece0c9dc87a9318e670`。其他报告、源码身份与清理记录详见 [验证索引](backend-route-publication-validation.json)。最终复核补充连接诊断的一次引用读取、响应提交前版本头写入，以及保存后迟到刷新不触碰新草稿的保护。

实际截图：[正常桌面](images/route-publication/normal-1440.png)、[手机](images/route-publication/normal-390.png)、[冲突核对](images/route-publication/conflict-1440.png)、[结果未知](images/route-publication/unknown-1440.png)、[存储已更新但本地构建失败](images/route-publication/pending-build-1440.png)、[认证恢复保留草稿](images/route-publication/authentication-draft.png)。来自隔离真实后端，非概念接口夹具。

未执行生产部署、开发实例迁移、Redis 故障切换及持久化丢失验证、完整压测/JFR、全套概览展示录屏。本轮测试容器、网关、上游及浏览器已清理；此前文档与证据未修改，用户已有工作区改动保留。
