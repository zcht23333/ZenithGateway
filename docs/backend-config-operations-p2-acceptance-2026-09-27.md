# 配置回执 P2 独立补验 · 2026-09-27

**验收通过，上一轮 P2 已关闭。** 本次复核未发现新的阻塞问题。结合[上一轮后端与操作回执独立验收](D:/Java/ZenithGateway/docs/backend-config-operations-acceptance-2026-09-27.md)，配置提交记录与结果确认这一轮完成验收。

## 修复核对

[明确丢弃](D:/Java/ZenithGateway/frontend/src/settings/editor.ts:51)立即增加查询代次、中止查询、取消配置读取并清空草稿、操作 ID、回执及核对状态。[查询回调](D:/Java/ZenithGateway/frontend/src/settings/editor.ts:194)在成功、失败、finally 和后续读取前检查代次，因此底层即使忽略 AbortSignal，旧查询也不能恢复已丢弃状态，或清除新查询的忙碌状态。

认证失效后的卸载仍仅取消配置读取，不执行明确丢弃。取消导航不失效查询；正在保存时仍阻止离开。现有认证恢复和草稿保留行为保持。

## 独立验证

| 检查 | 结果 |
| --- | --- |
| 完整前端测试 | 73 项通过，0 失败、0 跳过，包含新增 10 项生命周期用例 |
| 类型检查及生产构建 | 通过 |
| 上一轮独立复现步骤 | 修复后的预期全部通过 |
| P2 专项实际浏览器 | 9 组通过，页面异常 0 |
| 原配置页实际浏览器回归 | 16 组通过，页面异常 0 |

上一轮独立复现脚本在新目录中改为断言修复后的预期，旧脚本及旧证据完整保留。本次实际记录：

- 确认丢弃后立即清空草稿与操作 ID，待确认及核对状态清除。
- 放行迟到成功回执后，状态保持清空，配置读取仍只有初次的 1 次，PUT 仍为 1 次。
- 返回并重新读取后显示 **40**，已放弃的 **43** 不再出现；操作 ID 为空，差异 0，无离开保护提示。总计 2 次配置 GET、1 次原 PUT，没有旧回调新增读取或重复提交。

9 组生产页面检查覆盖迟到成功、503、401；先返回并编辑新草稿 45 再收到旧响应；回执已经触发后续读取时丢弃；取消离开；认证恢复；查询期间明确断开；390px 手机确认离开。普通丢弃场景均为初次进入和返回各一次配置 GET、一次原 PUT、一次回执查询。已启动后续读取的场景为 3 次 GET，其中旧读取被取消。认证恢复使用同一 operationId 再次查询，未自动提交。

桌面及手机截图已目视核对：当前值 40、变更摘要 0、旧 ID 消失；手机无横向溢出。取消离开与认证恢复场景保留 43 和原 ID，当前值 40 与待保存草稿仍分开显示。

## 证据

- [73 项测试日志](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/frontend-tests.log)、[类型检查](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/frontend-typecheck.log)、[生产构建](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/frontend-build.log)。
- [原独立复现的补验结果](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/leave-query-repro.json)、[可重复补验脚本](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/original-repro-recheck.mjs)。
- [9 组专项浏览器报告](D:/Java/ZenithGateway/.dev/config-operations-p2/browser-011f3348/report.json)、[16 组原配置页回归](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/settings-regression/browser-validation.json)。
- [桌面返回截图](D:/Java/ZenithGateway/.dev/config-operations-p2/browser-011f3348/discard-return-1440.png)、[390px 返回截图](D:/Java/ZenithGateway/.dev/config-operations-p2/browser-011f3348/discard-return-390.png)。
- [取消离开截图](D:/Java/ZenithGateway/.dev/config-operations-p2/browser-011f3348/cancel-keeps-draft-1440.png)、[认证恢复截图](D:/Java/ZenithGateway/.dev/config-operations-p2/browser-011f3348/auth-recovery-keeps-draft-1440.png)。
- [本次机器可读汇总](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/summary.json)、[回归预览服务清理](D:/Java/ZenithGateway/.dev/config-operations-p2-acceptance-7552ea05/settings-regression/runner.json)。

本次使用实际生产构建和明确标注的隔离 HTTP 夹具，证明前端生命周期与网络调用行为。后端 119 项测试、真实 Redis 幂等和双实例故障矩阵沿用上一轮独立验证，本次未重跑；当前后端 JAR 的 SHA-256 与上一轮相同。原有 ECharts 502.99 kB 分包提示不属于本次新增问题。

临时浏览器、上下文和预览服务均已关闭；随机端口 49552、50132 无残留监听，验收进程已退出。现有开发实例未升级，业务源码未由本次验收修改，旧证据未覆盖。
