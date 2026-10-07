# 限流故障策略的监控消费者

本轮只修改监控消费者、规则测试、隔离验证入口与说明。两项故障策略默认 allow、额度算法、429/503 行为、六字段运行配置、资源上限和交接默认关闭均不变。

## 事实、动作、最终结果

已用未改动的产品 JAR 实际抓取，而非根据命名推测：

- Java 名称 zenith.ratelimit.decisions，实际 Prometheus 名称 **zenith_ratelimit_decisions_total**，类型 counter。
- 产品标签 event、action、execution，加公共 application="zenith-gateway"。
- Prometheus 加入 job、instance；instance 是 scrape target 身份。没有增加 IP、请求 ID 等高基数标签。
- 9 组事实/动作 × 4 种 execution，预注册 36 条序列/实例。无流量仍有真实零计数。

| event | action | 含义 |
| --- | --- | --- |
| allowed | forward | 明确获得额度许可 |
| disabled | forward | 显式关闭限流后的绕过 |
| limited / unfulfillable | reject | 明确额度拒绝，选择 429 |
| local_unavailable | forward / reject | 本地资源不足，选择故障放行 / 保护性 503 |
| redis_unconfirmed | forward / reject | Redis 额度未确认，选择故障放行 / 保护性 503 |
| cancelled | cancel | 决策期间客户端取消 |

execution 为 confirmed、not_sent、not_written、unknown。**unknown 可与 forward、reject、cancel 同时出现，不能与动作分类相加求请求总数**。它既不证明扣费成功，也不证明没有扣费，不能用于退款或重试。

event 回答发生了什么；action 回答采取什么动作。最终 HTTP 结果另看 zenith_gateway_requests_seconds_count 的 status、outcome 与审计。forward 不保证上游收到或请求成功；记录状态码也不保证客户端完整收到响应。上游接收量需要上游记录交叉证明，本轮不添加没有来源的接收量指标。细分故障原因仍在受认证保护的 /settings/rate-limit/diagnostics 和审计中。

## 告警约定

所有新限流告警按 job、instance 定位；动作告警额外保留 event，分别产生本地/Redis 原因。rate、increase 先用于每条 counter，再聚合，避免不同实例或标签重置互相抵消。

| 告警 | 条件及持续时间 | 解释与恢复 |
| --- | --- | --- |
| ZenithRateLimitFailOpen | 最近 1m，local_unavailable 或 redis_unconfirmed，action=forward，rate > 0，持续 15s | 窗口内有故障放行，不是上游成功。保留来源 event。窗口不再含新增后解除。 |
| ZenithRateLimitProtectiveRejection | 相同两类事实，action=reject，rate > 0，持续 15s | 策略选择保护性 503，不是 429，也不代表状态码一定已交付。窗口不再含新增后解除。 |
| ZenithRateLimitDebitUncertain | 最近 1m 的 unknown，action=forward 或 reject，估算 increase >= 3，持续 30s | 多次扣费结果未知。取消不参加门槛，但原始计数及图表完整保留。低于门槛后解除。 |
| ZenithRateLimitMetricsMissing | up=1，但当前 decision 指标族完全缺失，持续 30s | 抓取成功却没有所需指标。检查旧包、observability.enabled=false、relabel；不是零业务量。指标恢复后解除。 |
| ZenithGatewayUnavailable（保留） | up=0，持续 30s | 抓取失败，检查网络、进程、凭据；抓取恢复后解除，不能据此断言 Redis 故障。 |

三条故障/unknown 规则要求当前 up=1；抓取失效时交由不可用告警表达监控盲区，避免旧窗口样本冒充当前可观测状态。因抓取失败而解除动作告警不证明 Redis 已恢复。

抓取与评估间隔各 5s。动作告警延续既有 1m / 15s；unknown 采用次数门槛加 30s 持续，减少纯取消和零星抖动噪音。increase 是外推估计，可为小数，阈值 3 不等于精确三条审计。单次突发也可能使滑动窗口持续满足条件。恢复可能还需一个窗口加一次评估；告警解除不会把历史 unknown 改成确认。

保留审计停滞、预算、明确丢失、审计未知、可用性与延迟告警职责。延迟告警仅纠正说明文字为 limiter decision wait。未配置外部通知，本轮验证 pending / firing / 解除和 Grafana 展示。

## 面板

继续使用 UID zenith-operations，版本 2；保留原 1–17 面板 ID，现有 27 个面板、41 条查询。

