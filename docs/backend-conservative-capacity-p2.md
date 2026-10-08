# 保守容量验收工具 P2 补修（2026-10-07）

两项工具缺陷已修复并完成定向补验，提交验收。原始一小时样本的结论保留：在原报告指定的包、配置、资源和负载下，1000 req/s 计划流量持续 3600 秒，3,599,757 个实际请求通过既定 HTTP、决策、延迟与对账门槛。**没有重复一小时压测；RSS 稳定性仍未证明。**

## 修复范围

`benchmarks/conservative-capacity-gates.mjs` 原来只比较前后采用版本，未检查响应版本覆盖和中途诊断。现在要求响应版本计数覆盖全部已完成请求，所有响应都来自预期路由版本；窗口前后及每个样本的限流、配置、路由实例身份一致，配置和路由的采用版本与存储观察版本均等于基准，同步状态正常、不过期、最近检查成功。同步失败累计数不得在窗口内增加或重置，因此采样间失败后恢复也不能被忽略。缺失数据、未知实例及非单实例输入不视为健康。失败报告保留前 20 个诊断位置，完整采样仍在原始记录中。

`benchmarks/conservative-capacity-shutdown.mjs` 提取真实清理分支所用的退出判定，保留 `docker wait` 的 stdout/实际退出码及后续 `inspect .State`。管理 shutdown 必须获确认，wait 与 inspect 都必须证明正常退出 0；非零、OOM、仍在运行、错误状态、缺失或矛盾证据、超时均令 `AGraceful=false`、整场 `passed=false`、工具进程退出 1。退出证据在删除容器前保存，失败后继续收集日志并清理自建资源。管理调用预算 5 秒、wait 45 秒、inspect 5 秒，最后的资源删除另计。新辅助模块也进入实验工具副本及 SHA256 清单。

业务源码、JAR、前端、运行参数、资源配置、健康阈值和交接默认值均未修改。新增退出测试已加入统一 `toolTests`，不改 CI 工作流。

## 实际补验

| 检查 | 方法与结果 |
| --- | --- |
| 工具测试 | 本机 Node 24.21.0，统一清单 **92 项通过**；其中容量门禁 21 项、退出检查 10 项，其余原有工具 61 项 |
| 原始窗口重算 | 当前门禁读取归档原始数据与原阈值；预热、两次短测、入场确认、一小时、降载 **6 / 6 通过** |
| 版本反例 | 原始一小时数据的 8 个内存修改副本：缺失/不足响应版本覆盖、混入其他响应版本、中途配置版本变化、路由同步失败、运行配置过期、实例变更、失败后恢复。旧门禁均误报健康，新门禁均拒绝 |
| 真实退出 0 | 固定摘要 Node 容器实际退出 0；当前 runner 的实际清理分支保存 wait=0、inspect ExitCode=0，`AGraceful=true`、报告通过、进程判定 0 |
| 真实退出 23 | 同条件容器实际退出 23；保存 wait=23、inspect ExitCode=23，`AGraceful=false`、报告失败、进程判定 1 |
| 原证据完整性 | **757 个文件（包括三个归档 ZIP）**按原 manifest 逐项校验大小与 SHA256，全部一致；原 manifest 哈希也未变 |
| 原网关退出 | 重新核查归档 Docker die 事件，原实例真实退出码为 **0**。原容器已删除，不伪造新的 inspect 记录 |
| 清理 | 本轮两个带随机 owner 标签的容器均删除，无网络、端口或卷分配；既有 **6 个容器、168 个卷**清单及状态保留 |

真实容器补验使用 `--network none`、0.5 CPU、128 MiB、64 PID 上限。执行的是当前容量 runner 的实际网关清理循环，只有管理 HTTP 确认以夹具代替；不声称重新验证了真实网关的 shutdown 或排空。OOM、wait 超时、inspect 不可用、退出记录冲突等分支为工具单元夹具，未制造新的真实 OOM。

原始窗口的响应覆盖 / 采样数：

| 窗口 | 完成响应 | 中间采样 | 新门禁 |
| --- | ---: | ---: | --- |
| 预热 | 77,749 | 57 | 通过 |
| 短测 1 | 119,994 | 58 | 通过 |
| 短测 2 | 119,999 | 58 | 通过 |
| 入场确认 | 29,999 | 15 | 通过 |
| 一小时 | 3,599,757 | 1,732 | 通过 |
| 降载 | 12,000 | 59 | 通过 |

各窗口采用版本保持为运行配置 `0348e72f-2be2-41b5-bb44-386ac0eb9e72:1`、路由 `55b8802e-8a4e-4292-9b27-51b800b8f801:33`。HTTP 头覆盖证明路由版本；运行配置与同步状态依靠原始诊断采样及累计失败数，不能声称逐请求都有运行配置版本证据，或已经观察到每个瞬间。

## 复现与证据

本轮新证据根目录：`D:/Java/ZenithGateway/.dev/capacity-p2-20261007-6b392e8f`。

```powershell
node --test benchmarks/conservative-capacity-gates.test.mjs benchmarks/conservative-capacity-shutdown.test.mjs
node verification/conservative-capacity-p2-live.mjs .dev/capacity-baseline-20261007-3e81767a/experiment-01 .dev/capacity-p2-new-run
```

第二个命令要求输出目录尚不存在、固定摘要 Node 镜像已缓存。它只读旧数据，在新目录保存源码副本与哈希、重算结果、8 个修改副本的前后判定、真实退出状态以及资源清理清单。退出码 23 是该专项预期的负例；只有工具准确判失败，专项才通过。

- [机器可读补验汇总](backend-conservative-capacity-p2-validation.json)：变更身份、测试及原始证据入口。
- `live-recheck/validation.json`：完整重算、反例、真实 Docker wait / inspect、前后资源清单。
- `live-recheck/exit-0/cleanup.json`、`live-recheck/exit-23/cleanup.json`：实际退出分支保存的结果。
- `tool-tests.log`：本机 92 项 TAP 结果。
- `original-evidence-integrity.json`：原始 757 个文件的逐项校验。
- `environment-observation.json`：本轮观察到的默认 bridge 标识变化。

没有改写原 `summary.json`、归档门禁源码、历史 `analysis.json`、原验收 JSON 或已有 manifest。旧工具曾给出的布尔结论是历史记录，不等于已满足新门禁；缺少响应版本/诊断信息的其他旧样本必须报告证据不足。旧 `AGraceful=true` 也不能替代实际退出码。本次原样本拥有足够的版本数据和独立退出事件，因此无需重跑一小时。

## 边界与未执行项

本轮没有重跑后端/前端全量测试、生产构建、远端 CI、真实网关故障或滚动替换矩阵，也没有新容量/RSS 实验；改动限于验收工具、回归及说明。门禁复核不消除原报告中累计在途命令计数退休窗口、采样间瞬时资源峰值和 RSS 尚无平台的限制。4000 req/s 一小时失败记录不变。

默认 bridge 标识在首次只读 Docker 检查与专项正式清单之间，由 `d3845f8f5babf41dbded6c527cf85753d61f18a11436a7a88d66252af2b36c14` 变为 `9bc6821d63c6563d90d2c6c6b38bb522c8d1fc6e63319c0f564a8d762e7e5777`；专项容器执行前后保持后者不变。未归因，本轮容器均使用 `none` 网络，没有创建、删除或配置 bridge。Docker Desktop 保持原有运行状态；既有开发实例未启动或升级。
