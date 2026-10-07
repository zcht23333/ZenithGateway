# 运行配置操作回执独立验收 · 2026-09-27

结论：本轮发现 **1 项 P2，需要修复后补验**。已复跑的后端、幂等、回执查询、容量与保留、迁移及同步检查均通过；本次发现是前端在查询期间离开的状态清理缺口，不涉及已验证的 Redis 原子提交路径。

## P2：确认离开后没有丢弃草稿，迟到回执还会继续更新编辑器

位置：[editor.ts:52](D:/Java/ZenithGateway/frontend/src/settings/editor.ts:52)、[editor.ts:209](D:/Java/ZenithGateway/frontend/src/settings/editor.ts:209)、[leave.ts:16](D:/Java/ZenithGateway/frontend/src/settings/leave.ts:16)。

`confirmSettingsLeave()` 在用户确认“离开将丢弃本页草稿”后调用 `clear()` 并允许导航。但 `clear()` 遇到 `state.querying` 会直接返回，实际没有清空草稿、操作 ID 和基准。`queryOperation()` 也没有检查编辑器是否已经被明确关闭，迟到响应仍更新状态，并调用 `load()`。

确定性复现：

1. 初始令牌补充速率为 20，提交 40；模拟已写入但 HTTP 回复丢失。
2. 将保留的草稿继续编辑为 43，点击“查询本次提交结果”，暂时扣留查询响应。
3. 点击“运行概览”，在“离开将丢弃本页草稿”的确认框中选择确认；导航成功。
4. 放行原成功回执，返回“系统配置”。

实际结果：页面仍保留 **待保存 43、当前 40、原 operationId**，以及未完成的核对状态。编辑器独立复现还记录到：已允许离开后，当前配置读取次数由 1 增至 2，说明迟到回调继续启动读取。没有发生第二次 PUT，因此不应将本问题描述为自动重复写入。

预期：接受“丢弃并离开”后应清空本页编辑状态，并让该次查询的迟到响应失效。返回页面应重新读取当前值，不能重新出现已放弃的 43 或旧操作状态。若选择在查询期间阻止离开，也必须明确阻止导航，不能先承诺丢弃、随后静默保留。

建议修复查询与清空的生命周期：在明确丢弃时使在途查询失效，防止成功、失败和后续读取分支重新更新已清空的编辑器。不能简单地在所有组件卸载时清空，因为认证失效后的草稿与操作 ID 保留仍是已验收行为。

补验应覆盖：查询期间确认离开后再收到成功/失败响应；取消离开仍保留草稿并正常接收查询结果；认证失效后恢复仍保留原操作；确认离开再返回不会出现已丢弃的修改，也不会由旧查询额外发起读取或 PUT。

证据：

- [实际生产页面的浏览器复现记录](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/leave-query-browser.json)：使用明确隔离的 HTTP 场景数据，未修改真实网关。
- [返回配置页的实际截图](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/leave-query-return-1440.png)。
- [真实编辑器与离开确认函数的确定性复现](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/leave-query-repro.json)。
- [浏览器复现脚本](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/leave-query-browser.mjs)、[编辑器复现脚本](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/leave-query-repro.mjs)。在项目根目录用现有 Node 工具链执行。

## 独立复跑结果

| 检查 | 结果 |
| --- | --- |
| 后端完整 verify | 119 项，0 失败、0 错误、0 跳过；打包成功 |
| 前端测试、类型检查及生产构建 | 63 项通过；类型检查与生产构建成功 |
| 操作回执故障矩阵 | 12 组通过，真实 Redis、双 JVM及浏览器 |
| 多实例同步回归 | 10 组通过 |
| 新协议迁移、旧协议拒绝与回执丢失确认 | 5 组通过 |
| 原一致性故障矩阵 | 20 组通过 |
| P2 冲突核对浏览器回归 | 6 组通过 |
| 配置预览及管理页面回归 | 16 组通过 |
| 既有备份与回退工具、版本边界 | 8 组通过 |
| 本次新增离开时序补验 | 编辑器与生产页面均复现上述 P2 |

本次没有用测试数量替代结论：已有导航测试未覆盖“查询回执仍在途”这一时序，因此原测试全绿与本次发现可以同时成立。

已核实的关键事实：

- 两个实例同时提交同 ID、同规范化请求，只产生一个版本递增和一份成功回执。变更请求内容或 expectedVersion 后复用 ID 被拒绝。
- Redis 已执行而回复丢失后，可从另一实例查询原成功；后续版本存在时，重放旧操作仍返回旧回执，不覆盖当前配置。
- 配置、操作回执和有界历史先在内存编码，再由唯一 SET 发布；实际 ACL 拒绝与写入前故障没有留下半份配置或回执。
- 512 条活动回执时拒绝新操作，仍允许原操作重放；历史裁剪和逻辑过期不提前删除保证窗口内回执。满载文档实测为 497,250 字节，读取命令往返约 14.9–19.9 ms，包含客户端与连接开销，不能作为集群吞吐承诺。
- 双实例首次传播 1,628.6 ms，四波更新最长 2,004.0 ms，重启后的下一次传播 1,956.7 ms。本轮健康环境满足 3 秒目标。
- 931 次本地观测都匹配真实提交账本；对 B 的 Redis 配置读取观测为 0。20 次业务代理请求与 10 次本地诊断新增配置查询为 **0**。
- 原冲突比较基准、认证恢复保留草稿、单调采用、损坏配置拒绝及安全的格式回退保护均保持。

## 证据与环境

本轮证据根目录：[config-operations-acceptance-366a3a61](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61)。

主要记录：[后端日志](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/backend.log)、[前端测试](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/frontend-tests.log)、[前端构建](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/frontend-build.log)、[回执矩阵](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/live/report.json)、[同步矩阵](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/sync/report.json)、[迁移](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/migration-report.json)、[回退](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/rollback-report.json)、[原验收入口汇总](D:/Java/ZenithGateway/.dev/config-operations/compatibility-a0428503/report.json)、[本次验收汇总](D:/Java/ZenithGateway/.dev/config-operations-acceptance-366a3a61/summary.json)。

所有验证使用自建 Redis、随机端口、独立 JVM及临时浏览器预览。测试资源已清理；现有开发实例未升级，业务代码未修改，既有验收证据未被覆盖。额外浏览器复现的首次场景数据误将未登录请求视为已认证，导致脚本等待登录框超时；修正隔离场景后成功复现，首次记录保留在本证据目录，该次超时不计为产品缺陷。

本次验收沿用文档的 24 小时幂等窗口、512 条活动回执及 100 条/7 天历史边界，不扩展为 Redis 持久化或故障切换后的永久幂等保证。修复上述 P2 后先提交补验，再进入历史配置安全回滚阶段。
