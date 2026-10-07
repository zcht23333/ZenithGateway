# 统一构建与发布验收

两层入口使用同一套计划和报告格式。仅自动化构建、关键功能回归及失败清理，不承担部署，不升级开发实例，不做新的容量定标。

## 两层范围

| 层级 | 执行内容 | 触发 |
|---|---|---|
| commit | 真实 Redis 后端全量测试与构建；前端锁文件安装、测试、生产构建；负载发生器/接流量判定/验收工具测试；Prometheus 规则与实际 Grafana 查询夹具 | 每次 push / pull_request |
| release | 完整 commit 层，再串行运行下列十个真实入口 | 手动 workflow_dispatch 或本地命令 |

发布层：配置同步、配置提交回执、配置安全回滚、路由发布、代理故障、限流可靠性、非法限流数据补验、四种限流故障策略、生命周期功能检查、直接 SIGTERM。计划与各项最大执行时间见 `verification/acceptance-plan.mjs`。单项上限 5 或 7 分钟；构建上限 10 分钟，依赖安装上限 5 分钟。不会并行制造额外 CPU 竞争去误伤三秒传播目标。

配置回执/回滚入口新增 `--backend-only`，只在统一发布层显式使用；独立原入口默认仍包含浏览器部分。报告列出未执行的浏览器/HTTP 回包丢失页面流程，不将它们计为通过。精确取消竞态继续由后端屏障测试验证，真实生命周期链路另行执行。监控检查为 promtool 夹具，不冒称重新运行 Prometheus/Grafana 真实故障链路。

## 使用方式

准备 Node **24.21.0**、Microsoft JDK **21.0.12.1**（JAVA_HOME）、Docker Linux 容器、Git、tar，并将 Node/npm 加入 PATH。Maven wrapper 固定 3.9.16，分发包校验沿用已有 SHA-256。镜像清单固定摘要，`--images prepare` 在使用前明确拉取，空缓存不会依赖先前人工准备；`--images cached` 只适合已有完整缓存的离线补验，缺失即失败。

```powershell
node verification/acceptance.mjs --tier commit --out .dev/acceptance/commit-unique --images prepare
node verification/acceptance.mjs --tier release --out .dev/acceptance/release-unique --images prepare
```

输出目录必须全新，入口拒绝复用，保留每次失败。默认要求 Git 工作区干净；本地有待验收改动时加 `--allow-dirty`，报告会明确记录 dirty、HEAD、工作区状态和实际输入哈希。它不能作为“这个 Git 提交已经发布”的证明，也不会替用户提交、覆盖或清理现有改动。

先导出全新构建目录，排除已有 node_modules、target、dist、本地 .env 和历史实验目录；真实源代码资产与测试资源保留。前端运行 npm ci，后端 clean verify。原工作目录的构建产物和运行实例都不参与验证。可复用本机 Maven/npm 下载缓存，但不会复用编译输出；这不是断网、完全封闭或宿主操作系统全新的构建声明。CI 使用全新托管 runner 和 checkout；本地使用明确记录的工具链与隔离构建目录。

同一轮只构建一份生产 JAR，复制到 artifacts 后冻结身份。每个真实入口必须返回相同 JAR 哈希，各阶段前后再次核对。构建输入也在结束后校验未被测试改写。前端产物按文件记录 SHA-256。Maven 归档时间使用 Git 提交时间以减少时间戳差异，但没有把本轮验证扩展为跨操作系统的逐字节可复现保证。

## 报告与失败语义

- `report.json`：Git 状态、构建输入清单/哈希、工具链、命令与时间、各项 passed/failed/not_run、原始报告引用、产物身份和最终清理。
- `summary.md`：便于阅读的结果摘要；退出码非零不能被某个子报告的 passed 掩盖。
- `source-manifest.json` 与 `artifacts/source.tar`：实际构建输入，可以重建脏工作区验证的源码；归档不含开发凭据和本地编译缓存。
- `artifacts/gateway.jar`、`artifacts/frontend/`：这轮实际验证的产物。
- `logs/`、`checks/`：完整失败输出、Surefire XML、指标/Redis/请求/审计及清理证据。不同层次的测试数量分开列出，不将断言数与请求数相加。

