运行配置安全回滚独立验收 · 2026-09-27

**验收通过，本次未发现需要阻断交付的问题。** 已独立核对后端原子协议、前端状态处理和迁移工具，重新运行完整测试、真实 Redis 与双实例故障验证。现有开发实例未升级。

代码核对确认：恢复请求仅携带来源版本、来源操作 ID 和预期当前版本；服务端在同一次 Lua 执行中从保留历史取得六字段、检查版本，并以一次 SET 发布新快照、回执和历史。已有回执的匹配先于历史来源可用性检查，因此历史被裁剪后，原操作仍按原结果重放。来源同时匹配版本与操作 ID；普通修改与历史恢复具有不同的请求绑定。

前端选择历史时保留普通草稿；成功恢复替换草稿前有明确确认。冲突后保留旧核对依据，必须重新读取预览并再次勾选。回执只证明原提交事实，不替代当前配置读取。历史、预览和回执查询的迟到响应已通过取消导航、明确放弃、返回后新草稿及认证恢复检查。

| 独立验证 | 结果 |
| --- | --- |
| 后端完整测试及打包 | 125 项通过，0 失败、0 错误、0 跳过 |
| 前端完整测试 | 86 项通过，0 失败、0 跳过 |
| 前端类型检查、生产构建 | 通过 |
| 回滚真实 Redis 检查 | 10 组通过 |
| 回滚双实例与实际浏览器 | 12 组通过 |
| 本次独立补充边界 | 3 组通过 |
| 双实例同步回归 | 10 组通过 |
| 普通提交回执与故障回归 | 12 组通过 |
| 原配置一致性检查 | 20 组通过 |
| 原冷启动、负载与冲突 P2 检查 | 6 组通过 |
| 原配置页浏览器回归 | 16 组通过 |
| 旧格式迁移、离线回退工具 | 5 组、8 组通过 |
| 上一轮丢弃草稿 P2 浏览器回归 | 9 组通过 |

本次真实业务观测：A 确认恢复后，B 在 **1978.51 毫秒（约 1.98 秒）**后被本地诊断观测到自动采用新版本；采用时间为 2026-09-27T13:14:35.153874300Z。代理响应从 **429 恢复为 200**。保持一个后台同步读取在途时，20 次代理请求与 10 次本地观察新增配置查询为 **0**。这是受控环境中的一次观测，验收仍以实例异步采用的协议边界为准。

另写独立脚本补验了以下三组边界，均使用本轮新建 Redis：

- 已记录的恢复版本冲突，在来源历史被裁剪后仍返回同一拒绝回执；查询和重放均不改写存储。
- 换来源不能复用原拒绝操作 ID；拼接不同历史的版本与操作 ID 不能授权恢复。
- 一次成功的历史恢复也可作为后续恢复来源；再次恢复生成新版本，并准确记录直接来源。

桌面与 390px 实际截图已目视核对。桌面展示完整六字段当前值与目标值；普通草稿另行保留。手机验证无横向溢出，内容仍需纵向滚动。原有 ECharts 分包体积提示保持，未影响生产构建通过。

证据入口：

- [125 项后端测试日志](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/backend.log)、[后端隔离 Redis 清理](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/backend-run.json)。
- [86 项前端测试日志](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/frontend-tests.log)、[类型检查](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/frontend-typecheck.log)、[生产构建](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/frontend-build.log)。
- [10 组回滚存储验证](D:/Java/ZenithGateway/.dev/config-rollback/storage-59640ed3/report.json)、[12 组回滚联调与完整业务证据](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/rollback-live/report.json)。
- [独立补充检查结果](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/independent-edges.json)、[独立检查脚本](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/independent-edges.mjs)。
- [全部旧入口串行回归](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/report.json)、[同步回归](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/sync/report.json)、[提交回执回归](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/operations/report.json)。
- [一致性与原配置页回归入口](D:/Java/ZenithGateway/.dev/config-operations/compatibility-ed0874f9/report.json)、[旧格式迁移](D:/Java/ZenithGateway/.dev/config-operations/migration-c2ef68f4/report.json)、[离线回退工具](D:/Java/ZenithGateway/.dev/config-consistency/rollback-e865cb73-a4d0-4b8f-acd4-949e832da536/rollback-validation.json)。
- [丢弃草稿 P2 回归](D:/Java/ZenithGateway/.dev/config-operations-p2/browser-89c9fed5/report.json)。
- [桌面差异核对](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/rollback-live/rollback-differences-1440.png)、[冲突状态](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/rollback-live/rollback-conflict-1440.png)、[手机](D:/Java/ZenithGateway/.dev/config-rollback/regression-8f94c09c/rollback-live/rollback-differences-390.png)。
- [本次机器可读汇总](D:/Java/ZenithGateway/.dev/config-rollback-acceptance-68098030/summary.json)。

本次构建 JAR 的 SHA-256 为 `7d85e32aa9754e55808faa88f6d9913d3ffc25ea39a25de1f1aae4015694c0e4`。交付索引列出的 26 个源码、验证脚本与文档，以及 10 个构建文件与原截图均与交付 SHA-256 一致。原证据未覆盖，业务源码未由验收修改。

各入口均报告临时 JVM、Redis、代理和浏览器清理完成；另行只读检查未发现相关隔离容器或本轮验收主进程残留。验收确认的是当前实现与声明边界：六字段完整恢复、24 小时幂等窗口、实例异步采用。schema 3 的协调升级仍需按交付文档单独执行；本次未对现有开发实例部署。