- Instance 支持多选与 All，候选取自 up 指标，故障或缺指标的实例仍可选。全部面板遵守选择。URL 全选值为 Grafana 的 $__all，不能把字面 .* 当作一个实例选项。
- 数据状态：METRICS PRESENT、SCRAPE FAILED、DECISIONS MISSING。指标存在只表示可观测；目标未发现显示 No data，不声称健康。
- 五类主要决策卡分别展示许可、显式绕过、429、故障放行、保护性 503；明细图再加取消，形成互斥分类。
- unknown 独立卡标 *，上方说明重叠维度；明细按 forward/reject/cancel 展示。
- 故障动作占比分母是**同实例全部已终结限流决策，包含 disabled 和 cancel**。两个分子是故障 forward / reject。unknown 不参与相加；分母为零时留空，不补成 0%。
- 当前统计卡使用 instant 与 last，不沿用 lastNotNull。限流图还要求当前指标族存在、scrape 成功，避免源消失后旧窗口看起来正常。No data 采用中性灰色。
- 原第 11 面板改称 **Limiter decision wait · P95 / P99**。旧 zenith_ratelimit_redis_seconds 指标是从过滤器开始取得决策，到结果送达或取消的墙钟耗时，包含本地排队、连接、Redis 往返/超时、解码、可选结果交接和调度停顿；不含后续上游处理，disabled 不计时。不是 Lua 执行耗时或纯网络 RTT。既有限流直方图最高有限桶为 1 秒；超过该桶的分位数会落在 1 秒边界，不能把图中 1s 当作实际最大等待时间。本轮 1500ms 故障预算已用原始请求耗时验证这一边界，未修改业务桶配置。
- 原第 12 面板采用新的事实/动作分类，不再把旧 Timer outcome=error 解释为放行。
- 最终请求图按实例、HTTP 状态类别和终结 outcome 展示。单位明确为每秒速率、秒或百分比。原聚合审计/延迟告警可能没有 job 标签，告警表仍保留它们。

## 验证与复现

规则与实际面板查询回归：

~~~sh
node observability/test-monitoring.mjs --report <独立输出JSON>
~~~

固定版本 promtool 执行提交的规则夹具，以及直接来自 Grafana JSON 的查询。覆盖反例、窗口、持续、恢复、重置、实例隔离、零量、缺失、取消、unknown 重叠及原审计/延迟职责。CI 已使用同一个入口。夹具不等同于 Redis 或 HTTP 实验。

真实隔离链路：

~~~powershell
$env:JAVA_HOME = "<JDK 21>"
node verification/limiter-monitoring-live.mjs --out .dev/limiter-monitoring-<全新目录>
~~~

需要 Node 24、Docker Linux 容器、项目固定 Redis / Prometheus / Grafana 镜像及 Playwright + Edge。默认 Playwright 位于 .dev/browser/node_modules/playwright/index.mjs，可用 PLAYWRIGHT_MODULE 指定路径；BROWSER_CHANNEL 可指定已安装浏览器。使用 Docker Desktop 的 host.docker.internal 访问宿主机随机端口，其他平台需要等效主机访问方式。

入口使用既有产品 JAR、真实 Redis、受控 RESP 代理和真实上游。两个网关为 allow/allow 与 reject/reject，第三个实际网关关闭自定义指标以验证缺失。抓取/评估各 5s，沿用未缩短的告警窗口与持续时间。Redis 已执行后截留回复，并以持有命令制造本地准入饱和。回复、审计、桶状态、命令帧、Prometheus 抓取、告警时间线、Grafana 截图分别留存。故障与恢复使用明确条件、有界等待；浏览器绘制等待只服务截图。

结果与产物身份见 [验证摘要](backend-limiter-monitoring-validation.json)。证据目录保留首次验证脚本中浏览器等待、字符编码及 All 参数问题的失败运行，成功结果来自修正后的完整复跑。

## 本次实测结果（2026-10-05）

最终链路运行时间为 UTC 05:21:10–05:25:10。规则与面板文件的 SHA-256、产品 JAR 身份、端口、镜像 digest、原始请求和清理记录均在验证摘要中。

- **27 组规则场景 / 86 项断言**，包括旧告警回归；**8 组实际面板查询场景 / 97 项断言**，均通过。
- **8 组真实链路检查**通过，41 条面板表达式在 5 个阶段执行，共 205 次真实 Prometheus 查询；8 张实际浏览器截图，无页面脚本错误。
- 两个被测策略实例合计 35 次入口请求（含各自 1 次预热）；另一个关闭指标的实例有 1 次预热，共 36 次。不是容量试验。
- 10 次 Redis 已执行而回复丢失的操作，逐次保留桶状态和唯一命令帧；按策略放行或拒绝，执行结果均记录 unknown。另有一次派发后取消，unknown/cancel 计数为 1，不触发扣费未知告警。
- 严格实例未出现 FailOpen 告警；放行实例未出现 ProtectiveRejection。两种故障来源分别保留，最终动作、审计、HTTP 和上游接收量完全对账。

