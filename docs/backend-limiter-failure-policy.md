# 限流故障策略与显式过载拒绝

本轮完成故障处置专项，等待验收。默认保持放行；需要额度约束的部署可以独立选择本地资源故障与 Redis 额度未确认时拒绝。没有修改六字段运行配置、桶格式、版本门栅、令牌计算、自动重试或交接默认值。

**容量结论不变：此前 4000 req/s 一小时长测未通过；本轮没有认证新的容量档位。** 保护性 503 在受控故障验证中可以符合预期，在健康容量验证中仍是失败，不能通过切换拒绝策略改写原结论。[原容量报告](backend-capacity-calibration.md)

## 行为与启动配置

`zenith.limiter` 新增两个枚举配置，只接受 `allow` / `reject`（Spring 枚举绑定不区分大小写）；拼写错误导致启动失败，不能静默退回放行。两个默认值均为 `allow`。

```yaml
zenith:
  limiter:
    local-failure-policy: allow
    redis-failure-policy: allow
    result-handoff-enabled: false
```

严格策略启动示例（不会更新 Redis 的运行配置）：

```powershell
java -jar backend/target/zg-1.0.0.jar --zenith.limiter.local-failure-policy=reject --zenith.limiter.redis-failure-policy=reject
```

| 额度事实 / 发生位置 | 应用的策略 | 放行时 | 拒绝时 |
| --- | --- | --- | --- |
| Redis 明确许可 `allowed` | 不受故障策略影响 | 继续转发 | 不适用 |
| 额度不足 `limited` | 不受故障策略影响 | 不适用 | 429，保留原子决策计算的 Retry-After |
| 单次成本超过容量 `unfulfillable` | 不受故障策略影响 | 不适用 | 429，不给无法兑现的 Retry-After |
| 准入名额满、执行器拒绝、排队截止、限流器停止 | local-failure-policy | `local_fail_open` | `local_rejected`，503 |
| Redis 连接/回复失败、执行阶段截止、等待恢复、无配置版本、桶/策略损坏等 | redis-failure-policy | `redis_fail_open` | `redis_rejected`，503 |
| 客户端在决策前取消 | 不应用故障策略 | 不转发 | 记录取消，不伪造 503 |
| 本实例运行配置显式关闭限流 | 不应用故障策略 | `disabled`，直接继续 | 不适用 |

只有**两项策略都为 reject、限流处于开启状态**时，普通匹配路由请求才能满足“必须明确获得额度许可才继续转发”。显式关闭限流仍然是原有绕过语义；管理认证、未匹配路由等也不被改成额度请求。混合策略有意保留部分故障放行能力。

这是实例级启动选择，不是自动同步的运行字段。多个实例需要协调部署相同启动参数；保存运行配置不等于所有实例立即改变故障策略。现有异步采用期间的限流开关、旧桶策略和 epoch 规则保持不变。

