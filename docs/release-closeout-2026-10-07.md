# 滚动替换发布收尾

最终代码提交：`8a654cbcf1c31d9754bfdd2db7f699613ceedfbb`，公开分支 `zch/rolling-replacement-20261007`，没有合并 main，也没有升级开发实例。

此前暂留的 8 个文件已通过提交 `f48a28f610eb2471153929e89acbbccacee236d2` 发布。检查实际 CI 摘要时发现其误读 `build.artifacts` 的结构：JAR 哈希是字符串、前端清单是数组，旧摘要输出成空对象。原始产物没有损坏；最终提交修正摘要并添加回归测试。保留两次提交的 CI 日志，不用首次绿色结果掩盖该展示缺陷。

## 同一个最终提交的远端结果

| 工作流 | 结果与入口 |
| --- | --- |
| Verify | [37600340773](https://github.com/zcht23333/ZenithGateway/actions/runs/37600340773)，success |
| Rolling replacement | [37600340903](https://github.com/zcht23333/ZenithGateway/actions/runs/37600340903)，success |

最终 Rolling 构建报告为干净提交，325 个构建输入，SHA256 `b1ff9128e43c91fb816f3a07ac5d0d1d41858b398d0f99c35fff7203819466b7`。252 项后端、107 项前端、61 项工具测试通过；监控 86 项规则断言、97 项实际面板查询断言通过，前后端构建完成。摘要步骤实际执行，包含非空、准确的 JAR 哈希与 12 项前端产物哈希。

6 组真实 HAProxy 检查通过：总入口、LB、上游各 3069 次，重试和 redispatch 均为 0；正常场景 2803 次入口/上游/审计一致。退出故障中的 unknown 与 dropped 单独保留：A 全部 1807 确认，B 745 确认 + 1 unknown，AEXIT 500 确认 + 10 unknown + 6 dropped。存储实际有 3062 条，不能将 unknown 当成必然未写入。AEXIT 第一个预热窗口延迟超标，第二个才晋级；原始失败窗口仍在报告中。这是操作与故障语义验证，不是容量验证。

## 下载与核验

本轮新证据根目录：`.dev/capacity-baseline-20261007-3e81767a/`。

| 产物 | SHA256 |
| --- | --- |
| GitHub 完整 ZIP `11472412586` | `c0a4704480bf8509c6e59f79c86775512fbd8fc008a3087a952b59b3008d795c` |
| GitHub 精简 ZIP `11472502227` | `cbfd8c6fe1bfeb73db55e2baced8a758fabd27fd7c5d3fc54b4d52d7995b9a07` |
| GitHub Verify ZIP `11472820804` | `3950f1a2801692ae9b7fc5c6dd290d1c0d6bc412d98295741fd4a01ffc47f40c` |
| 最终 gateway.jar | `aed33ee043618930ffa3a0a45eccab75b95737d6a760e50f66f671f365a24dd1` |

两个 ZIP 已下载到本地并与 GitHub 的 digest 对比。解压前检查每个条目仍处于专属目标目录。解包后核验 JAR 与构建报告、精简摘要、真实链路报告的身份一致；12 个前端文件逐项核验，完整归档 149 个文件建立 SHA256 清单。325 个输入与最终提交逐项比对，按仓库 `.gitattributes` 应用换行规则（Windows 工作区和 Git 原始 blob 不能无条件代替 Linux 检出的构建字节）。

核验入口与记录：`verify-download.mjs`、`archive-verification.json`、`archive-verification-final.log`、`final-ci.json`、`final-ci.log`。`final-release/rolling-build/` 和 `final-release/rolling-live/` 是实际下载内容；`final-live/` 保留独立精简归档。GitHub 默认 30 天过期，本地归档不依赖其继续在线。

Verify 的独立 ZIP 也已下载、检查条目路径、验证摘要并建立 92 个文件的哈希清单。`ci-artifact-agreement.json` / `verify-ci-agreement.mjs` 核实：两个工作流不仅提交相同，325 个构建输入的摘要、最终 JAR 字节及 12 个前端产物也全部一致。Verify 远端保留 14 天，Rolling 保留 30 天；这三份实际 ZIP 均已本地归档。

## 边界

本次重新执行的是上述远端构建、规则与滚动链路检查，不是整个 release 层旧故障矩阵。没有声称在本机重新执行全部历史验证。远端报告的容器、卷、网络、凭据及网关 Redis 连接清理均通过。

原工作区仍保留用户改动与历史证据。早期滚动文档中“8 个文件待提交”的描述属于当时交付状态，本记录更新其当前状态，历史原始报告不改写。后续容量实验只使用上表这个已经下载校验的 JAR；容量工具与配置另存哈希，不能仅凭同一源码宣称不同构建包相同。
