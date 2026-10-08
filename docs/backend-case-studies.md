# 三个可以复验的后端工程案例

建议先讲可观察的问题，再说明选择与边界。测试用例数、故障组数和请求数分别统计；早期录屏、历史包和当前候选不混用。版本与原始证据从[索引](evidence-index.md)进入。

## 1. 配置一致性、幂等提交与安全回滚

**问题。** A、B 同时读到版本 18。A 把窗口 10 改为 30 秒；B 的旧整表随后提交，可能把窗口覆盖回 10 秒。若 Redis 已写入但回复丢失，GET 当前值也无法证明那次操作是否执行。历史恢复还需要防止使用过期或前端伪造的来源。

**取舍。** 保持一个 Redis 权威源，用 Lua 对完整状态做条件发布，代理只读本地快照。后台周期拉取简单且能补偿遗漏，但接受各实例异步采用；不建设新的配置中心。回执容量有界，不能为了接收新操作提前淘汰仍在保证期内的记录。

**实现。** 六字段与带世代版本组成不可变快照；本地一次发布引用，避免混合字段。存储核对 expectedVersion、operationId 及规范化请求。先识别已有回执，再执行新操作；配置、成功回执和必要记录共同发布。恢复来源由服务端在同一决策内核实，恢复版本 12 的参数时从 18 生成 19。前端冲突保留草稿，明确核对后生成新操作；查旧回执不会回退当前基准。

**故障验证。** 同版本并发只能一方成功；相同 ID 同请求只执行一次，换内容或操作类型被拒绝。分别切断 Redis 回复与 HTTP 回复，按原 ID 确认事实；存在后续版本时，原操作重试返回旧回执但不覆盖新配置。裁剪来源后，新恢复拒绝，而已成功恢复的回执在保证期内仍成立。同步失败期间保留完整旧快照，恢复后自动追赶。

**剩余边界。** AtomicReference 解决本实例发布，CAS 解决存储并发，幂等回执解决操作归因，三者不能互相替代。24 小时 / 512 条活动回执与 7 天 / 100 条历史有不同保留职责。没有可用回执就是无法确认，不等于未执行；单 Redis 保证不扩展为故障切换后的永久 exactly-once。保存成功不表示全部实例已采用。

代码入口：[快照](../backend/src/main/java/com/zch/config/RuntimeConfigSnapshot.java)、[持久化](../backend/src/main/java/com/zch/config/RuntimeConfigPersistence.java)、[原子决策](../backend/src/main/resources/runtime-config.lua)、[后台同步](../backend/src/main/java/com/zch/config/RuntimeConfigSync.java)。

复验入口：统一 release 层的 `config-sync`、`config-operations`、`config-rollback`；单独入口在 [verification](../verification)。[完整协议](backend-config-rollback.md)区分 Lua 串行执行、中途命令错误、回复丢失与 Redis 持久性，不能只说“Lua 是原子的所以全部可靠”。

面试追问：如果查询期间又提交了版本 20，为什么仍能确认操作 X 产生的是 19？为什么恢复不是把版本号改回 12？如果回执到期而值相同，能确认什么？

## 2. 限流故障策略、资源上限与请求对账

**问题。** 同 IP 跨实例共享令牌桶时，网关时钟不同、旧策略迟到或本地请求堆积都可能影响额度或故障表现。Redis 执行后丢回复，不能被说成“未扣费”；429、基础设施错误与客户端取消也不应统称为同一种失败。

**取舍。** 使用 Redis 时间，在原子决策中防止计费时间倒退；已有桶切换策略，避免每次更新创建满额桶。保持原来的默认故障放行，同时提供本地饱和和 Redis 未确认两项独立启动策略。严格模式可能牺牲可用性，但无需假装取得额度许可。交接模式继续默认关闭。

**实现。** 准入、等待队列、客户端命令和结果交接各有容量及生命周期。客户端离线行为和物理连接关闭也纳入边界，不能只靠 Mono.timeout 声称底层已停止。明确许可才记 allowed/forward；额度不足返回 429；故障动作是 forward 或保护性 503。execution=unknown 是独立维度，最终 HTTP、上游接收和审计另外对账。

**故障验证。** 双实例共享桶，按实际测试期间补充量核对合计额度；独立客户端互不影响。注入队列饱和、执行器拒绝、Redis 断连、已执行但丢回复、取消和恢复。严格拒绝上游接收为 0；不盲目重试或返还令牌。JSON false 的补验保证非法数据不会被当成缺失键重新初始化。Prometheus/Grafana 分开显示故障放行、保护性拒绝和扣费未知。

**剩余边界。** fail-open 放行不具备额度保证；fail-closed 也不能证明 Redis 没有扣令牌。Retry-After 是建议，不预留未来额度；成本大于容量时不能返回虚假的恢复秒数。策略异步传播期间不是全局同时切换。取消结束网关工作，不撤销上游副作用。

