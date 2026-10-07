**路由发布 P2 独立复验 · 2026-10-04**

结论：**复验通过，关闭“保存等待期间继续编辑导致草稿丢失”的 P2。** 结合[上一轮独立验收](D:/Java/ZenithGateway/docs/backend-route-publication-acceptance-2026-10-04.md)已通过的后端及故障回归，本轮路由原子发布可在已声明范围内验收。上一轮报告和失败证据原样保留。

**实现核对**

[RouteEditor.vue](D:/Java/ZenithGateway/frontend/src/components/RouteEditor.vue) 使用原生 disabled fieldset 包住路由参数；新建 ID、Path、URI、重写开关及参数、熔断开关及参数均处于锁定范围内，包含现有 9 个输入控件。显示“正在保存本次路由，字段暂时锁定”。提交函数另行检查 saving 与 canSubmit，避免 Enter 或重复提交事件产生第二次写入。

源码与上一轮 210 项清单对比，已有文件中只有 RouteEditor.vue、路由前端测试、路由浏览器验证入口发生变化，另新增保存锁定专项入口。editor.ts、RouteDispatch.vue、后端源码和协议保持不变。后端 JAR SHA-256 仍为 `6580adaa99dc42be8f4c99c442c9d56fa7302016389d0ece0c9dc87a9318e670`。本次重新构建的 12 个前端产物均与修复交付索引一致。

**本次独立执行**

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 前端全量测试 | 106 项通过；无失败、取消或跳过 | [日志](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/frontend-test.log) |
| 类型检查及生产构建 | 通过；既有图表分块约 503 kB 提示仍在 | [日志](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/frontend-build.log) |
| 验收方原始复现脚本 | 原脚本未修改，1 项通过，退出码 0，editingFrozen=true，仅 1 次页面保存 POST | [结果](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/original-repro/report.json) |
| 保存锁定专项 | 3 组通过：编辑成功、新建成功、真实校验拒绝 | [结果](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/save-lock-browser/report.json) |
| 路由浏览器回归 | 10 组通过，含草稿、认证恢复、结果未知、明确丢弃与迟到响应 | [结果](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/routes-browser/report.json) |

原始复现脚本内容与上一轮验收时保留的原文逐字一致。所有浏览器检查均使用本次重建的生产页面、隔离 Redis 和真实网关。专项在收到后端实际 201 后延迟送达浏览器，确认 9 个控件保持禁用；普通输入、真实鼠标点击开关、Enter 及重复 submit 都没有改变草稿或增加提交次数。放行响应后重新打开能继续编辑，真实代理响应分别为 V2:/proof 与 V1:/proof，版本匹配。

真实 400 拒绝使用非法 Java 重写正则“[”。响应到达后，原本可编辑的控件全部恢复，草稿仍包含“[”，Redis 版本不变，没有自动重发。既有回归重新断言冲突、结果未知和认证恢复后 Path、URI 及两类开关可编辑，同时发布仍遵守明确读取与核对要求。认证失效分支使用浏览器注入的 401，其他存储、转发、版本冲突和 Redis 丢回复仍走真实隔离后端。

已查看本次[桌面保存锁定](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/save-lock-browser/edit-saving-locked-1440.png)、[手机新建锁定](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/save-lock-browser/create-saving-locked-390.png)及[校验拒绝恢复](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/save-lock-browser/rejected-draft-unlocked-1440.png)截图。390 px 场景未见横向溢出。专项及既有浏览器回归未记录页面运行错误。

**保留与清理**

验收开始记录的 274 个源码、验证与文档文件在结束时哈希保持不变；提交索引核对的 20 项证据、源码及构建身份均一致。本轮只新增独立验收记录与运行证据，没有修改产品实现。

三个隔离运行的网关、Redis、代理、上游、浏览器及页面服务均报告清理成功。独立资源核查确认 3 个本次 Redis 容器已不存在、23 个记录端口无监听、无本次命名空间或输出目录对应的残留进程。开发实例未升级。见[清理核查](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/cleanup-check.json)及[机器可读摘要](D:/Java/ZenithGateway/.dev/route-publication-p2-acceptance-mutgffgj/acceptance-summary.json)。

此次改动限定前端表单保护，后端源码和产物未变化，因此本轮没有重跑后端 216 项、路由隔离 19 组、代理 24 组 / 102 请求、限流 22 组及旧验收 124 项。这些是上一轮已通过的结果，不计入本次执行数。生产迁移、故障切换、长期负载及无路由回执的既有边界保持不变。
