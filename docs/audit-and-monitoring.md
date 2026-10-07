# 第二轮运行说明：独立监控与有界审计

本轮保持 Java 21、Redis 7.4 和现有 Redis List 查询接口。入口由 `RequestCompletionRecorder` 包住完整 HTTP 处理器；`AuditLogFilter` 仅标记进入代理链的请求。异常处理、超时 fallback、内部转发完成后记录一次，管理接口不计入业务流量。

## 指标语义

- `zenith.monitor.enabled` 默认 `true`，独立于 `zenith.audit.enabled`。关闭审计仍会产生 QPS、延迟、状态分布及累计完成数。
- `requestCount` 是当前按秒划分的窗口内已结束请求数；`qps = requestCount / windowSeconds`，不是最近一秒的瞬时 QPS。
- `completedTotal` 是本进程启用监控后结束的代理请求总数，包括成功、错误和取消。
- `outcome` 为 `completed`、`http_error`、`error` 或 `cancelled`。`statusCode=0` 表示未形成可观察的响应状态。取消后若响应已提交，保留已提交状态并仍标记取消。
- 直方图记录全部请求：0–100 ms 采用 1 ms 边界，此后桶宽最多为下边界的 5%。按桶上界报告 P95，范围内取整误差不超过 `max(1 ms, 实际值 × 5%)`。
- `cancelled`、`errors`、`unknownStatus` 分别统计取消、终止异常和未确定 HTTP 状态的请求；它们可能与 HTTP 状态桶重叠，不应相加作为请求总数。
- 超过 60,000 ms 的请求计入 `latencyOverflow`；若 P95 落在溢出桶，`p95LatencyMs=-1`。仪表盘显示 `> 60000 ms`，趋势图留空，避免伪造精确延迟。
- 并发写入时窗口的各字段可能跨越不同采样时点；停止流量并完成回调后计数一致。窗口保留最多 120 秒，历史快照最多 600 条。

## 审计配置

以下配置在启动时生效；原有运行时设置 API 不改动这些参数。

| 属性（前缀 zenith.audit） | 默认值 | 作用 |
| --- | --- | --- |
| enabled | true | 是否接收审计记录 |
| buffer-size | 20000 | 排队、组批和在途事件合计数量上限 |
| buffer-max-bytes | 16777216 | 事件内存预留总上限，16 MiB |
| event-max-bytes | 65536 | 单事件预留及序列化大小上限 |
| batch-size | 100 | 单批最多事件数 |
| batch-max-bytes | 262144 | 单批预留大小上限 |
| flush-interval-ms | 20 | 无积压时组批最长等待，实际可见时间还包括调度和 Redis 往返 |
| command-timeout-ms | 1000 | 每次连接建立与命令执行共用的超时预算 |
| retry-max-elapsed-ms | 10000 | 批次重试总预算 |
| dedup-ttl-seconds | 120 | Redis 批次标记有效期，启动时校验大于重试/命令预算 |
| shutdown-drain-timeout-ms | 5000 | HTTP 优雅停止后继续排空的预算 |
| redis-key | zg:audit:events | 保留现有 Redis List |
| redis-max-entries | 5000 | 最近记录保留数，正常裁剪不属于丢失 |
| host / port | 空 / 0 | 默认复用主 Redis 地址，可为审计连接单独指定测试代理 |

内存预留使用保守估算：`512 + 12 × 字符串总 UTF-16 长度`，覆盖事件、原始字符串和转义 JSON。它不是 JVM 实际堆占用；固定的线程、连接、直方图等开销另计。总数量和总预留字节任一达到上限都会拒绝新事件，不等待队列空位。默认字节预算通常先于 20,000 条数量上限触发，取决于路径长度。

请求线程仅复制不可变字段、更新监控、尝试入队。JSON 序列化和 Redis 命令由单个后台线程执行。独立 Lettuce 客户端的命令队列上限为 8，包含连接握手命令；应用始终只有一个批次在途。关闭自动重连和离线命令缓冲；失败后由 worker 重新建连并重试同一批次。

## 状态查询与对账

使用管理凭据访问 `GET /monitor/audit/status`。仪表盘每 5 秒独立刷新审计状态；审计状态读取失败不阻断业务监控 SSE。

