# 运行配置一致性：独立验收记录

日期：2026-09-26

结论：核心一致性路径通过复查，本轮仍有两项 P2 回归需要修复，暂不签收。

## 1. P2：现有压测入口无法冷启动

- [runtime-config.lua](D:/Java/ZenithGateway/backend/src/main/resources/runtime-config.lua:24)：限流补充速率、容量上限为 10000，初始化也使用该校验。
- [run.mjs](D:/Java/ZenithGateway/benchmarks/run.mjs:227) 与 [profile.compose.yml](D:/Java/ZenithGateway/benchmarks/profile.compose.yml:17)：仍以 replenish-rate=1000000、burst-capacity=1000000 启动。

在独立 Redis、配置键不存在的条件下，用当前构建产物和这两个既有启动参数启动网关，实际退出码为 1，未进入就绪状态，配置键也未创建。日志包含：

    Unable to restore runtime configuration; refusing startup
    ConfigProblem: 存储配置格式非法或尚未迁移；保留本地快照

影响：已有压测与性能分析入口不能继续使用。已有合法快照可能掩盖此问题，因此需要冷启动检查。

修复要求：统一配置范围与两个压测入口。选择合法压测参数时，确认正常负载不会被意外限流而污染性能结果；保留对非法配置的拒绝。补充使用实际压测参数、空配置键的启动回归。

## 2. P2：冲突未核对时，再次读取会丢掉远端差异

- [editor.ts](D:/Java/ZenithGateway/frontend/src/settings/editor.ts:50)：rebase 每次以刚更新的 current 计算 remoteChanges，覆盖上一次待核对差异。
- [Settings.vue](D:/Java/ZenithGateway/frontend/src/views/Settings.vue:108)：remoteChanges 为空时显示“版本已变化，六个参数的值未变化”。

已在配置编辑器状态测试和连接真实独立后端的 Edge 浏览器中复现：

1. 页面读到窗口 10 秒，本地修改补充速率为 40。
2. 另一个写入者将窗口改为 30 秒。
3. 页面提交收到 409，正确保留草稿并显示“10 → 30”。
4. 尚未点击“已核对”，先点“重新读取”。
5. 远端差异变为空数组，页面错误显示“六个参数的值未变化”；窗口实际仍是 30 秒。

草稿和保存锁仍保留，问题是待核对依据及提示不准确。

修复要求：保留尚未确认的比较基准，以此计算到最新版本的差异；在明确核对、放弃草稿或成功保存后适时重置。补充“冲突 → 重读同版本”和“核对前又有新版本”场景，确认差异信息、草稿与版本校验一致。

## 本次独立验证

- 后端离线 Maven verify：102 项，0 失败、0 错误、0 跳过；独立 Redis 集成测试已启用，构建通过。
- 前端：51 项测试通过，类型检查与生产构建通过。
- 重新执行现有 20 组真实 Redis / 后端 / 浏览器一致性检查。
- 重新执行 8 组备份、回退、恢复及版本边界检查。
- 新增两项针对性探查，复现上述两个缺陷；探查断言通过不代表缺陷消除。
- 已复查 12 个同版本提交只成功 1 个、存储完整快照、回复丢失后的保守确认、重启恢复、冲突草稿、认证恢复以及代理请求不新增配置 Redis 查询。
- 测试值已恢复；临时网关退出码 0，自建 Redis 容器已移除，临时浏览器与预览服务已关闭。
- 本次没有修改业务源码，也没有升级当前开发实例。

原始记录：

- [集成及缺陷复现记录](D:/Java/ZenithGateway/.dev/config-consistency-acceptance-09404bf0/live.json)
- [回退复查记录](D:/Java/ZenithGateway/.dev/config-consistency-acceptance-09404bf0/rollback-validation.json)
- [压测参数启动失败日志](D:/Java/ZenithGateway/.dev/config-consistency-acceptance-09404bf0/backend-live-3.log)
- [再次读取后的错误提示截图](D:/Java/ZenithGateway/.dev/config-consistency-acceptance-09404bf0/config-consistency-reread-bug-1440.png)

补验通过后，再推进多实例配置同步。提交历史、Redis 故障切换保证继续按原约定留待后续设计。
