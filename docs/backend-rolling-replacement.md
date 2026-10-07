# 真实双实例滚动替换

2026-10-07。此文件先记录实现与固定验收计划，实际执行结果在验证完成后补充。短窗口仅用于操作正确性，不作为稳定容量声明。

## 正式基线

已验收工作区整理到独立检出目录，保留原工作区、IDE 改动和本地证据。正式基线提交为 `b000a354ae8cad25682c1ce503f5336d91bf8d57`，分支 `zch/release-baseline-20261007`，未合并 main。原本地提交 `922a9106` 因 GitHub GH007 私有邮箱保护被拒绝；更换为账户 noreply 身份后推送成功，两者 Git tree 都为 `dba4e44d07b0e18135c19282163c9001524d55d1`，文件内容相同。

[基线 Verify CI](https://github.com/zcht23333/ZenithGateway/actions/runs/37583672526) 实際通过：252 项后端、107 项前端、42 项工具测试、183 项监控断言与生产构建。报告为 `dirty=false`。构建输入 SHA-256 为 `d0252d3add2e97777fcb8ad7ecb66e2221f33e57c01a5863187dd88d69271e70`；JAR 为 `9f0e9f2278dba98ef013b4b67902b9411c41cd9d731b1d3a15c6a4136a8cb314`。这次是 commit 层，没有把此前工作区执行的完整发布矩阵改写成这次 CI 执行结果。

## 接入方式与边界

入口为 `verification/rolling-replacement-live.mjs`。专属 Docker 网络内启动 Redis、HAProxy、无副作用上游、Linux 请求发生器，以及至多两个同时存活的网关 JVM。正常业务发生器只有固定地址 `http://balancer:8080`；控制请求可直达管理诊断和夹具端口，不计为业务请求。权重、健康检查与摘除由真实 HAProxy 执行，脚本只作为外层部署控制器，不给网关增加自动扩缩容功能。

HAProxy 固定摘要 `sha256:56b887da77428b7a6621e59e480cdbd330cc805c22d3cedb66ceea76ffdea2c6`；实际版本输出保存在每轮 `haproxy-version.txt`。配置明确 `retries 0`、`retry-on none`、禁用 redispatch。HAProxy 和网关均不自动重发。使用 HTTP/1.1 keep-alive、`http-reuse safe`，不配置粘性会话；用 maintenance 摘除 A，不设置 `shutdown-sessions`，已转交 A 的请求允许在预算内完成。

依据：[HAProxy Runtime API](https://www.haproxy.com/documentation/haproxy-runtime-api/reference/set-server/)、[配置手册](https://docs.haproxy.org/3.0/configuration.html)、[统计字段](https://www.haproxy.com/documentation/haproxy-runtime-api/reference/show-stat/)。这些是机制依据，不能代替本轮真实转发验证。

## 预先固定的晋级条件

- 目标 50 req/s，阶段窗口 5 秒；首次小流量为 10 req/s × 5 秒。B 权重依次 5%、20%、50%，最后摘除 A、B 100%。权重不承诺短窗口精确请求比例。
- 每阶段最多 3 个完整窗口。HTTP 全部 200、无故障放行/保护性拒绝/额度拒绝/扣费未知/连接池拒绝；P95 ≤ 250 ms、P99 ≤ 750 ms；生成器缺口 ≤ 2%。版本追平、计数不重置、审计完整确认、上游与终态数量对应、资源不越界；观测失败也不晋级。
- readiness 最多等 60 秒；恢复与版本追平最多 20 秒；审计稳定最多 15 秒。候选未满足本地版本与同步诊断条件时保持零权重，A 继续服务。B 只用纯本地诊断确认采用，不用管理 GET 当前配置推动同步。
- 尚未执行过额度决策的 `unchecked` 限流器，仅可在版本与同步检查通过后进入有界的小流量观察；它不能让健康窗口通过。实际故障 `degraded/probing` 不能使用这一入口。首次观察后必须取得真实的健康决策，才能增加权重。
- 每 JVM 2 CPU / 1 GiB，堆 256–512 MiB，直接内存最多 256 MiB；限流 workers=8、queue=64、交接 false。限流额度 10000/s、容量 10000，保证本轮健康场景额度充足；失败策略仍为默认 allow。
- 请求排空 2 秒，取消结算 1 秒，审计排空 1 秒，审计命令 250 ms，Spring 每 phase 10 秒；外层 drain 观察 12 秒、SIGTERM 后进程等待 45 秒。外部 LB 的 client/server 超时 30 秒，大于网关业务退出预算。正式部署需按实际长请求重新制定预算。
- 上述审计 1 秒只是排空窗口；连同已有命令和客户端关闭，诊断中的 `auditStopBudgetMs` 为 3750 ms，完整协调预算为 6750 ms。观察预算与内部阶段预算分别记录，不把 1 秒写成全部关闭时间。

## 三类操作与对账

1. B 启动失败、B 版本落后或 B Redis 失联时，验证 A 从同一入口继续服务。故障放行即使 HTTP 为 200，也阻止晋级。恢复后重新检查，不把前一次失败窗口删掉。
2. 正常替换验证真实 HAProxy 权重变化、A 在途请求完成、既有客户端 keep-alive 在摘除后将新请求交给 B，以及 B 在 A 的 SIGTERM 期间继续服务。
3. 重新启动旧实例进行独立退出故障试验：慢 POST、已发送部分响应、客户端取消、审计已执行但回复丢失。验证新流量去 B，旧请求有界结束，审计确认/未知/丢弃保持不同含义。503、断流和取消不能证明上游没有执行。

每个业务请求的唯一编号放在隔离路径中，通过发生器记录、HAProxy HTTP `req_tot`、实例生命周期计数、上游接收记录和审计路径对应。比较路径重写前后时只按明确的编号连接；上游同一编号执行两次、审计重复、未发起却执行、选中实例不对应都会失败。审计未知可能已经写入，不能用存储缺行简单替代结算状态。

HAProxy Runtime 控制端口和上游/发生器控制端口仅发布在本机随机 loopback 端口；网关管理端仍有本轮随机 Bearer 认证。此入口是测试工具，不应直接作为生产控制面暴露。

取消需区分客户端到 LB 和 LB 到网关两段连接。第 3 轮真实实验发现，客户端在响应头前 `destroy()` 产生的关闭，没有立刻结束 HAProxy 已派发的请求，最终由网关排空截止结束；不能要求网关记录一个尚未收到的取消信号。本入口分别验证这种关闭与明确的 TCP RST，并保存两端不同的终态。HAProxy 默认对输入关闭采取保守行为；`abortonclose` 的文档范围主要是队列与建连，不能将其当作已派发业务的撤销保证（[官方说明](https://docs.haproxy.org/3.0/configuration.html#4-option%20abortonclose)）。

## 复跑

```text
node --test verification/rolling-replacement.test.mjs
node verification/rolling-replacement-live.mjs --prepare --jar <已核对的生产JAR> --out <全新证据目录>
```

可加 `--record`，通过 `PLAYWRIGHT_MODULE` 指定 Playwright 1.63.0 的 `index.mjs`。演示画面实时读取脚本的实际调度事件；视频保存在 `rolling-demo.webm`，不是虚构流量动画。CI 入口为 `.github/workflows/rolling-replacement.yml`，从干净提交构建，失败时也归档。

## 未扩大范围

没有改动网关策略、六字段配置、路由协议或结果交接默认值。没有验证 TLS 终止、HTTP/2、粘性会话、多个 LB 节点的配置传播、云平台摘除延迟、进程被 SIGKILL 后无损恢复。4000 req/s 一小时未通过，没有已通过一小时验证的健康容量档位；RSS 归因仍是后续专项。
