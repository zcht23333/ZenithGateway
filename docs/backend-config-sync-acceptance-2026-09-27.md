# 多实例运行配置同步：独立验收

日期：2026-09-27。

结论：本轮验收通过。在当前约定范围内，没有发现需要阻塞交付的问题。

## 核对结果

- 后台读取在专用调度线程执行，完成后固定等待；应用侧每实例最多一轮同步在途，普通代理请求继续使用本地快照。
- 后台读取复用权威快照校验，本地版本及采用时间一起原子发布；同版本检查不刷新采用时间，旧响应不会覆盖新版。
- 本地诊断接口受管理认证保护并禁止缓存；诊断只读内存，确认时间与采用时间、最近检查结果与过期状态分别表达。
- 同步失败保留最后有效快照；恢复后自动追赶。缺键、坏数据、不同世代和同版本内容冲突均拒绝发布，不自动回写或修复。
- 关闭时取消同步任务并释放连接；前端原有草稿、版本核对及明确提交行为保持有效。

## 本次独立执行

- 后端 Maven verify：113 项测试，0 失败、0 错误、0 跳过，使用独立 Redis，生产 JAR 构建通过。
- 双实例真实 Redis / JVM 检查：10 组通过，覆盖真实限流行为变化、断连、旧响应、连续更新、坏配置、重启和关闭。
- 前端：57 项测试、类型检查、生产构建通过；开启同步后的 6 组真实浏览器回归通过。
- 补充 3 组连接配置检查：ACL 认证与 DB 3、带认证的 URL 指向 DB 5、无数据库路径的 URL 使用 DB 0。均由后台自动采用后续更新，检查只使用本地 sync 接口。

三组补充检查也核对了管理连接与独立同步连接的数据库选择一致性。项目实际依赖的 Spring Boot 字节码及实测结果符合 [Spring Boot Redis 属性说明](https://docs.spring.io/spring-boot/appendix/application-properties/index.html#appendix.application-properties.data.spring.data.redis.url) 的 URL 配置优先规则。

## 收敛实测

| 场景 | 本次独立观测 |
| --- | ---: |
| 首次传播 | 1688.0 ms |
| 连续更新四波 | 1948.3 / 2003.4 / 2009.7 / 2002.1 ms |
| 重启后的后续更新 | 2001.1 ms |
| 解除断连后的恢复 | 101.7 ms |

健康条件下最长样本为 2009.7 ms，达到本轮 3000 ms 目标。观测包含测试轮询时间；这些样本不构成硬实时上界。

B 的观测全程未调用会读取 Redis 的管理配置 GET：禁止调用计数为 0。933 次本地观测的已采用快照均符合真实提交账本；扣留背景读取期间，20 次代理请求和 10 次本地诊断新增运行配置 Redis 命令为 0。

## 清理及范围

本轮自建网关均正常退出，Redis 容器、故障代理、上游、浏览器和预览服务已清理。业务源码未修改，原交付证据保留，现有开发实例未升级。

验收范围是当前独立 Redis 场景下的运行配置后台同步、诊断和故障恢复。管理保存确认仍不代表其他实例即时采用；没有扩展为集群原子切换、Redis 故障切换持久性或大规模实例下的性能保证。原先关闭自动同步的 20 组一致性故障矩阵本轮未重复执行。

## 复核证据

- [后端测试汇总](D:/Java/ZenithGateway/.dev/config-sync-acceptance-018ec8a9/backend-tests.json)
- [本轮复跑汇总](D:/Java/ZenithGateway/.dev/config-sync-acceptance-018ec8a9/summary.json)
- [双实例报告与时间线](D:/Java/ZenithGateway/.dev/config-sync-acceptance-018ec8a9/live/report.json)
- [浏览器回归](D:/Java/ZenithGateway/.dev/config-sync-acceptance-018ec8a9/browser/report.json)
- [认证和数据库配置补充验证](D:/Java/ZenithGateway/.dev/config-sync-acceptance-018ec8a9/connection-matrix/report.json)