| 字段 | 含义 |
| --- | --- |
| received | 审计入口收到的事件，含被明确拒绝的事件；重试不重复计数 |
| persisted | 收到 Redis 成功确认的事件，含同批次去重确认 |
| dropped / droppedByReason | 明确未写入的丢弃事件及原因 |
| uncertain | 重试预算耗尽或停机时，已尝试写入但无法确认结果的事件 |
| queueDepth | 等待后台处理的事件数 |
| inFlight | 已取出组批、序列化或正在写入/重试的事件数 |
| pending | queueDepth + inFlight |
| reservedBytes | 所有 pending 事件的预留字节 |
| oldestAgeMs | 最早 pending 事件的等待时长 |
| retries | 重试次数 |
| lastBatchSize / lastBatchDurationMs | 上一批次大小及包含重试的处理时长 |
| lastSuccessAgeMs | 距上次成功确认的时间；尚未成功时为 null |

固定丢弃原因：`queue_full`（数量上限）、`byte_limit`（字节上限）、`oversized`（单条过大）、`serialization`（序列化失败）、`shutdown`（停机后新事件或排空预算耗尽的未发送事件）。日志至多每 10 秒汇总一次，事件计数不采样。

同一进程停止流量并完成回调后，必须满足：

```text
received = persisted + dropped + uncertain + pending
```

状态端点在同一锁下读取上述审计状态。Actuator 各指标独立采集，不保证跨指标原子快照。保留 `zenith.audit.received/persisted/dropped`，新增 `uncertain/retry/pending/inflight/queue.depth/queue.bytes/oldest.age/last.success.age/batch.size/batch.duration`；年龄单位为毫秒，Timer 采用 Micrometer 时间单位。

## Redis 故障与去重边界

批次使用稳定 ID 和固定内容重试，通过 Lua 执行多值 LPUSH、一次 LTRIM 及批次标记。新记录包含 `eventId` 与 `outcome`；旧 JSON 仍能读取。列表遵循最新入队记录在前，不保证跨线程实际发生时间的全局顺序。

`persisted` 表示 Redis 已确认执行，不表示已落盘。超时可能发生在 Redis 已执行之后，因此超时不会直接记为明确丢失。重试在同一 Redis 实例且去重标记仍有效时避免重复追加；Redis 数据丢失、故障转移、标记被提前删除或 Lua 运行期间的部分写入错误超出此保证。Lua 原子执行不等于出错回滚。本轮不承诺 exactly-once。

目前支持 standalone Redis，沿用主 Redis 的数据库、认证和 TLS 开关（使用 JDK 默认信任库）。Redis Cluster/Sentinel 不在本轮支持范围；Cluster 还需要同槽 key 设计。独立连接隔离客户端积压，不能隔离同一 Redis 实例的 CPU。主 Redis 整体延迟仍会影响限流器的 500 ms 超时和 fail-open 行为。

## 停机与降级

`server.shutdown=graceful` 先停止接收新 HTTP 请求并等待在途请求；审计 worker 的生命周期阶段低于 Web Server 的优雅停机阶段，随后关闭审计入队，在 5 秒排空预算内继续写入。超时后，已尝试批次记为 uncertain，尚未发送的事件记为 shutdown。连接资源清理可能额外使用约 1 秒；Spring 生命周期总超时应覆盖 HTTP 排空及资源清理。

强制杀进程、断电和 JVM 崩溃会丢失尚在内存的队列及本进程计数，重启不会恢复它们。需要跨进程可靠审计时，应另行引入持久化日志或消息存储。

紧急降级可在重启时设置 `ZENITH_AUDIT_ENABLED=false`，监控默认继续工作；需要同时停用监控时再设置 `ZENITH_MONITOR_ENABLED=false`。恢复原值后重启即可。旧版 `/monitor/audit/recent` 读取接口和 List key 保持兼容。

## 验证入口

```powershell
docker compose -f benchmarks/compose.yml up -d --wait
$env:ZENITH_TEST_REDIS_PORT = '16379'
mvn -f backend/pom.xml verify
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
docker compose -f benchmarks/compose.yml down
```

测试 Redis 必须是项目专用实例。性能测量命令和故障注入见 [benchmarks/README.md](../benchmarks/README.md)。第一轮基线保留在原报告中；本轮比较以“确认完整写入”为前提。
