# 发布验收工具：Linux 进程组退出 P2 补修

2026-10-07。本轮只修改验收工具及回归夹具，不修改网关业务代码、前端、资源参数或 CI 计划。状态：补修与专项验证完成，提交复验。

## 原因与修复

原实现把强制终止计时器的生命周期绑定到了直接子进程的 `close` 事件。父进程先退出、后代不继承输出时，`close` 可以先到；忽略 SIGTERM 的同组后代仍在执行，SIGKILL 升级却被取消。

`verification/acceptance-core.mjs` 现在让终止过程拥有独立、必须等待的 Promise。第一次超时或取消确定终止原因，后来的信号不重启预算。直接子进程关闭不取消组级终止，也不使调用提前返回。正常完成仍走原有快速路径。

| 阶段 | 行为与预算 |
|---|---|
| POSIX 开始停止 | 向本次命令的进程组发送 SIGTERM；命令仍由 `detached: true` 建立独立组 |
| 等待协作退出 | 最多 5 秒，每次间隔至多 50 ms 检查组是否消失；计时器保持引用 |
| 强制终止 | 仍存在则向同组发送 SIGKILL，再等待最多 1 秒确认消失 |
| 输出关闭 | 如尚未收到直接子进程的 `close`，最多再等 1 秒；超出则记录错误、断开本地输出流 |
| Windows | 保留 `taskkill /PID … /T /F`，命令预算 10 秒，输出关闭预算 1 秒 |

因此 POSIX 的额外停止预算最多为 7 秒，Windows 为 11 秒；从停止信号开始计，不含此前命令执行时间，也不是不受系统调度影响的硬实时保证。新增 `termination` 诊断记录发送信号、是否确认组消失以及错误。超时、取消、无法确认退出均不能变成 passed。

