# ZenithGateway 依赖升级规划：Java 后端／网关与中间件求职方向

规划日期：2026-09-23。实施记录见[升级与验收报告](dependency-upgrade-execution.md)。本文件保留升级前版本、决策依据和验收标准，实际解析版本与结果以实施报告及清单为准。

用户目标：兼顾 Java 后端／网关与中间件岗位的展示价值、真实使用价值和后续维护成本。本轮以“受支持的后端平台 + 可复现构建 + 可核验迁移证据”为主要交付。

**推荐决策**

主线采用 Java 21、Spring Boot 4.1.1、Spring Cloud 2025.1.3、由 BOM 管理的 Gateway 5.0.3；保留 Redis 7.4 主线并更新维护补丁。前端采用 Node 24 LTS、Vite 7.3.6、Vue 3.5、ECharts 6.1.0，优先解决安全和构建兼容性。

求职价值主要来自可解释的工程决策、失败场景和验证结果。版本号是维护能力的基础；性能、可靠性或安全收益均需要独立证据。这里没有引用招聘统计，不将某个版本等同于录用优势。

## 1. 版本目标及取舍

下表“当前”优先采用实际锁定版本。package.json 中的声明范围不等于已安装版本，例如 Vue 已是 3.5.31，TypeScript 已是 5.9.3。

| 范围 | 当前 | 推荐目标 | 目的／取舍 |
| --- | --- | --- | --- |
| Java | 21，已验证环境补丁为 21.0.4 | 21 的供应商维护补丁；保留 release=21 | 维持现有运行与语言基线；记录供应商、补丁和构建号。升级补丁后重建比较基线 |
| Maven | 本机 3.8.1，依赖全局配置 | Maven Wrapper 固定 3.9.16 | 新机器和 CI 使用同一构建版本；校验下载内容，明确镜像配置；消除全局 Maven 安装差异 |
| Spring Boot | 3.2.4 | 4.1.1 | 使用当前受支持的平台，完成自动配置、JSON 和测试设施迁移 |
| Spring Cloud | 2023.0.2 | 2025.1.3 | 与 Boot 成套选择；包含 Gateway 5.0.3 |
| Gateway | 旧 gateway starter，由旧 BOM 管理 | spring-cloud-starter-gateway-server-webflux，版本由 Cloud BOM 管理 | 延续 WebFlux／Netty 路线，核对新 starter 和配置元数据 |
| Jackson | Jackson 2，由旧 Boot 管理 | Jackson 3，由新 Boot BOM 管理 | 把旧 Redis 数据读写兼容作为发布条件 |
| Reactor／Netty／Lettuce／Resilience4j／Micrometer | 由 Boot／Cloud 管理 | 继续由 BOM 管理 | 仅在已确认漏洞或兼容问题时单独覆盖版本，并记录原因、测试与移除条件 |
| Redis | 测试使用 7.4-alpine | 7.4 维护补丁；镜像固定 patch 和 digest | 保留现有 Lua 与故障基线；补丁在实施日核对，开发及测试统一选择 |
| Node.js | 本机 24.14.0，CI 为 24 | 24 LTS 维护版；当前可核对到 24.21.0 | 本地、CI、dev.ps1 和 engines 对齐 |
| Vite／Vue 插件 | 5.4.21／5.2.4 | 7.3.6／6.0.9 | 7.3 仍获重要修复和安全补丁；适合控制本轮前端迁移范围 |
| Vue／Router | 3.5.31／4.6.4 | 3.5.43／保留 4.6.4 | Vue 做维护更新，保持现有路由行为 |
| Pinia | 2.3.1 | 本轮保留，继续监测安全及兼容性 | 当前不是已确认漏洞入口；大版本升级放入后续前端维护批次 |
| TypeScript／vue-tsc | 5.9.3／2.2.12 | 保留 5.9.3／候选 3.3.11 | 校验类型检查工具兼容；采用通过项目 typecheck 的组合 |
| ECharts | 5.6.0 | 6.1.0 | 修复已知问题，验收折线图、tooltip、resize、主题及 SSE 持续更新 |
| Tailwind／PostCSS | 3.4.19／8.5.8 | 保留 3.4.19／8.5.28 | 保持页面样式体系，更新构建链及其传递依赖 |
| @types/node | 22.19.15 | 24.13.6 | 与 Node 24 的开发环境对齐 |

