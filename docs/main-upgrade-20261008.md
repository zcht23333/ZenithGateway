# ZenithGateway 主线升级 · 2026-10-08

本次将原始 demo 后的完整工程升级纳入 main，保留已验收提交历史。应用实现来自已验收候选 [`f1c6a19`](https://github.com/zcht23333/ZenithGateway/tree/f1c6a19e88e16603d413c07a74b98bb965878482)；主线收尾增加面试材料、只读证据速查、演示文案修正及 main 发布验收触发。

## 升级内容

| 方面 | 交付能力 |
| --- | --- |
| 管理控制台 | 运行趋势、路由调度、配置差异与安全恢复；管理认证、草稿保护和异常恢复 |
| 配置与路由 | 完整快照、原子版本条件发布、后台同步；运行配置操作回执、结果查询、历史及安全回滚 |
| 限流与代理 | Redis 时间令牌桶、有界资源、独立故障策略；超时与熔断、上下游断连和取消的终态分类 |
| 运行保障 | 接流量、停止准入、在途请求与审计排空；按实例区分事实、动作及结果的监控 |
| 验证与交付 | 从干净源码构建、固定产物、两层 CI、十个真实故障入口、失败留存与资源清理记录 |
| 工程展示 | [三个后端案例](backend-case-studies.md)、[407 份可校验证据](evidence-index.md)、[面试介绍](interview-guide.md)、[十分钟演示脚本](interview-demo.md)和[20 个追问](interview-questions.md) |

运行配置回执和路由提交的保证不同：路由本轮没有操作回执，回复丢失仍可能未知。实例异步采用不等于集群同时一致；Redis 持久化丢失和主从切换不在既有幂等保证内。

## 获取与验收

首次使用按 [README](../README.md) 获取 main，再按[启动指南](development-guide.md)准备独立环境。旧运行实例涉及配置与路由格式迁移，分别遵守[配置迁移](backend-config-rollback.md)和[路由迁移](backend-route-publication.md)中的停写、备份与协调升级要求。Git 更新本身不启动或升级开发实例。

main 每次推送触发 [Verify](https://github.com/zcht23333/ZenithGateway/actions/workflows/verify.yml?query=branch%3Amain) 与 [Release acceptance](https://github.com/zcht23333/ZenithGateway/actions/workflows/release-acceptance.yml?query=branch%3Amain)。两项均需核对实际提交、运行结果及归档 `report.json`；本页不将某个历史 CI 结果替代后来提交的结果。完整复验命令见[统一验收](release-acceptance.md)。

已验收候选的 [Verify](https://github.com/zcht23333/ZenithGateway/actions/runs/37725791039) 与 [Release acceptance](https://github.com/zcht23333/ZenithGateway/actions/runs/37725791026) 对应 `f1c6a19`，当时通过 263 项后端、107 项前端、114 项工具测试、183 项监控断言，以及 10 个真实入口／142 项检查。新增证据速查的 4 项测试已纳入工具层，主线工具测试共 118 项。主线构建使用自己的 JAR 哈希；历史功能归档和容量包保留原身份。

```powershell
# 只读历史证据，不启动服务或发送请求
node verification/interview-evidence.mjs
node verification/interview-evidence.mjs --case config --json
node verification/interview-evidence.mjs --case limiter
node verification/interview-evidence.mjs --case capacity
```

演示文案已按实际界面修正：回执直接显示；“存储已确认版本”可以展开。原操作的 `receipt.after.version` 应核对查询响应，不能用后续读取的当前版本替代。十分钟脚本仍需现场排练，文稿与归档读取不构成新的浏览器验收。

## 性能结论保留原边界

**单实例、4 个逻辑 CPU、1 GiB、小 HTTP 响应条件下，1000 req/s 一小时容量窗口通过；长期内存稳定性仍未证明，4000 req/s 一小时未通过。**

这项历史结论仅属于 JAR `3f73c65c7c29933549878c570a6b5a8b7bd8bafad2e5333603eee1de089da838`。主线发布不追加一小时、RSS 干预、完整浏览器或真实负载均衡替换实验；源码相同或测试通过也不会自动迁移容量结论。[RSS 报告](backend-rss-investigation.md)与[候选发布记录](showcase-release.md)保留条件、失败、原始证据及尚未归因的问题。
