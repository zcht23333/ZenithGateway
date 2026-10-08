# 版本与证据索引

这页区分三个身份：**实际测过的包、重新构建的候选包、记录结果的提交**。同一源码不代表 JAR 字节相同，重新打包也不会自动获得旧性能结论。当前候选的构建与回归见[发布记录](showcase-release.md)。

## 仓库内可离线复核的历史证据

| 材料 | 能说明什么 | 入口 |
| --- | --- | --- |
| 修复包的一小时原始摘要、GC 与全部内存检查点 | 响应版本、逐样本状态、请求/上游/审计对账、RSS/GC/NMT/smaps | [完整压缩清单](evidence/showcase-20261008/manifest.json)中的 capacity-fixed |
| 第二轮原生分配器诊断 | 单次 trim、干预前后类别、自然空闲与之后回升 | 同一清单中的 native-diagnostic；[比较结果](evidence/showcase-20261008/native-comparison.json) |
| 受控计数竞态 | 相同夹具旧 2/2、新 1/1；最终归零 | [旧新包观察](evidence/showcase-20261008/counter-race.json) |
| 便于阅读的阶段摘要 | 计划、流量、延迟、失败维度和内存判据 | [容量摘要](evidence/showcase-20261008/capacity-summary.json) / [分析报告](backend-rss-investigation.md) |
| 图表 | 观察、干预和计量口径分开 | [一小时曲线](figures/rss-investigation-20261007/current-memory.png) / [诊断曲线](figures/rss-investigation-20261007/native-diagnostic.png) |

约 3.1 MB 的压缩包成员来自真实隔离实验，**不是重新生成的接口夹具**。gzip 解压后与历史原始文件逐字节相同，清单同时记录压缩前后大小和 SHA256。三个投影 JSON 明确标记为摘录/派生结果，省略了无关的本机依赖路径。原始元数据里的绝对路径仅作来源记录，复核工具不依赖它们。没有发布凭据、私钥或个人业务请求。

从仓库根目录，Node 24.21.0 即可验证与解压；每个输出目录必须尚不存在：

```powershell
node verification/showcase-evidence.mjs
node verification/showcase-evidence.mjs --extract .dev/evidence-unpacked
node benchmarks/rss-report.mjs .dev/evidence-unpacked/capacity-fixed .dev/capacity-recomputed
node benchmarks/rss-report.mjs .dev/evidence-unpacked/native-diagnostic .dev/native-recomputed
```

绘图可另装 Python 3 + Matplotlib，运行 `python benchmarks/rss-plot.py .dev/capacity-recomputed`。重新分析不发业务流量，不调用 GC/trim。解压器拒绝覆盖、越界路径、重复目标与超限成员；中途失败保留部分新目录供核查。

## 产物对应关系

| 产物 | SHA256 | 结论 |
| --- | --- | --- |
| 原始一小时包 | `aed33ee043618930ffa3a0a45eccab75b95737d6a760e50f66f671f365a24dd1` | 旧样本 3,599,757 次 200；存在后来修复的计数窗口 |
| 计数修复 / RSS 实测包 | `3f73c65c7c29933549878c570a6b5a8b7bd8bafad2e5333603eee1de089da838` | 新的一小时 3,599,568 次 200；命令峰值 8/8；长期内存稳定未证明 |
| 本轮干净源码候选 | 由[候选构建记录](showcase-release.md)和 CI report.json 给出 | 构建、功能与故障回归；不声称重新执行一小时 |

**单实例、4 个逻辑 CPU、1 GiB、小 HTTP 响应条件下，1000 req/s 一小时容量窗口通过；长期内存稳定性仍未证明，4000 req/s 一小时未通过。** 具体还有 32 条路由、无 TLS、非持久化 Redis、监控与审计开启等限制。完整镜像、JVM、资源和各阶段参数在压缩原始摘要中。

原始 JAR 不放入 Git。若 Actions 产物过期，可从对应干净提交重新构建，但必须重新记录哈希；不能称其为原实测包。完整本地归档仍保留，公开材料没有假装所有旧实验都已重跑。

## 当前代码如何复验三个案例

| 案例 | 当前入口 | 证据层次 |
| --- | --- | --- |
| 配置并发、回执、回滚 | `node verification/acceptance.mjs --tier release --out .dev/release-new --images prepare` | config-sync / operations / rollback 的真实 Redis 与独立 JVM |
| 限流故障、资源保护与对账 | 同一 release 入口 | rate-limit / malformed / limiter-policy 的受控真实故障；监控为规则夹具，分开说明 |
| 计数竞态 | 后端全量中的 RedisRateLimiterCommandTest；旧新包对照见 [入口](../verification/limiter-command-counter-race.mjs) | 屏障/回调夹具验证精确时序，不冒充 Redis 负载实验 |
| 容量与 RSS | [固定条件工具](../benchmarks/CONSERVATIVE-CAPACITY.md) | 需要 Docker 提供 16 个逻辑 CPU，显式单独执行；CI 不偷偷运行长测 |

发布层还覆盖路由真实生效、代理故障、取消和退出，详见[范围](release-acceptance.md)。浏览器全矩阵、真实 Grafana 故障链路、容量长测不是所有发布的默认步骤，报告的 notExecuted 必须一起阅读。

## CI 与公开记录

本轮发布的成功和失败记录见[候选证据清单](evidence/showcase-candidate-20261008/manifest.json)：包括 C1 的 Windows / Linux 汇总、原始故障报告、旧新包 Linux RST 对照、263 项后端构建输出、启动失败和启动脚本 smoke，以及 CI ZIP 的官方摘要校验。汇总标注 derived，压缩原始成员保留双 SHA256；读取时必须保留 `passed=false` 和 `notExecuted`，不能把补验通过改写为首轮通过。

```powershell
node verification/showcase-evidence.mjs --manifest docs/evidence/showcase-candidate-20261008/manifest.json
node verification/showcase-evidence.mjs --manifest docs/evidence/showcase-candidate-20261008/manifest.json --extract .dev/candidate-evidence-unpacked
```

- [Verify 工作流](https://github.com/zcht23333/ZenithGateway/actions/workflows/verify.yml)：每次提交的测试、构建及本页证据完整性检查。
- [Release acceptance 工作流](https://github.com/zcht23333/ZenithGateway/actions/workflows/release-acceptance.yml)：候选分支的完整发布矩阵；保留失败和清理报告。
- [已有滚动替换收尾](release-closeout-2026-10-07.md)：历史提交、两份工作流和下载产物的对应，不当作本轮回归。
- [本轮候选记录](showcase-release.md)：实际提交、CI、产物哈希、执行/未执行范围以及可重复构建命令。

Actions 产物保留期有限（Verify 14 天，Release 30 天）；仓库内历史证据不依赖它继续在线。哈希用于确认材料一致，不等于第三方签名或证明所有环境都满足相同性能。

仓库通过 `.gitattributes` 禁止 Git 对 `docs/evidence/` 做文本换行转换。否则 Windows 的 `core.autocrlf=true` 会改变 JSON 字节，导致正确的原始摘要无法通过哈希验证；这个克隆差异已经实际复现。校验不做“忽略换行”等容错，仍要求归档字节精确一致。
