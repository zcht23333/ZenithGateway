# 求职展示候选版本

本页记录候选阶段的历史交付。后续候选与面试材料进入 main 的范围及当前 CI 入口见[主线升级说明](main-upgrade-20261008.md)；以下“未合并 main”等描述保留当时状态。

功能验收基线已固定为 **`c613940559c829e5aa466d04b9343c0241d5e3ae`**，同一提交的 [Verify](https://github.com/zcht23333/ZenithGateway/actions/runs/37724149697) 与 [Release acceptance](https://github.com/zcht23333/ZenithGateway/actions/runs/37724149659) 均通过。从干净源码导出全新构建目录，使用同一 JAR 完成发布矩阵，源码输入在测试前后未变。

公开分支：`zch/showcase-candidate-20261008`。本页和归档材料由后续资料收尾提交保存；该提交也触发两层 CI，其状态可从分支的提交检查查看。原工作区保留，未合并 main、未部署或升级开发实例。

[机器可读记录](showcase-release-validation.json) · [三个案例](backend-case-studies.md) · [可离线复验的证据](evidence-index.md) · [控制台演示](product-showcase.md)

## 版本与产物

| 项目 | 实际身份 |
| --- | --- |
| 后端上游断连修复 | `3a9f0c0183dab846a5c40557b37e184afdaff230` |
| 完整功能验收提交 | `c613940559c829e5aa466d04b9343c0241d5e3ae` |
| Verify / Release 使用的同一 JAR | `59205bff217fda345772357ddd151975c7d52ff23188f49a6a98c77822d66810` |
| 实际构建输入 SHA256 | `c9259dc432cc794122179117f2b8c4f5a229aaa25b6ef1ccffadbeee36145c20` |
| 工具链 | Microsoft JDK 21.0.12.1、Node 24.21.0、Maven Wrapper 3.9.16 |

两份 CI ZIP 均已下载，核对 GitHub 官方 SHA256 并逐成员解压校验；实际归档身份在机器记录。仓库内的压缩原始报告及源码清单不依赖本机 D: 路径，Actions 二进制产物保留期仍有限。构建使用干净输入，可复用依赖下载缓存，不复用编译产物；不宣称离线封闭构建或所有操作系统产生相同 ZIP 字节。

本地修复包 `0e91dc5a…`、C3 CI 包 `82ac7d42…` 与此功能基线包的解压后 343 个条目字节一致，整个 JAR 哈希分别记录。它们均与历史容量包不同；构建身份比较没有迁移性能结论。

## 实际执行

| 验证 | 结果 |
| --- | --- |
| 后端全量 / 真实 Redis 集成 / 生产 JAR | 263 项通过，失败/错误/跳过均为 0 |
| 前端测试 / npm ci / 生产构建 | 107 项通过 |
| 工具测试 | 114 项通过；包含探测与业务命令退休、进程树退出、证据边界 |
| Prometheus 规则与 Grafana 查询夹具 | 86 + 97 = 183 项断言；不是重跑真实 Grafana 故障链路 |
| 发布矩阵 | 10 个真实入口、142 项检查；代理 24 组 / 102 请求 |
| Windows 启动入口 | 干净 C3 副本、已校验 CI 包：后端 readiness、前端代理和有界退出 smoke 通过 |
| Windows 自动换行克隆 | `core.autocrlf=true` 的干净克隆，两份证据清单校验通过 |

| 真实入口 | 检查数 |
| --- | ---: |
| config-sync | 10 |
| config-operations | 11 |
| config-rollback | 9 |
| route-publication | 19 |
| proxy-resilience | 24 |
| rate-limit | 22 |
| rate-limit-malformed | 17 |
| limiter-policy | 25 |
| lifecycle-functional | 4 |
| lifecycle-signal | 1 |

本地还独立执行：263 项后端、48 项代理相关测试、Linux 旧/新包同条件故障对照、25 组限流策略、4 组生命周期功能和 1 组 SIGTERM。Linux 旧包 RST 失败与新包通过均保留。工具夹具测试、真实请求数与监控断言不相加冒称“总测试数”。

## 失败与修正没有被覆盖

- C1 `82e0f816…`：Verify 通过，Release 在 Linux 的已提交响应 TCP RST 场景失败。框架把上游原生异常当成下游取消吞掉；局部修复保留上游客户端异常身份及原始 cause，终态恢复为 error。[原因与复现](showcase-proxy-reset-fix.md)。
- C3 `5ddedb1f…`：代理矩阵通过，限流策略夹具等待包含恢复探测的全零状态超时。现在故障期间先证明业务命令物理关闭、名额归还且探测有界，恢复后仍要求全部归零。[判断边界与回归](showcase-validation-fixes.md)。
- Windows 常见 Git 换行转换使证据 JSON 哈希失败；仅对证据目录关闭转换，原字节校验不放宽。
- 本地缓存模式缺少固定 Redis 镜像标签、750/2,000 ms 初始读取失败，以及 2 CPU 容器超过 60 秒就绪窗口，均保留。补验使用声明的初始化预算，不将失败改写为成功，不修改产品默认值。

发布层的 lifecycle functional/signal 明确设置 4,000 ms 路由读取预算，CI 就绪观察仍为 60 秒。本地补验另外使用 120 秒接流前观察预算；代理和退出时限、额度策略、线程/队列及交接默认值不变。较宽初始化预算不证明冷启动性能改善，预热退化仍在报告中。

## 复验与阅读入口

精确复验本页历史功能基线时，获取 `zch/showcase-candidate-20261008` 分支，再 checkout 上表完整提交并确保工作区干净。首次使用当前版本按 README 获取 main：

```powershell
node verification/acceptance.mjs --tier release --out .dev/release-reproduce --images prepare
node verification/showcase-evidence.mjs
node verification/showcase-evidence.mjs --manifest docs/evidence/showcase-candidate-20261008/manifest.json
node verification/showcase-links.mjs
```

每次使用全新输出目录，不给正式候选加 `--allow-dirty`。主入口、限流故障与配置操作工具都保留失败报告和实际退出码。三页 UI 的早期录屏明确标记历史/演示来源，不冒充本轮真实后端证据。

未重跑完整浏览器交互矩阵、真实 Grafana 故障链路、HAProxy 替换、冷启动负载对照、容量一小时、RSS 干预或 macOS 启动。对应原验收记录保留；本轮前端未改业务流程，生产构建和单元测试已实际执行。

## 性能与资源边界

**单实例、4 个逻辑 CPU、1 GiB、小 HTTP 响应条件下，1000 req/s 一小时容量窗口通过；长期内存稳定性仍未证明，4000 req/s 一小时未通过。**

这句话只绑定 `3f73c65c7c29933549878c570a6b5a8b7bd8bafad2e5333603eee1de089da838` 的历史实验。RSS 文案已修正为“年轻代 GC 后堆占用 39→57 MiB”，没有重跑实验。新候选功能回归通过不代表重新完成一小时；trim 后下降也不能证明自然内存稳定。

本轮隔离 JVM、Redis、上游、网络和私钥已清理；原有 **6 个容器、168 个卷**完整保留。默认 bridge 标识再次变化，仍未归因，原始前后快照保留；未对它做删除或重建。共享固定镜像缓存保留，没有全局 prune。停在展示候选验收，进一步功能和容量优化另行决定。
