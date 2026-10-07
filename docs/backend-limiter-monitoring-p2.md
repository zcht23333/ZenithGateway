# 监控 CI 镜像准备 P2 修复与无缓存补验

状态：已修复并完成本地补验，等待独立验收。日期：2026-10-05。

## 问题与修改

原 CI 直接执行 `node observability/test-monitoring.mjs`，而该入口使用 `docker run --pull=never`。没有本地 Prometheus 镜像时，Docker 在规则测试开始前失败。这与 [Docker 的 pull 策略说明](https://docs.docker.com/reference/cli/docker/container/run/#pull)一致。

`.github/workflows/verify.yml` 在监控测试前增加独立步骤：

```sh
docker pull prom/prometheus:v3.13.3@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7
node observability/test-monitoring.mjs
```

拉取和测试使用同一个固定摘要；测试仍保留 `--pull=never`。镜像准备失败时，该步骤直接失败，不会继续执行监控测试。摘要固定内容身份，标签用于辨识版本；参见 [按摘要拉取镜像](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier)。网络、仓库限额或凭据问题仍可能使准备步骤失败，本轮不隐瞒或绕过此类失败。

第一次真实 Linux 无缓存补验还发现第二个阻断：Node 的 `mkdtemp` 目录权限为 0700，Prometheus 镜像以 `nobody` 运行，无法读取生成的 `dashboard.test.yml`。已在测试入口内仅将本次生成的公开夹具目录设为 0755、该文件设为 0644。只读挂载及原有 finally 清理继续保留；未调整源码目录、系统临时目录或凭据权限。

业务代码、故障策略、告警规则、面板查询和断言内容没有修改。

## 实际补验

证据根目录：`D:/Java/ZenithGateway/.dev/monitoring-ci-p2-20261005-e2fd341e`。完整产物身份、检查结果和路径见 [补验 JSON](backend-limiter-monitoring-p2-validation.json)。

| 检查 | 实际结果 | 原始证据 |
| --- | --- | --- |
| 冷环境未准备镜像 | 全新 daemon 的镜像数量为 0；镜像 inspect 失败；原执行顺序退出码 1，规则用例尚未开始 | `cold-02/cold-images.txt`、`cold-inspect.log`、`without-prepare.log/json` |
| CI 新增准备步骤 | 真正联网拉取同一摘要，inspect 的 RepoDigests 与测试入口一致 | `cold-02/prepare-image.log`、`prepared-image.json` |
| Linux 冷环境完整监控测试 | 通过：27 组规则用例 / 86 项断言，8 组面板用例 / 97 项断言，共 **183 项** | `cold-02/with-prepare.log/json`、`validation.json` |
| Windows 既有入口回归 | 同样 183 项全部通过，权限修复兼容本机入口 | `windows-monitoring.log/json` |
| 语法与 CI 契约 | 两个 JS 入口语法检查；准备步骤先于测试，摘要一致，保留 never | 补验 JSON、验证入口断言 |
| 第一次失败保留 | 拉取成功，规则通过；面板夹具权限拒绝，整体失败。修复后才重新建立空环境通过 | `cold-01/with-prepare.log`、`validation.json` |

这不是 366 项不同断言：Linux 与 Windows 分别执行同一套 183 项。面板断言直接读取实际 Grafana JSON 中的 41 条查询；本轮没有重新打开浏览器或执行网关故障链路。

冷环境使用 Docker 29.8.0、Linux amd64、VFS 存储驱动；外层 daemon 容器限制为 2 CPU、1536 MiB、256 PIDs。内层 Node 实测为 24.18.1；本机为项目固定的 24.21.0。此补验验证实际 Linux Docker 行为与 CI 的镜像准备/测试顺序，并非一次远端 ubuntu-24.04 / Node 24.21.0 的完整 GitHub Actions 运行。

## 重复执行

从项目根目录运行：

```sh
node verification/monitoring-ci-no-cache.mjs --out .dev/monitoring-ci-no-cache-<新的唯一目录>
```

需要 Node 24、可运行 Linux 容器且支持 privileged DinD 的 Docker，以及镜像仓库和 Alpine 包仓库访问能力。脚本使用固定摘要的 Docker 29.8.0 DinD 辅助镜像；容器内安装 Node 并记录实际版本。

入口建立专属容器、网络及全新镜像存储，不挂载宿主 Docker socket，不发布端口。项目目录只读，证据目录可写。先证明无镜像时失败，再读取工作流中实际的 pull 参数执行拉取，随后运行同一监控入口。启动、拉取及测试均设有超时；finally 清理自建容器、匿名数据卷与网络。若辅助镜像在运行前不存在，入口会在结束时清理它；已有镜像保留。中断或强杀时，应根据证据里的容器和网络名精确清理，不执行全局 prune。

本轮辅助镜像先单独准备，两个冷环境分别运行，最后仅删除这个新辅助镜像。原有 Prometheus 镜像没有被删掉来模拟“无缓存”；无缓存条件来自另一个真实 daemon 的空镜像存储。

## 清理、变更范围与迁移

- 两次冷环境各自的前后容器、网络、卷和镜像清单一致；嵌套测试容器也全部退出并移除。
- 总清理后，宿主既有容器及状态、卷和镜像缓存与最初基线一致；专属测试网络均已删除，既有网络名称集合保留。
- 诚实记录一项环境差异：最初清单中的系统默认 `bridge` ID 与首次冷环境启动前不同；两个测试期间该 ID 均保持一致。未执行默认网络重建，现有证据不能归因这一变化。原始清单及差异保留在 `cleanup.json` 和最终清理说明中；不宣称全部宿主资源身份逐字不变。
- 上一轮 10 项交付哈希中仅工作流和监控测试入口发生上述修改，其余 8 项保持原值。原交付报告、截图与故障证据保持原样，原哈希描述原交付；本补验 JSON 记录新哈希。最小差异见 `ci-p2.patch`。
- 无存储、接口或业务策略迁移；现有开发实例不升级。独立使用测试入口时，也需先准备该固定摘要镜像。以后升级 Prometheus 时应同步工作流与入口摘要，重跑此无缓存检查。

## 未执行与剩余边界

未重跑真实网关 / Redis 故障链路、浏览器、后端测试、前端测试及生产构建；它们不受这次 CI 准备和测试文件权限修改影响，上一轮核验结论与证据保留。未触发远端 CI，因此不声称整条 GitHub Actions 已通过。

不开展容量、冷启动或 RSS 实验。**4000 req/s 一小时未通过，且没有已通过一小时验证的容量档位**，结论不变。