代码入口：[有界客户端](../backend/src/main/java/com/zch/ratelimit/RedisRateLimiter.java)、[决策模型](../backend/src/main/java/com/zch/ratelimit/LimitDecision.java)、[令牌桶](../backend/src/main/resources/rate-limit.lua)、[入口过滤器](../backend/src/main/java/com/zch/filter/RateLimitFilter.java)。

复验入口：统一 release 层的 `rate-limit`、`rate-limit-malformed`、`limiter-policy`；[故障策略说明](backend-limiter-failure-policy.md)和[监控语义](backend-limiter-monitoring.md)。健康容量阶段的保护性 503 仍然失败，不能因为故障注入允许它就放松容量门禁。

面试追问：为什么未知扣费不能加进请求总数？响应丢失为何不直接重试？“8 个工作线程”为什么不自动等于“最多 8 条未完成 Redis 命令”？

## 3. 容量校准、计数竞态修复与 RSS 归因

**问题。** 早期高负载出现本地准入饱和，4000 req/s 一小时未通过；低负载的健康样本又出现“实际只有 1 条命令等待，当前值/峰值却为 2/2”。另一个现象是停流后 RSS 不回落，既可能是保留页，也可能有未回收对象，不能仅凭曲线认定泄漏。

**取舍。** 先修正可确定的生命周期竞态，再分析内存。固定包、逻辑 CPU、容器/JVM、额度及发生器门禁，保留预热与失败；不以增加线程掩盖诊断错误。内存实验最多两轮；健康窗口不主动 Full GC、trim 或重启。只对具体假设单独安排一次停流干预。

**实现。** 命令计数在结果被认领或物理关闭确认的边界结算，完成、超时、取消与重复回调之间只退休一次，解码/同步下游占用不冒充待回包命令。实验工具核对全部响应路由版本、逐样本同步状态、计数器重置、真实容器退出码；分开记录 heap used/committed、NMT committed、RSS、cgroup、GC 类型和资源计数。

**失败与修复证据。** 同一个受控回调夹具：旧包实际等待 1、报告当前/峰值 2/2；修复包为 1/1，最终计数归零。原始一小时属于 `aed33ee0…`；修复包 `3f73c65c…` 另行完成一小时：3,599,568 次 200，P95/P99 3.869/5.555 ms，计划到达缺口 0.012%，故障动作/扣费未知为零，上游与审计相符，命令累计峰值 8/8。最大延迟 472.063 ms 仍公开，没有只展示漂亮的分位数。

**RSS 证据。** 正式窗口 RSS 584.98→617.73 MiB；同一对 smaps 检查点中 Java 堆驻留 +17.39、其他匿名 +14.05、代码缓存 +1.50 MiB。年轻代 GC 后**堆占用** 39→57 MiB，不能简称旧代或当作精确存活集。直接缓冲、Java 线程稳定，停流任务和连接归零。第二轮单次原生回收使其他匿名 RSS 降约 103.75 MiB，堆/代码驻留不变且比较期无 GC，支持分配器保留页；一分钟后又回升约 5.73 MiB，也保留在证据中。

**剩余边界。** 一小时健康窗口通过，与内存平台未证明同时成立。trim 后下降不是自然稳定，不排除泄漏；NMT 分类不能与 RSS 相加，也不能把所有匿名增量都归给 Object Monitors。新构建哈希没有自动继承容量结论。默认 bridge 标识变化仍未归因，跨轮绝对 RSS 不作为受控因果对照。

代码入口：[计数生命周期与屏障测试](../backend/src/test/java/com/zch/ratelimit/RedisRateLimiterCommandTest.java)、[旧新产物对照入口](../verification/limiter-command-counter-race.mjs)、[完整容量门禁](../benchmarks/conservative-capacity-gates.mjs)、[RSS 观察](../benchmarks/rss-observation.mjs)。

复验：当前包竞态测试属于后端全量；历史旧新包对照需要指定并核对各自 JAR，不能拿重建包冒充原包。仓库证据包可离线解压后重算 RSS；重新负载实验见[入口说明](../benchmarks/CONSERVATIVE-CAPACITY.md)，不是提交 CI 的默认内容。

面试追问：为什么空闲 RSS 不降不能证明泄漏？为什么 young GC 后占用不是存活量？两个源码相同的 JAR 哈希不同，能把性能结果直接挪过去吗？

## 用一句话交代性能

**单实例、4 个逻辑 CPU、1 GiB、小 HTTP 响应条件下，1000 req/s 一小时容量窗口通过；长期内存稳定性仍未证明，4000 req/s 一小时未通过。**

这句话之后应立即给出具体 JAR 哈希、32 路由/无 TLS/非持久化 Redis 等条件和[证据入口](evidence-index.md)。取消与排空的两次竞态补验、真实 LB 替换仍是可继续深挖的补充案例，见[生命周期](backend-traffic-lifecycle.md)与[滚动替换](backend-rolling-replacement.md)，不丢弃此前失败实验。