任一依赖步骤失败后，其余步骤标为 not_run，不自动重试故障实验，也不删掉失败再汇报成功。缺少子报告、零实际检查、产物哈希不符、未确认进程退出或关键清理字段缺失均判失败。后端、前端和工具测试不允许以跳过用例冒充全量通过。

两个 CI 工作流均在成功/失败后保存报告与必要产物：提交层保留 14 天，发布层 30 天。使用 [upload-artifact 官方接口](https://github.com/actions/upload-artifact)，原有 Java 下载校验与 Node 版本保持不变。远端 Actions 是否成功以实际 workflow 运行结果为准，本地运行不能替代它。

## 资源归属和中断

每轮生成随机 scope，容器/网络创建附上 `zenith.acceptance` 标签；真实验证 JVM 附上唯一标记，进程账本写入 owned-java.jsonl。清理只查找这个 scope，不做全局 prune，不按 Docker 前后差异删除其他用户资源。旧入口未由统一工具调用时不改变其默认资源操作。

正常单项结束后，既要检查它的清理报告，也检查 scope 下是否仍有存活资源。发现残留则本轮失败，最后只清理确认属于本轮的资源。子进程日志直接写文件，等待有界；超时先结束本轮进程树/进程组，再处理本轮标记的网关和 Docker 资源。强制清理会记录，不把它改成一次正常通过。

发生器的资源阈值、代理/限流策略、结果交接默认值均沿用原实现。本轮未执行真实负载均衡器的摘除传播、容量一小时或 RSS 专项。**4000 req/s 一小时未通过，目前没有已通过一小时验证的健康容量档位。**

可对报告和最后清理路径进行显式故障演练（故意返回非零，输出不能用于发布）：

```powershell
node verification/acceptance.mjs --tier commit --out .dev/acceptance/fail-unique --images prepare --self-test-failure exit
node verification/acceptance.mjs --tier commit --out .dev/acceptance/timeout-unique --images prepare --self-test-failure timeout
```

这两种模式在本轮 Redis 已创建后分别触发子进程失败/超时，用于检查失败日志、后续 not_run 和 finally 清理。SIGKILL、宿主机崩溃、Docker 控制面失联不能保证 JavaScript finally 执行；最后一份阶段报告与 scope 标签用于后续核对，独占临时 CI runner 的销毁是最后边界。共享开发机不应硬杀后就假定资源已清理。

## 本轮验证记录

2026-10-06 的最终入口从全新构建目录执行完成，耗时 **809.884 秒**。使用当前未提交工作区的显式 `--allow-dirty` 快照；这不是某个干净 Git 提交已经通过远端 CI 的声明。未创建 Git 提交，未升级开发实例。

| 验证 | 最终结果 |
|---|---|
| 后端全量测试及真实 Redis 集成 | 252 项；失败、错误、跳过均为 0 |
| 前端测试及生产构建 | 107 项；npm ci、生产构建通过 |
| 负载工具、接流量判定、验收工具测试 | 37 项，其中本轮验收工具 15 项 |
| Prometheus 规则与实际面板查询夹具 | 86 + 97 = 183 项断言 |
| 两份 CI 工作流 | YAML 语法解析通过；远端 Actions 未执行 |
| 发布层真实入口 | 10 个入口、142 项检查；同一 JAR |

| 真实入口 | 检查数 | 子进程执行时间 |
|---|---:|---:|
| config-sync | 10 | 91.87 秒 |
| config-operations | 11 | 48.97 秒 |
| config-rollback | 9 | 49.77 秒 |
| route-publication | 19 | 113.00 秒 |
| proxy-resilience | 24 | 77.79 秒 |
| rate-limit | 22 | 45.46 秒 |
| rate-limit-malformed | 17 | 14.23 秒 |
| limiter-policy | 25 | 108.19 秒 |
| lifecycle-functional | 4 | 114.73 秒 |
| lifecycle-signal | 1 | 31.70 秒 |

不同层级的测试数、断言数、实验检查数分别统计，不相加为“总测试数”。真实入口下的原始 HTTP、Redis、审计、诊断和退出日志保存在各 `checks/<入口>/` 内。

- Git HEAD：`8dded422930d93a0810e4641e51e6f327fad62d6`，`dirty=true`。
- 实际构建输入 SHA-256：`7564f0a36bfe85f519c41e8e4fe1811c1258e87cd984664f67d4dc50141713a5`。
- 冻结 JAR SHA-256：`80698cf553c1f5176a8f1086d6e78cc7c4021397d7076dd59b09b074328d6231`。
- 所有实际源码输入在测试前后保持一致；原开发 JAR 未改，上一轮归档的 160 份证据哈希一致。

[最终总报告](release-acceptance-validation.json) · [原始阶段报告](../.dev/release-acceptance-20261006-7af109be/release-verified/report.json) · [逐项摘要](../.dev/release-acceptance-20261006-7af109be/release-verified/summary.md) · [证据文件索引](../.dev/release-acceptance-20261006-7af109be/artifact-index.json) · [三个后端案例](product-showcase.md)

### 失败样本与清理补修

首次缓存模式运行缺少 Redis 镜像引用，入口直接失败，后续步骤为 not_run。`prepare` 模式明确准备固定摘要镜像。最终代码另行注入退出码 71 与 500 ms 子进程超时，两次都报告失败、停止后续步骤并完成本轮 Redis 清理；不是把故意故障算成正常发布通过。

前三次试跑的业务检查通过，但进一步比较卷清单发现每次留下 5 个 Redis 匿名卷，旧清理门禁漏掉了这点。原始报告未改写，另附[复核说明](../.dev/release-acceptance-20261006-7af109be/superseded-cleanup-assessment.json)，**这三次均不作为最终验收通过**。根因是部分入口强制删除容器时没有显式移除匿名卷；独立对照确认 `rm -f` 留下卷，`rm -fv` 不留卷。[前后对照](../.dev/release-acceptance-20261006-7af109be/anonymous-volume-probe.json)

本轮补修三个共享入口的删除参数，并加入容器/卷清单核对。根据已保存的标签与挂载事件，以及首轮卷创建时间对应的唯一测试容器创建记录，清理了 15 个确认属于本轮的残留卷；没有按全局差集或 prune 删除资源。[归属与清理记录](../.dev/release-acceptance-20261006-7af109be/cleanup-owned-residuals.json)

最终复跑的 scope 资源为空，容器/卷清单前后一致，正常路径没有使用兜底强制清理。原有 **6 个容器、168 个卷** 保留。构建快照、依赖缓存、日志和交付包作为复核材料保留。整个工作期间默认 bridge 标识出现差异，仍作为未归因的环境记录保存；最终一轮的网络清单没有新增或删除。

### 本轮未执行与使用前提

本轮没有触发远端 GitHub Actions，没有重跑完整浏览器矩阵、真实 Prometheus/Grafana 故障链路、旧 124 项迁移兼容专项、完整冷启动对照、外部负载均衡滚动替换、容量长测或 RSS 专项。现有浏览器/历史证据只作引用，不计为本轮通过。尚未证明跨操作系统逐字节构建一致。

在真实发布前，先评审并提交工作区改动，再对对应提交执行发布入口；部署、凭据注入和外部负载均衡仍由目标环境负责。本轮结果交接仍默认关闭，**4000 req/s 一小时未通过；没有已通过一小时验证的健康容量档位**。