负 PID 定位进程组，信号 0 检查存在性；`ESRCH` 才能据此确认消失。组仍存在不一定仍在执行，例如没有 init 回收孤儿的容器中可能有僵尸进程。本轮保留“未确认消失”及错误，不把 SIGKILL 调用成功当作全部释放。参考 [Linux kill(2)](https://man7.org/linux/man-pages/man2/kill.2.html)。

## 实际补验

使用 Node 24.21.0；Linux 固定镜像为 `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`，只读根文件系统、禁网络、2 CPU、128 PID 上限及 64 MiB `/tmp`。修复后容器内存上限 512 MiB；原始基线为 256 MiB，两者均保留完整命令。没有运行网关开发实例。

直接运行验收方原始复现脚本，未改写夹具；源码与旧证据只读挂载，输出写入本轮新目录：

| 源码 / 环境 | 不继承输出：`runCommand` 返回时间 | 返回后再观察 5.5 秒 | 组消失确认 |
|---|---:|---|---|
| 修复前，无 init | 1.006 秒 | 子进程仍持续写入，复现失败 | 旧协议未提供 |
| 修复后，无 init | 7.006 秒 | 子进程停止写入 | 未确认，保留错误 |
| 修复后，有 init | 6.055 秒 | 子进程停止写入 | `groupGone=true` |

继承输出的对照也通过：修复后无 init 为 7.011 秒，有 init 为 6.059 秒。原始复现的两种场景都是故意超时，命令结果仍是 failed；“补验通过”指没有持续执行的后代，并非超时命令被标成成功。

新增 5 项真实进程回归：超时 / 主动取消 × 继承 / 不继承输出的四种组合，以及协作退出与普通成功路径。父进程通过 IPC 确认后代已安装信号处理器，再允许测试取消。断言在工具返回时后代已不再执行、心跳不再变化；其中一项还验证独立进程组继续工作。Linux 用 `/proc` 区分仍执行与僵尸状态，生产实现仍使用通用进程组 API。

| 检查 | 结果 |
|---|---|
| Windows 工具测试 | 42 / 42，通过；新增 5 项，无跳过 |
| Linux 工具测试 | 42 / 42，通过；新增 5 项，无跳过 |
| 原始 Linux 复现 | 修复前确实失败；修复后两种输出方式均通过，另补带 init 对照 |
| 统一入口退出失败演练 | 子进程 exit=71；总入口 exit=1；后续未执行；本轮 Redis 清理确认 |
| 统一入口超时演练 | 500 ms 超时、`timedOut=true`；总入口 exit=1；后续未执行；本轮 Redis 清理确认 |

两个演练都如实保留 `cleanup.forced=true`，不作为发布通过。全量工具测试覆盖负载发生器、接流量判定和验收报告等既有回归。

失败样本未删除：Windows 首次受限运行 36 项通过、6 项失败，独立探针证实 `taskkill` 返回“拒绝访问”，随后正常权限运行 42 项通过。统一入口首次 `cached` 模式缺少固定 Redis 镜像，在故障注入前已停止；它不是有效的注入演练。随后在全新目录用已有 `prepare` 模式准备固定镜像，退出与超时演练均符合预期。

## 复跑与证据

在项目根目录使用 Node 24.21.0：

```text
node --test --test-reporter=tap benchmarks/capacity-load.test.mjs benchmarks/stability-load.test.mjs verification/traffic-lifecycle-gates.test.mjs verification/acceptance.test.mjs
```

Linux 的相关测试也可在固定 Node 镜像中执行上述命令；挂载项目只读，允许 `/tmp` 写入，使用 `--init` 可回收孤儿僵尸进程。无需 Redis 即可执行这 42 项工具测试。统一入口故障演练沿用 [使用说明](release-acceptance.md)，输出目录必须全新。

- [本轮结构化报告](release-acceptance-process-group-p2-validation.json)
- [修复前原始复现](../.dev/release-process-group-p2-20261007-85f2c149/before-reproduction/linux-timeout-process-group.json)、[修复后](../.dev/release-process-group-p2-20261007-85f2c149/after-reproduction/linux-timeout-process-group.json)、[带 init 对照](../.dev/release-process-group-p2-20261007-85f2c149/after-reproduction-init/linux-timeout-process-group.json)
- [Windows 测试](../.dev/release-process-group-p2-20261007-85f2c149/windows-tools-unrestricted.log)、[Linux 测试](../.dev/release-process-group-p2-20261007-85f2c149/linux-tools.log)、[Linux 执行命令](../.dev/release-process-group-p2-20261007-85f2c149/linux-runs.json)
- [故障演练](../.dev/release-process-group-p2-20261007-85f2c149/failure-drills-prepared.json)、[历史保存核对](../.dev/release-process-group-p2-20261007-85f2c149/preservation.json)、[文件索引](../.dev/release-process-group-p2-20261007-85f2c149/artifact-index.json)

## 清理与剩余边界

本轮自建容器均已删除、Node 进程已退出。受限 Windows 测试留下的六个临时目录先归档再按精确路径删除。既有 6 个容器与 168 个卷保持原样。Docker Desktop 从本轮开始的关闭状态临时启动用于验证，结束后恢复关闭。固定镜像下载缓存与证据保留，不做全局清理。

默认 `bridge` 标识再次变化，已在本轮 `host-after.json` 和首次失败报告中保留；没有归因或试图修复环境。688 份验收方目录文件及旧归档 316 个构建输入哈希未变；旧 345 项文件索引中 343 项未变，另外两项正是此次修改的工具源码，原版已保存在本轮 `before/` 和旧构建快照中。

本轮没有重跑后端 / 前端业务测试、生产构建、完整发布矩阵、远端 CI、浏览器、真实代理及限流故障矩阵、冷启动对照或容量长测：改动限定在验证工具，相关跨平台进程回归与统一入口失败清理已实跑。原开发 JAR 未变；此前 4000 req/s 一小时未通过、没有已通过一小时验证的健康容量档位等结论不变。

进程组清理不能拦住后代主动 `setsid` / 换组逃逸；正常成功命令自行守护化也不在本次超时修复范围内。宿主崩溃、验收父进程被 SIGKILL、不可中断内核等待或无权限终止时，无法保证 JavaScript 完成清理。无法确认时保留失败，由隔离 runner / 容器销毁承担最终资源边界。