Spring Cloud 官方页面明确支持 Boot 4.1 与 Cloud 2025.1.2 及以上版本，且把 2025.0、2023.0 等旧系列标记为 EOL。本规划已核对 4.1.1 和 2025.1.3 的实际 Maven BOM；Jackson 为 3.1.5、Lettuce 为 7.5.2.RELEASE、Gateway 为 5.0.3。这些传递版本留给 BOM 统一管理。[Spring Cloud 兼容矩阵](https://spring.io/projects/spring-cloud/)；[Boot BOM](https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-dependencies/4.1.1/spring-boot-dependencies-4.1.1.pom)；[Cloud BOM](https://repo.maven.apache.org/maven2/org/springframework/cloud/spring-cloud-dependencies/2025.1.3/spring-cloud-dependencies-2025.1.3.pom)。

Maven 官方已停止维护 3.8 系列，Wrapper 可以固定项目构建工具。Node 24 当前处于 LTS。Redis 官方安全策略当前仍列出 7.4 为受支持系列。[Maven 版本政策](https://maven.apache.org/docs/history.html)；[Maven Wrapper](https://maven.apache.org/tools/wrapper/)；[Node 发布状态](https://nodejs.org/en/about/previous-releases)；[Redis 安全策略](https://github.com/redis/redis/blob/unstable/SECURITY.md)。

前端候选版本和 peerDependencies 已通过 npm 官方元数据核对。Vite 7.3.6 与插件 6.0.9 支持 Node 24；vue-tsc 3.3.11 声明 TypeScript >=5.0。此核对证明声明兼容，项目实际运行仍须验证。[Vite 7.3.6 元数据](https://registry.npmjs.org/vite/7.3.6)；[Vue 插件元数据](https://registry.npmjs.org/@vitejs/plugin-vue/6.0.9)；[vue-tsc 元数据](https://registry.npmjs.org/vue-tsc/3.3.11)。

Vite 7.3 仍获修复支持，而 Vite 8 切换到了 Rolldown／Oxc。本项目的前端承担管理展示，当前测试又使用 Vite 的 ssrLoadModule，因此先选 7.3 可以控制构建和测试加载机制的变动。待该系列支持政策变化或确有构建需求，再计划升级 8。[Vite 支持政策](https://vite.dev/releases)；[Vite 8 迁移说明](https://vite.dev/guide/migration)。

## 2. 实施顺序

### U0：保存可回退的实际工作区基线

- 核对 Git 跟踪情况，基线必须包含当前 backend、frontend、dev.ps1、测试及配置；不能只给不包含当前文件的旧 HEAD 打标签。
- 保存有效依赖树、锁文件、JDK／Node／Maven／Redis 版本和构建产物标识。
- 保留现有 77 项后端、10 项前端测试的覆盖范围，记录当前结果；真实 Redis 测试必须实际执行。
- 补充去敏的旧路由、运行配置、审计 JSON 样本，作为后续版本的兼容性用例。
- 固定一次“旧应用 + 新运行时维护补丁”的比较环境，避免把运行时升级与框架升级的影响混在一起。
- 先加入 Maven Wrapper，再让 CI 与 dev.ps1 调用同一个 Wrapper。凭据继续通过环境配置提供。

交付：基线清单、可复现构建入口、旧数据兼容用例。此阶段展示的是构建和回退的工程能力。

### U1：修补前端依赖链

- 单独更新 PostCSS 和可兼容的传递依赖；重新检查 nanoid、brace-expansion、Browserslist 等实际解析版本。
- 更新 Vue 维护版本及类型检查工具，验证 API／Pinia 测试。
- 单独升级 Vite 7.3.6 与 Vue 插件 6.0.9，验证开发代理、HMR、生产构建和测试模块加载。
- 单独升级 ECharts 6.1.0，进行浏览器实际渲染检查。
- 把 package.json、锁文件、CI Node、@types/node、dev.ps1 的 Node 检查和 README 一并对齐。项目声明 Node 24 主线，具体维护版本在构建清单中固定。

本次只读 audit 结果：全部依赖 9 项告警，排除 dev 后仍有 3 项（ECharts、PostCSS、nanoid）。PostCSS 可经 Vue 编译工具形成依赖链，所以 omit=dev 不是“已证明浏览器会运行漏洞代码”。需核对 bundle 和实际使用方式，逐项记录修复或不适用依据。

ECharts 6.1 包含 tooltip 安全修复；本项目使用的 LineChart 与公告涉及的 lines 系列也应区分，避免夸大当前可利用性。[ECharts 更新说明](https://echarts.apache.org/en/changelog.html)。

交付：新的锁文件、前端回归结果、漏洞处置表、页面／图表检查记录。

### U2：经 3.5 过渡，消除旧 API 和配置依赖

- 升级到实施日核验的 Boot 3.5 维护版与对应 Cloud 2025.0 维护版；阅读中间版本迁移说明，不要求每个中间版本都发布。
- 检查废弃 API、Gateway starter／配置前缀和测试依赖。
- 过渡版本只用于迁移检查点，不作为长期部署终点。
- 此阶段运行编译、核心测试和真实 Redis 集成测试，不重复整套长压测。

Spring 官方建议迁移 Boot 4 前先到最新 3.5，并处理废弃 API。[Boot 4 迁移指南](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)。

交付：可回退的过渡检查点、废弃项处置记录。

### U3：完成 Boot 4.1／Cloud 2025.1 迁移

- 按 Boot 4.0 迁移要求完成 API 与配置适配，再结合 4.1 发布说明收敛到最终组合；每个中间状态做必要回归。
- 更新 Gateway 为 WebFlux starter；保持现有响应式请求链路。
- 迁移 Jackson 使用及注入，重点检查 ObjectMapper 的配置、异常类型、序列化默认值和旧 JSON 读取。Jackson annotations 的包名不能机械地一起替换。
- 核对 RedisProperties 的新模块／包位置，以及拆分后的 WebFlux、Redis 测试 starter；逐项调整测试导入和依赖。
- 验证 Actuator 的端点访问配置、管理凭据和关闭行为，确保 dev.ps1 的健康检查、自检与 Ctrl+C 仍可用。
- 临时配置迁移工具完成诊断后移除，以最终配置实际启动结果验收。

迁移位置：

| 项目位置 | 重点风险 | 必须保留的行为 |
| --- | --- | --- |
| RuntimeConfigPersistence、DynamicRouteService、AuditQueryController、AuditEventPublisher | JSON 序列化与依赖注入变化 | 旧数据可读、API 字段语义一致 |
| RedisAuditBatchWriter | Lettuce 连接、队列、超时与异常行为变化 | 稳定批次 ID、有限重试、无离线重放，未知结果有计数 |
| RequestCompletionRecorder | HttpHandler 装饰器与异常／取消顺序 | 每个代理请求仅记录一次，最终状态准确 |
| AuditEventPublisher 的 SmartLifecycle | 关闭阶段与时限 | 停止接收后有限排空，Redis 关闭顺序正确 |
| dev.ps1、真实 HTTP 集成测试 | Actuator、端口及测试自动配置变化 | 鉴权、SSE、fallback、正常退出可验证 |

参考：[Gateway WebFlux starter](https://docs.spring.io/spring-cloud-gateway/reference/spring-cloud-gateway-server-webflux/starter.html)；[Boot 4 迁移指南](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)；[Boot 4.1 发布说明](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.1-Release-Notes)。

交付：最终候选版本、逐项迁移记录、数据兼容和故障回归结果。

### U4：发布验收与求职展示材料

- Linux CI 跑完整后端测试、真实 Redis 集成测试、前端测试、类型检查和生产构建。
- Windows 本地验证 PowerShell 5.1／7 的 CheckOnly、SmokeTest 和 Ctrl+C 清理；确认已有 Redis 不被误停。
- 浏览器验证管理认证、路由保存与转发、SSE 断线恢复、日志轮询、图表展示。
- 对最终组合执行健康完整链路的重复压测、约 3,000 req/s 的三次五分钟持续负载，以及断连、真实丢响应和正常／强制停机探针。
- 升级前后使用相同运行时、主机、Redis、JVM 参数、流量模型和采样口径；展示中位数、范围、P95/P99、资源占用与完整审计对账。
- 吞吐中位数回退超过 10% 或 P95 增加超过 20% 作为复核线索，先判断波动和原因，再决定是否接受；这些是本规划建议阈值，不是已实现的保证。
- 审计的已知健康负载下 dropped、uncertain 和对账差额为零；故障时容量有界、恢复可用。
- 依赖风险目标是每项有明确处理结论：可修复告警得到修复，尚存项目记录影响范围、处置理由、负责人和复查时间。扫描结果不能替代运行验证。

旧基线为 [第二轮报告](../benchmarks/second-round-2026-09-23.md)：持续负载实际 2984.9～2989.1 req/s，共 2,688,875 条全部确认写入。此数字属于升级前版本，升级后需单独报告；不表述为生产容量或崩溃零丢失。

交付：可一键演示的项目、升级对照报告、依赖处置表、关键技术决策说明、回退说明。升级完成前，简历不能写成已完成 Boot 4 迁移或已取得新的性能收益。

## 3. 更有展示价值的后续增量

升级验收后，优先增加 Micrometer Prometheus 导出、一个网关／审计看板和可验证的告警。当前已有指标，这项增量能展示真实故障定位能力。版本使用 Boot 管理值，抓取认证单独配置，指标标签使用受控维度，避免原始 URI、请求 ID 或客户端 IP 造成高基数。[Spring Boot 指标接入](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)。

真实 Redis 集成测试已有基础。Testcontainers 可以在后续确实需要统一本地与 CI 依赖生命周期时接入，避免仅为列出一个工具而重写现有测试。配置版本／回滚、限流降级等业务优化继续按独立任务推进。

## 4. 本轮范围控制

- Java 21、Redis 7.4 保留主线并更新维护补丁；JDK 25 兼容验证或 Redis 8 能力评估作为后续独立课题。
- Tailwind 4、Router 5、Pinia 新主版本、TypeScript 新主版本根据后续维护政策和功能需求再安排。Tailwind 4 涉及插件、CSS 配置及样式语义变化，本轮保留 3.4 可减少视觉回归。[Tailwind 升级指南](https://tailwindcss.com/docs/upgrade-guide)。
- 保留当前响应式网关架构。虚拟线程开关不能直接证明 Netty 转发性能收益；面试重点解释事件循环、阻塞边界、后台批处理与有界内存。
- 新增中间件由具体问题驱动。跨进程审计恢复、Redis Cluster、配置广播需要独立设计和测试，不并入依赖迁移。
- 选定具体版本后提交锁文件，避免使用浮动镜像作为可复现报告的唯一标识；定期复查支持政策，安全修复以小批次进入 CI。

## 5. 面试中应能展示的证据

| 能力 | 项目证据 |
| --- | --- |
| 平台与依赖治理 | 官方兼容矩阵、BOM 差异、Wrapper、锁文件和风险处置记录 |
| 响应式系统理解 | 请求完成／取消的统计边界、Redis I/O 与后台审计线程的职责 |
| 数据与 API 兼容 | Jackson 迁移前后的旧数据用例及接口契约 |
| 分布式失败语义 | Redis 已提交但响应丢失时如何重试、去重范围与 uncertain 的含义 |
| 性能工程 | 可复现负载、发生器漏发说明、尾延迟、资源上限和对账 |
| 运维实用性 | 一键启动、正常停机、可观察指标、恢复及回退步骤 |

完成后可据实概括为：在 Java 21 响应式网关中完成 Spring 平台升级，保持旧配置与审计数据兼容，并通过真实 Redis 故障注入、请求统计对账和重复压测验证迁移结果。数字只填写最终实际验收数据。
