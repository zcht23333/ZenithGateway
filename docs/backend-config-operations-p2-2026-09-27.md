# 配置回执 P2：明确丢弃后的在途查询失效

日期：2026-09-27。本次仅修复前端查询生命周期；未更改后端、Redis 协议、回执保留策略或已验收的页面布局。

## 问题与修复

验收复现：保存 40 的响应丢失，用户继续编辑为 43，查询原提交期间确认“丢弃草稿并离开”。旧版 `clear()` 遇到 `querying` 提前返回，离开操作却已放行。查询返回后继续更新回执并调用 `load()`，返回页面仍保留 43 和旧操作 ID。

[修复代码](../frontend/src/settings/editor.ts) 将明确丢弃和认证恢复分开处理：

- 明确丢弃：立即清空草稿、操作 ID、回执、核对基准与提示；使查询代次失效并中止网络请求，同时取消在途配置读取。
- 查询返回：成功、失败、`finally` 及后续读取都检查查询代次。即使底层请求忽略取消，旧回调也不能更新状态、触发读取，或清除新查询的忙碌状态。
- 回执已经启动后续读取时丢弃：沿用读取代次保护，迟到读取也不能恢复已清除状态。
- 取消离开：不失效查询，继续保留草稿和原 ID。
- 认证失效：组件卸载仍只取消配置读取，不执行明确丢弃；重新连接后保留草稿和原 ID，用户可继续查询同一次操作。
- 保存仍在进行时继续阻止离开。丢弃页面草稿不撤销服务端可能已经完成的写入，也不发出新的 PUT。

## 验证结果

| 验证 | 本轮结果 | 证据 |
| --- | --- | --- |
| 修复前回归复现 | 新增用例中的成功、unknown、网络失败、401 四种迟到结果均失败，确认清理未发生 | [修复前日志](../.dev/config-operations-p2/tests-before.log) |
| 完整前端测试 | 73 项通过，包含新增 10 项生命周期测试 | [日志](../.dev/config-operations-p2/frontend-tests.log)、[新增测试](../frontend/tests/settings-leave.test.mjs) |
| 生产构建 | 类型检查及 Vite 构建通过；原有 ECharts 502.99 kB 提示仍在 | [日志](../.dev/config-operations-p2/frontend-build.log) |
| 实际浏览器 P2 补验 | Edge 154，9 组通过，页面异常 0 | [请求记录及结果](../.dev/config-operations-p2/browser-1e7e61df/report.json) |
| 原配置页浏览器回归 | 16 组通过，含校验、保存、读取失败、认证恢复、预览隔离、导航和窄屏 | [报告](../.dev/config-operations-p2/settings-regression-788f89fb/browser-validation.json)、[执行与清理](../.dev/config-operations-p2/settings-regression-788f89fb/runner.json) |

浏览器使用本次生产构建、随机端口和独立 HTTP 夹具，未连接真实网关或 Redis。截图中已标注“隔离验证 · HTTP 夹具 · 非真实 Redis”。本次验证证明前端生命周期及网络调用行为；不将夹具中的提交描述为真实 Redis 写入。后端没有改动，本次未重复 119 项后端测试或上一轮 Redis 故障矩阵，原验收证据保留。

### 9 组浏览器检查

1. 查询未返回时确认离开，放行迟到成功，返回显示当前 40，已放弃的 43、旧 ID 与核对状态消失。
2. 同样流程放行迟到 503，返回仍为干净的当前值，无旧错误提示。
3. 同样流程放行迟到 401，取消的请求不使返回页重新进入旧认证错误。
4. 确认离开后在旧响应到达前返回，重新输入 45；迟到响应不覆盖新草稿。
5. 原回执已经返回，但它触发的配置读取尚未完成时确认离开；旧读取不复活状态。
6. 取消离开：保留 43 和原 ID，正常接受回执，当前值 40 与待核对的 43 分开显示。
7. 查询正常收到 401，认证恢复后仍保留 43 和原 ID；再次查询复用同一 ID，未自动提交。
8. 查询期间确认断开管理连接；已明确丢弃的内容在重新连接后不恢复。
9. 390px 手机重复确认离开与返回，当前值 40、差异 0、无旧 ID、无横向溢出。

普通丢弃场景各观察到 **1 次 PUT、1 次回执查询、2 次配置 GET**：初次进入和返回后各一次，旧查询新增 GET 为 0。后续读取已经启动的场景为 3 次 GET，其中第二次被取消；返回仅重新读取一次。认证恢复场景为同一 ID 的 2 次查询、1 次 PUT。完整 operationId、请求顺序和取消结果见 JSON。

测试通过显式 Promise 屏障控制放行顺序；新单元测试限时 5 秒，浏览器等待限时 7 秒，不依靠任意 sleep 竞争窗口。浏览器证明取消请求和导航行为；单元测试特意让客户端忽略 AbortSignal，补验已经无法取消的迟到成功、失败及新旧查询交错。

## 截图与重复执行

- [桌面返回配置页：40，差异 0，无旧操作 ID](../.dev/config-operations-p2/browser-1e7e61df/discard-return-1440.png)
- [390px 返回配置页](../.dev/config-operations-p2/browser-1e7e61df/discard-return-390.png)
- [取消离开：保留 43 与原操作 ID](../.dev/config-operations-p2/browser-1e7e61df/cancel-keeps-draft-1440.png)
- [认证恢复：保留 43 与原操作 ID](../.dev/config-operations-p2/browser-1e7e61df/auth-recovery-keeps-draft-1440.png)

在项目根目录、Node 24 与现有 Playwright/Edge 环境下执行：

```powershell
npm --prefix frontend test
npm --prefix frontend run build
node verification/config-operations-p2.mjs
```

[浏览器补验入口](../verification/config-operations-p2.mjs) 每次使用新的证据目录、随机端口及新浏览器上下文；结束时关闭本轮上下文、浏览器和预览服务。它不访问现有开发实例，不启动 Redis/JVM，不覆盖以前的截图或验收记录。

## 边界

取消网络请求只是停止接收本次查询，不保证服务端停止处理查询，也不会回滚已经保存的 40。跨标签页或浏览器关闭后的草稿恢复仍未加入；认证恢复只保留当前页面内存中的草稿。安全回滚继续留待后续阶段。