| 实例 | 决策/审计条数 | 入口结果 | 上游实际接收 |
| --- | ---: | --- | ---: |
| allow / allow | 18 / 18 | 200 × 16，429 × 1，客户端取消 × 1 | 16 |
| reject / reject | 17 / 17 | 200 × 4，429 × 1，保护性 503 × 12 | 4 |

严格实例 Redis 原因告警在 05:22:48 UTC 被观察为 pending，05:23:03 为 firing；本地原因在 05:22:53 / 05:23:08 转换。unknown 在 05:22:48 / 05:23:18 转换。三者均于 05:23:48 观察为 inactive，符合 15s / 30s 持续时间和滑动窗口恢复语义。此处是每秒轮询看到的时间，完整记录在 alert-transitions.json，不冒充精确的请求完成时刻。

代表截图（均为实际 Grafana，1440×1000）：

- [全部实例及指标缺失](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/01-baseline-all.png)
- [故障放行](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/03-allow-fault.png) · [保护性拒绝](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/04-strict-fault.png)
- [故障占比、决策等待和最终 HTTP 结果](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/04-strict-latency-final.png)
- [零流量统计](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/05-zero-traffic.png) · [零流量时比例的当前端点留空](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/06-zero-ratio.png)
- [指标缺失](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/08-missing-family.png) · [抓取失败](../.dev/limiter-monitoring-20261005-c0e0196f/final-evidence/09-scrape-failed.png)

历史图仍保留过去真实采样，不因当前零量/失败清空整段历史；当前卡片与区间末端不会补零伪装健康。

保留检查覆盖本轮开始前的 399 个文件，393 个未改变，其余 6 个均为计划内监控消费者/说明/CI。后端与前端源码、此前验收文件和产品 JAR 未变化。三台本轮网关正常退出，专属 Redis、Prometheus、Grafana、网络、代理、上游、浏览器和临时凭据已释放；9 个专属端口确认关闭。既有 6 个容器身份与状态保持不变。

## 迁移

1. 先确认实际网关导出新指标。旧包仅有 Timer error 时无法正确区分动作；新规则报 MetricsMissing，不猜测 fail-open。
2. **删除 ZenithRateLimitDegraded**，改订阅 FailOpen 与 ProtectiveRejection。更新 Alertmanager 路由、静默、白名单和外部链接。一个实例可因两个 event 分别产生告警，不要抹掉来源。
3. 新增 DebitUncertain 与 MetricsMissing 的接收策略。故意关闭指标的诊断环境应明确接受或定向静默 Missing，不能补零显示健康。
4. 按既有运维流程 reload/restart Prometheus；Grafana provisioning 使用原 UID 版本 2。ID=11 标题、ID=12 数据含义变化，嵌入说明需同步。旧 Timer 名称保留，外部消费者也必须纠正其 error 和计时解释。
5. observability/demo.mjs 默认 allow 演示改期待新 FailOpen 名称，并适配实例变量与当前路由版本协议。该旧固定 Compose 入口未在现有实例运行，不替代本轮隔离验证。
6. 无 Redis 格式或配置协议迁移。监控文件可回退，但不能在严格策略下重新宣称旧 error 等于放行。

不升级开发实例。验证释放其创建的 Java、浏览器、代理、上游、容器、网络和临时凭据，保留证据。异常强杀验证进程时依据专属身份清理，不清空 Docker 环境。

## 剩余边界与未执行项

- 既有限流延迟桶无法精确还原超过 1s 的分位数；图中的桶边界不是实际耗时上限，精确故障等待参考 HTTP 记录和诊断。本轮仅改正计时名称与范围，不变更指标桶。
- Prometheus 采样不是逐请求原子快照；采集前退出的事件可能丢失。精确对账用控制环境的审计与上游记录。
- MetricsMissing 只检测整个族缺失，不覆盖部分标签被错误 relabel 的所有情况。目标从发现配置中完全移除后，没有期望实例清单便无法永久告警该目标缺失；界面仍为 No data。
- instance 是端点身份，不是永久 JVM UUID。换端口会产生新时序，没有增加随机 ID 标签。
- 取消 unknown 与低于门槛的单次未知保留计数但不触发 unknown 告警；故障动作告警和审计仍可提供线索。
- 不修改业务/前端，不机械重复全部 Java、前端构建、配置/代理/限流专项，仅核查既有验收记录。远端 GitHub Actions 未实际运行，本地执行同一监控命令。
- 没有新容量、冷启动或 RSS 实验。**4000 req/s 一小时未通过，没有已通过一小时验证的容量档位**，原结论不变。
- 不扩展 Redis 故障切换保证，不调整业务可用性与严格额度之间的策略选择。

依据：[Prometheus 函数](https://prometheus.io/docs/prometheus/latest/querying/functions/)、[告警规则与 for](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)、[规则测试](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)、[Grafana 多值变量](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/variable-syntax/)。