429 表示明确的额度拒绝；503 表示限流服务当前不能提供所选策略要求的许可，不表示“客户端额度确定为零”。本轮 503 不设置 Retry-After，因为无法从队列或 Redis 故障推导可信恢复时间。429、503 均返回 JSON 和 `Cache-Control: no-store`。[RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)、[RFC 9110 §15.6.4](https://www.rfc-editor.org/rfc/rfc9110.html#name-503-service-unavailable)

## 事实、动作、最终结果分别记录

`LimitDecision` 保留旧 `outcome / reason / execution`，增加具体资源拒绝来源和派生的 `event / action`。策略在终态选择之前应用；同一请求只选择一次终态，迟到的许可不会覆盖超时或取消。

| 字段 | 含义 |
| --- | --- |
| event / rateLimitEvent | `allowed / disabled / limited / unfulfillable / local_unavailable / redis_unconfirmed / cancelled`，描述决策事实 |
| action / rateLimitAction | `forward / reject / cancel`，描述本次决策选择；forward 不保证最终完成上游请求 |
| reason / rateLimitReason | `queue_full / queue_timeout / decision_timeout / redis_error / recovery_wait / bucket_invalid` 等既有有限词表 |
| rejectionSource / rateLimitRejectionSource | queue_full 时区分 `admission_full` 与 `executor_rejected`；其他情况可为空 |
| execution / rateLimitExecution | 见下表，描述该次扣费命令已知事实 |
| 审计原 outcome、statusCode、reason、phase | 最终 HTTP/取消结果；例如 http_error、503、limiter_local_unavailable、rate_limit |

`queue_full` 保留兼容分类，同时每条相关响应和审计都保留具体来源；不再只能依靠聚合诊断推测某一次拒绝的原因。

| execution | 能确认的事实 | 不能推断的内容 |
| --- | --- | --- |
| not_sent | 本次扣费命令未发出，例如准入拒绝、排队超时、排队中取消、恢复门短路 | 不能据此推断同 IP 的其他请求没有扣费 |
| not_written | 收到生产 Lua 的校验拒绝，脚本在变更前返回 | 不能把坏桶当作余额不足，或自动重建满桶 |
| confirmed | 收到完整额度决策；allowed 扣费，limited/unfulfillable 是明确拒绝 | confirmed 本身不等于扣费成功，必须结合 event |
| unknown | 已尝试派发，但未确认有效结果，包括超时和派发后取消 | 不能认定 Redis 未执行、不能自动退款或重发 |

尤其是：**严格模式 503、上游接收数 0、Redis 已扣令牌可以同时成立。** 网关选择保护业务转发边界，代价是这类不确定扣费可能损失可用额度。没有添加扣费操作 ID、补偿事务或重试，也没有承诺取消可以撤销 Redis 操作或已经执行的上游副作用。

原请求已选择 allowed 后再取消，保留 allowed/forward 决策，最终请求仍记录 cancelled；这不属于“故障放行”或“重新拒绝”。终态选择、HTTP 最终完成和上游实际接收是三个不同边界。

503 示例：

```json
{
  "code": 503,
  "reason": "limiter_local_unavailable",
  "limitReason": "queue_full",
  "limitEvent": "local_unavailable",
  "limitAction": "reject",
  "limitExecution": "not_sent",
  "limitRejectionSource": "executor_rejected",
  "message": "Rate limiter local resources unavailable",
  "retryAfterSeconds": null
}
```

Redis 类拒绝的顶层 reason 为 `limiter_redis_unconfirmed`。429 继续使用 `gateway_limited`。前端只补充审计结果说明，显示“资源不足 · 已拒绝”“额度未确认 · 已拒绝”和“扣费结果未知”；没有增加运行配置编辑字段。

## 指标、认证与资源所有权

- `GET /settings/rate-limit/diagnostics` 仍是受管理认证保护、禁止缓存的纯本地观察。诊断版本升为 3，增加两个已绑定策略，保留原有资源计数、传输状态和故障原因。
- `observations.events / actions / executions` 分别累积事实、动作、执行确认状态。旧 outcomes 保留，并增加 local_rejected / redis_rejected；旧 reasons 和 rejections 继续可对账。
- 新增 `zenith.ratelimit.decisions`，只使用固定 `event / action / execution` 标签，预注册 36 个组合；不使用 IP、Path、路由 ID 或随机操作 ID。指标在唯一终态处记录，与 HTTP 回调是否收到 onNext 无关。
- 原 `zenith.ratelimit.redis` 仍反映许可/额度不足/故障/取消及决策耗时，不能单独用它推断转发动作。原 `zenith.gateway.requests` 继续把保护性 503 计为 5xx/http_error；代理结果原因新增两个限流服务拒绝原因。
- 审计新增四个可空字段和资源来源；旧记录不会被伪造出这些信息。HTTP 完成记录仍只有一个入口，取消不是成功，故障放行后的上游失败仍按最终状态记录。

过滤器顺序为审计标记 -300 → 限流 -200 → 代理保护 -100。限流拒绝不会进入上游连接池或熔断器；真实代理回归继续验证限流和管理认证不计入上游失败。管理诊断不通过业务限流来恢复 Redis。

不新增连接、线程、任务或请求队列。继续沿用已有有界工作池、准入名额、截止任务、独立物理连接所有权与恢复探测：
默认 8 个 I/O worker、64 个等待位、500 ms 决策预算、1000 ms 探测周期，交接默认关闭。拒绝立即返回不代表物理命令已经消失；已发命令继续由原槽位持有到回复观察或物理关闭。离线缓冲、自动重连和自动扣费重试仍关闭。

传输探测成功只使新请求重新尝试获得额度；探测不提供许可、不补发旧请求、不退款。transportState=healthy 仅表示传输最近正常，不保证所有桶数据都合法。本地队列饱和也不必把 Redis 标为故障。具体资源保证沿用[限流可靠性说明](backend-rate-limit-reliability.md)、[交接说明](backend-limiter-handoff.md)。

## 可重复的独立验证

入口：[`verification/limiter-failure-policy-live.mjs`](../verification/limiter-failure-policy-live.mjs)。

前置：Java 21、Node 24、Docker，以及已经缓存的固定 Redis 7.4.11 镜像。先完成 Maven test-compile/package，使测试夹具 class 可用。完整后端验证时设置 `ZENITH_TEST_REDIS_PORT` 指向专属测试 Redis；未设置会跳过依赖该变量的 Redis 集成测试，不能算本轮的完整验证。

```powershell
# 使用项目既有工具链；JAVA_HOME 指向 JDK 21，Node 24 在 PATH 中。
.\mvnw.cmd -f backend/pom.xml verify
node verification/limiter-failure-policy-live.mjs
```

默认每次创建新的随机输出目录。可通过 `RATE_LIMIT_POLICY_OUTPUT` 指定一个全新的目录；不要复用历史证据目录。`RATE_LIMIT_POLICY_JAR` 可以指定待验收生产包，默认 backend/target/zg-1.0.0.jar。

验证程序自动创建专属 Redis 容器、随机端口/管理凭据/键空间、两个 RESP 故障代理、受控 HTTP 上游及独立网关进程。四个实例分别采用 allow/allow、reject/reject、reject/allow、allow/reject，另一个严格实例打开交接以检查有界结果阶段。它们共享本轮 Redis 与限流命名空间。

故障触发方式：
1. RESP 请求/回复边界分别截留，收到明确边界事件后才发起下一步。真实 Redis 中检查桶状态及命令次数。
2. 排队和执行器拒绝使用单 worker、单等待位，决策预算 1500 ms。测试专用过滤器在额度决策之后最多持有一个同步消费者 5 秒，等待“已进入”再填充队列。
3. 测试过滤器仅从独立夹具 JAR 加载，**生产 JAR 不包含该类或管理接口**；不修改生产限流器的结果、调度、连接或执行器。通过 Spring Boot 的 [PropertiesLauncher](https://docs.spring.io/spring-boot/specification/executable-jar/property-launcher.html) 加载额外夹具。夹具包保留目录项，才能被组件扫描发现。
4. 所有等待都有截止时间，取消、释放、恢复以实际诊断和协议事件为条件。没有通过任意固定睡眠碰撞饱和窗口。
5. 结束后关闭五个网关、两个故障代理和上游，并删除本轮 Redis。退出日志同时核对工作池、交接池和连接释放。

这组夹具证明可控阶段下的故障处理，不是并发容量或生产调度效率证明。主包被复制冻结，整个专项和旧回归使用相同 SHA-256。

## 实际证据与结果

证据根目录：`.dev/limiter-failure-policy-20261004`。本轮于 2026-10-04 开始、2026-10-05 完成交付整理，目录名保留启动日期。

最终包 SHA-256：

```text
ec12b79e361d44e73ab33a4da1f026a616a43ac21227957b667059308aaa38fb
```

[验证索引](backend-limiter-failure-policy-validation.json)列出参数、文件身份、原始证据路径和清理记录。成功专项原始报告为 [live-3/report.json](../.dev/limiter-failure-policy-20261004/live-3/report.json)，包含响应、诊断边界、原始 Redis 桶、帧记录、上游接收和完整审计。

| 实验 | 实际结果 |
| --- | --- |
| 四种策略独立性 | 本地饱和仅应用 local；回复丢失、断连和恢复门仅应用 redis |
| 准入饱和 | 捕捉名额 0、I/O 队列 1、物理命令 1；具体来源 admission_full |
| 执行器拒绝 | 同步消费者已占用 I/O worker，队列 1 但仍有准入名额；具体来源 executor_rejected，未发扣费命令 |
| 排队截止 | queue_timeout / not_sent；默认继续，严格 503，上游接收 0 |
| 已执行、回复丢失 | 四种组合分别验证；每例原子扣费一次，100 个额度扣为 99；无重试、无退款；拒绝案例上游 0，仍记录 unknown |
| Redis 断连及恢复门 | 实际断连后 unknown；恢复门短路 not_sent；解除后自动探测恢复，新请求取得独立 confirmed 许可 |
| 取消 | 两种模式各验证排队中取消及扣费后取消；四次最终取消，未产生上游请求，审计各一次 |
| 格式损坏 | JSON false 仍保留，不重建；收到 Lua not_written，严格 503，默认放行 |
| 429 与不可能成本 | 都有真实 Redis 决策；只有可恢复额度不足提供 Retry-After |
| 交接开启 | 一个活跃交接任务＋一个等待结果、物理命令 0，第三个请求仍在准入处拒绝 |
| 无额外配置读取 | 严格实例真实转发 5 次＋本地诊断，新增运行配置 Redis 查询 0；后台读取单独识别 |
| 参数拼写错误 | 两个配置项分别真实启动拒绝，退出码非 0 |
| 清理 | 五个实例退出 0，命令、I/O/交接队列、保留任务最终 0，两个名额全部归还；原有六个容器 ID/状态不变 |

专项 **25 组检查、70 个请求（包括 5 个预热请求）**：
41 个 200、4 个 429、21 个预期 503、4 个未形成 HTTP 状态的主动取消。上游实际接收 41 个；25 个拒绝和4个取消均未到达上游。70 次终态分别与审计、固定标签指标逐项对账，没有丢弃、未确认审计或重复最终记录。

严格主实例 27 次决策：10 次明确许可、1 次显式关闭绕过、2 次额度拒绝、12 次故障策略拒绝、2 次取消。故障放行 0；没有把显式 disabled 偷算为明确许可。

本轮测试预算为 1500 ms，70 个请求的最大实际耗时约 1590.28 ms，包含线程调度和记录开销。10 次故障解除后自动恢复确认耗时为 **38–275 ms**，使用实例恢复时间减故障释放时间；这是隔离环境实测，不是硬实时 SLA。排空时保留一个有界周期探测任务是正常运行状态，应用关闭后也被停止。

| 执行的回归 | 结果 |
| --- | --- |
| 后端完整 Maven verify（真实专属 Redis） | 236 项，失败/错误/跳过均 0；生产打包通过 |
| 前端完整测试、生产构建 | 107 项通过；构建通过，保留既有 ECharts 大块提示 |
| 原限流真实验证，交接开启、策略默认 allow | 22 组／181 请求通过，包括暂停、回复丢失、取消、迁移、对账和关闭 |
| 原代理真实故障验证 | 24 组／102 请求及两项启动拒绝检查通过 |
| 原容器与源码保留核查 | 原有文件无删除；只改本轮明确列出的文件；原容量和历轮证据未改 |

没有只保留成功实验：首次测试 Redis 使用未缓存短标签的启动失败、live-1 的重复 CLI 参数绑定失败、live-2 的测试夹具包缺少目录索引，均已记录；后两次自动清理后修正验证入口再运行 live-3。它们是验证基础设施问题，不能当作生产功能通过证据。修改后的共用启动器将相同命令行键归一为最后一次值，避免 Spring 把重复值拼成列表；旧限流入口已实跑回归。

## 迁移、部署、回退和剩余边界

没有 Redis 桶格式、运行配置或路由协议迁移，不需要改已有数据。新增参数、诊断 schema 3、审计可空字段及两种拒绝 outcome 属于接口扩展；消费者不能再假定 outcome 只有旧七种值，也不能把所有限流故障归入放行。

部署前先升级监控/审计消费者，再在独立环境验证选定策略。业务要求严格额度时，须协调所有接流实例使用新版与 reject/reject，并检查本地诊断的实际绑定值；不能把一个实例的设置当作全体实例的保证。本轮没有升级现有开发实例。

格式回退不需要改 Redis。但**旧程序没有这两个故障策略，即使配置文件写了 reject 也不能提供同样的保证**。回退旧包前必须明确接受恢复故障放行；不能在业务要求严格许可时静默回退。旧审计消费者也可能不识别新 outcome，需保留新字段或明确标为未知，而不是改写成额度不足。

本轮保证的是选定策略下的故障处置，不包括：
- 新的健康容量认证、长测、冷启动接流优化或 RSS 增长归因。
- 新的扣费幂等、自动退款、自动重试、Redis 故障切换/数据丢失后的永久额度保证。
- 运行时修改故障策略、集群同步启动策略或立即传播限流开关。
- Redis 已接收命令但回复丢失时的原操作结果查询；unknown 仍然未知。
- 新浏览器截图或交互录屏；前端仅修改审计说明并执行完整自动测试/构建。
- 独立重跑配置同步/回执/回滚、路由发布的所有外部专项入口；相关后端完整测试以及限流脚本使用的真实配置保存/同步、路由建立流程本轮已执行。

保留 [Redis 单权威、数据保留与时间边界](backend-rate-limit-reliability.md) 和 [代理取消、副作用边界](backend-proxy-resilience.md)。本轮完成后停在验收，冷启动接流和 RSS 专题不自动扩展。
