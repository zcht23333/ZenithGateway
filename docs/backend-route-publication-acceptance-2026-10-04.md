**路由原子发布独立验收 · 2026-10-04**

验收结论：**暂不通过，1 项 P2 待修复。** 本轮完成源码核对、独立构建、隔离故障验证和浏览器复现。后端路由发布与既有回归通过；路由编辑器在等待保存响应时允许继续输入，成功响应会关闭窗口并丢失这些后续修改。

**P2：保存等待期间的新编辑被成功响应丢弃**

定位：[editor.ts:49](D:/Java/ZenithGateway/frontend/src/routes/editor.ts:49)。提交时复制草稿作为请求体，收到成功响应后在第 51 行直接关闭编辑状态。与此同时，[RouteEditor.vue:53](D:/Java/ZenithGateway/frontend/src/components/RouteEditor.vue:53) 的路径、目标地址、重写及熔断开关仍可编辑；[RouteDispatch.vue:157](D:/Java/ZenithGateway/frontend/src/views/RouteDispatch.vue:157) 也会在刷新后关闭窗口。同一编辑会话内的后续修改没有得到保护。

真实浏览器复现步骤：

1. 在隔离 Redis 和真实网关中新建路径为 `/probe/**` 的路由，把目标从受控上游 V1 改为 V2，点击保存。
2. 等后端实际返回 `201 / committed`，只延迟该真实响应送达浏览器，不伪造保存结果。
3. 窗口仍显示“保存中…”时，在可编辑的 Path 中输入 `/typed-while-saving/**`。
4. 放行成功响应：窗口自动关闭，没有丢弃确认；再次打开，Path 为 `/probe/**`，刚输入的内容消失。

本次只发生 1 次保存 POST。Redis 和真实代理转发与最初提交一致，代理返回 `V2:/probe/proof`。问题在前端草稿生命周期。专项报告 `executionCompleted=true`、`passed=false`，退出码 1 来自预期的草稿保护断言。

证据：[复现脚本](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/draft-during-save-repro.mjs) · [原始结果](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/draft-during-save/report.json) · [保存中输入新路径](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/draft-during-save/during-save-new-draft.png) · [成功后重开丢失草稿](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/draft-during-save/after-ack-reopened-lost-draft.png)。

建议最小修复：保存等待期间禁用所有可修改字段，包括创建时的 ID、路径、目标、重写开关及其参数、熔断开关及其参数。也可以允许继续编辑，但必须区分已提交快照与后续草稿，保留后续修改并继续显示未保存状态；两处关闭逻辑都需处理。成功响应不能把后续修改当作已经保存，也不能自动再次提交。

补验应覆盖：延迟真实成功响应期间的字段与开关；正常成功后的编辑恢复；冲突、结果未知及认证失败后仍保留可核对草稿；原有明确丢弃和迟到响应保护。先修复并补验这一项，再决定本轮通过。

**独立验证结果**

| 验证范围 | 本次结果 | 原始证据 |
| --- | --- | --- |
| 后端 Maven verify | 216 项；失败、错误、跳过均为 0 | [测试统计](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/backend-tests.json)、[构建日志](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/backend.log) |
| 前端测试及生产构建 | 102 项通过，类型检查及构建成功 | [测试日志](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/frontend-test.log)、[构建日志](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/frontend-build.log) |
| 路由隔离实验 | 19 组通过；410 次请求，含轮询 | [报告](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/routes-live/report.json) |
| 路由真实浏览器 | 10 组通过 | [报告](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/routes-browser/report.json) |
| 代理故障回归 | 24 组、102 个请求通过；2 项启动拒绝符合预期 | [报告](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/proxy/report.json) |
| 限流回归 | 22 组、181 个请求通过 | [报告](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/limiter/report.json) |
| 配置与旧路由兼容回归 | 124 项叶子检查通过，未重复计算包装入口 | [总入口报告](D:/Java/ZenithGateway/.dev/proxy-resilience/regression-7792c397/report.json)、[本轮日志](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/compatibility.log) |
| 额外保存中编辑实验 | 已复现 1 项 P2，待修复 | [报告](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/draft-during-save/report.json) |

124 项包括运行配置回滚 12、同步 10、回执操作 12、一致性 20、一致性 P2 6、配置预览 16、操作迁移 5、操作 P2 9、路由预览 14、旧路由真实联调 12、格式回退 8。各叶子报告路径和摘要收录于[机器可读验收摘要](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/acceptance-summary.json)。

本次隔离路由实验的健康传播样本为 950.28 ms，断连恢复样本为 34.51 ms。实验同步间隔 1000 ms、读取预算 750 ms；这些是本批次测量，不构成一般时延保证。采用版本与真实代理上游响应同时核对。后台读取独立隔离时，12 次代理请求及 24 次本地诊断读取新增路由查询为 0；观测路由连接峰值 2、管理等待队列 16。

并发条件写入、旧回复、删除时在途请求、断连恢复、非法/缺失快照、路由构建失败、Redis 及 HTTP 丢回复、真实旧 JAR 格式回退均由隔离入口检查。缺失权威数据时的启动退出码 1 是预期检查结果。

**构建身份、证据保留与资源清理**

重新构建的 JAR SHA-256 为 `6580adaa99dc42be8f4c99c442c9d56fa7302016389d0ece0c9dc87a9318e670`，与提交版本一致。交付索引引用的 41 项产物、210 项源码清单、12 项前端构建清单均匹配。验收开始时记录的 388 个已有文件在验收结束后未变化。

本轮新增验收证据；没有修改产品实现，也没有升级开发实例或执行生产迁移。各隔离入口清理成功；最终额外检查未发现本次已知容器、对应进程或同类测试容器残留。详见[资源核查](D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/cleanup-check.json)。

前端原有约 503 kB 图表分块提示仍存在。本轮未验证 Redis 主从切换、持久化丢失、路由专用连接的完整 TLS/ACL 集成、长期满负载或最大路由规模性能。无路由回执、丢回复保持未知，符合本轮已声明的范围。

**复现入口**

前提是 Docker 可用、前端生产构建已更新，以及仓库现有依赖与本地工具链可用。下列脚本启动自己的真实网关、Redis、上游与浏览器，并自动清理；每次使用新的输出目录保留旧证据。当前版本会以退出码 1 复现问题。修复后原脚本可接受冻结字段或继续保留可见草稿两种方案，其他条件分支仍需相应补验。

```powershell
Set-Location 'D:/Java/ZenithGateway'
$env:JAVA_HOME = 'D:/Java/ZenithGateway/.dev/toolchains/jdk-21.0.12.1+1'
$env:ROUTE_PUBLICATION_OUTPUT = Join-Path 'D:/Java/ZenithGateway/.dev' ('route-draft-recheck-' + [guid]::NewGuid().ToString('N'))
& 'D:/Java/ZenithGateway/.dev/toolchains/node-v24.21.0-win-x64/node.exe' 'D:/Java/ZenithGateway/.dev/route-publication-acceptance-1a10575d51e/draft-during-save-repro.mjs'
```
