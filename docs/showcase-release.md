# 求职展示候选版本

本轮将已验收实现、验证入口、文档与可离线复核的关键证据整理为完整候选。公开分支为 `zch/showcase-candidate-20261008`，不合并 main，不升级开发实例。当前原工作区仍保留个人 IDE、未提交改动和历史证据；候选在独立干净副本中提交、构建和验证。

## 范围

- RSS 文档中的“旧代 39→57 MiB”修正为“年轻代 GC 后堆占用 39→57 MiB”，没有重跑实验或更改原始数据。
- README 提供架构、启动、控制台预览与三个案例入口；详细接口说明移入[开发指南](development-guide.md)。
- [三个案例](backend-case-studies.md)覆盖并发与操作确认、限流故障决策、容量与 RSS；取消/排空与 LB 替换保留为补充材料。
- [证据索引](evidence-index.md)随仓库携带约 3.1 MB 无损压缩原始数据与派生摘要；CI 验证哈希及阅读入口，默认不执行容量长测。
- 最初候选沿用已验收业务源码；Linux 发布 CI 实际发现部分响应后的上游 RST 被框架吞掉，已完成[局部修复与旧新对照](showcase-proxy-reset-fix.md)。限流算法、故障策略、配置协议和交接默认值不变。

## 候选冻结与验证

候选以已公开的 `8a654cbcf1c31d9754bfdd2db7f699613ceedfbb` 为基线，纳入后续已验收的容量门禁、命令计数修复、RSS 工具及本轮文档。源码只从明示的项目目录与文件清单复制；排除 `.dev`、work、IDE 本地改动、凭据、node_modules、target、dist。原来的 main 工作区不切换、不重置。

构建使用 Microsoft JDK 21.0.12.1、Node 24.21.0、Maven Wrapper 3.9.16，容器镜像固定摘要。统一验收从干净提交导出全新输入，后端 clean verify、前端 npm ci 和生产构建，再用**同一个新 JAR**串行执行发布矩阵。source-manifest、源码归档、测试报告、JAR/前端哈希和退出清理共同保存。

首个候选为 `82e0f8164f4c77160769893babc3a41555e611b0`。其 [Verify](https://github.com/zcht23333/ZenithGateway/actions/runs/37716588225) 通过，[Release](https://github.com/zcht23333/ZenithGateway/actions/runs/37716588262) 在 Linux 真实代理 RST 场景失败，未达到冻结条件。两份原始 CI ZIP 均已下载并核对 GitHub SHA256，失败未被重试成功覆盖。

本地干净 C1 的后端 259、前端 107、工具 110、监控 183 项及生产构建通过；八组发布入口通过，生命周期入口因路由初始读取预算耗尽失败。独立 Windows 启动脚本 smoke 通过。随后局部修复的后端全量为 263 项，Linux 真实故障 24 组 / 102 请求及 2 项启动拒绝检查通过；同条件旧包复现失败。修复包的本地生命周期补验又遇到 2 CPU 容器启动超过 60 秒，保留该失败，不将它改为通过。

最终候选尚需在同一干净提交完成 Verify 与 Release；下面的性能结论不依赖本次流程是否通过。机器记录与失败原始报告统一归档，最终 CI 完成后再更新本节。

## 如何重新构建并核对身份

```powershell
# 先 checkout 本页记录的候选提交，确保 git status --porcelain 为空
node verification/acceptance.mjs --tier release --out .dev/release-reproduce --images prepare
node verification/showcase-evidence.mjs
node verification/showcase-links.mjs
```

不要给正式候选加 `--allow-dirty`。源码清单、JAR SHA256、各真实入口的 jarSha256、前端文件清单和清理结果必须一致。工作区测试可以另做 dirty 快照，但不能替代干净提交记录。构建可复用下载缓存，不复用编译产物。

## 性能与发布是两个验收维度

**单实例、4 个逻辑 CPU、1 GiB、小 HTTP 响应条件下，1000 req/s 一小时容量窗口通过；长期内存稳定性仍未证明，4000 req/s 一小时未通过。**

这句话绑定 `3f73c65c7c29933549878c570a6b5a8b7bd8bafad2e5333603eee1de089da838` 的历史实验。新候选重新构建后要比较整个 JAR，并可进一步比较 ZIP 内条目；即使解压后代码和资源相同、仅归档时间戳不同，也分别记录哈希，不将小时结果改名为新包实测。原始证据见[索引](evidence-index.md)。

本轮不做新的小时压测、RSS 延长试验、默认参数调优或开发实例迁移。达到可启动、可复验、结论可追溯后停在展示候选验收，下一步进入面试准备。
