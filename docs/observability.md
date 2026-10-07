# 运行就绪、监控与故障演示

本轮在现有网关、管理控制台和审计队列上增加运行保障。默认启动仍使用根目录的 `dev.ps1`。Prometheus / Grafana 是单独的可选运行环境。

## 启动边界

HTTP 端口开始监听不代表启动完成。网关在 Spring 发布 `ACCEPTING_TRAFFIC` 之前，对业务及管理操作返回 503，并附带 `Retry-After: 1`。Actuator 继续遵循自身鉴权规则，以便探针和监控观察启动过程。

- `/actuator/health/liveness`：进程存活状态。
- `/actuator/health/readiness`：是否已完成启动、接受流量。`dev.ps1` 和容器健康检查使用此地址。
- Redis 中不存在运行配置键：使用应用默认配置。
- Redis 配置读取失败、超过 5 秒或 JSON 无法解析：启动失败，修复 Redis / 配置后重启。
- 运行中限流故障按 local-failure-policy / redis-failure-policy 处理，默认 allow，可显式 reject 为保护性 503。readiness 不因 Redis 健康检查失败而自动变红。故障动作和审计异常由独立指标、告警反映，存活探针不依赖 Redis。

这避免配置恢复之前短暂使用默认限流参数接受请求。真实服务器启动窗口已有集成测试覆盖；并非仅模拟一个布尔开关。

## 启动监控环境

需要 Java 21、Node 24 和运行 Linux 容器的 Docker。先在项目根目录构建可执行 JAR：

```powershell
.\mvnw.cmd -f backend/pom.xml verify
node observability/setup.mjs
docker compose -f observability/compose.yml --profile demo up -d --build --wait
```

Linux 使用 `bash ./mvnw -f backend/pom.xml verify`，后两条命令相同。未设置 `ZENITH_TEST_REDIS_PORT` 的普通 verify 会跳过依赖真实 Redis 的测试；完整验证见下文。

| 地址 | 用途 |
| --- | --- |
| http://127.0.0.1:18083/actuator/health/readiness | 网关就绪状态 |
| http://127.0.0.1:19090 | Prometheus 查询、Targets 和 Alerts |
| http://127.0.0.1:13000/d/zenith-operations | Grafana 看板 |

Grafana 用户为 `admin`；密码在本机 `.dev/observability/secrets/grafana-password`。管理员令牌和采集令牌分别保存在同目录 `admin-token`、`metrics-token`。初始化只创建缺失文件，不覆盖现有凭据。Docker Compose 将其作为文件挂载，不把明文写进配置、镜像或 URL。文件已被 Git 忽略。

端口只绑定回环地址；Redis 没有宿主机端口，使用独立命名卷，不复用开发环境 6379 的 Redis。数据库、监控时序和 Grafana 数据会保留。停止：

```sh
docker compose -f observability/compose.yml --profile demo down
```

普通 `down` 保留数据卷。Grafana 初始密码只在首次创建数据库时生效，之后修改本机密码文件不会自动修改已有账户密码。

## 鉴权与指标

Prometheus 每 5 秒使用独立 Bearer 采集令牌访问 `/actuator/prometheus`。此令牌仅能访问该端点，不能管理配置、查询审计、订阅 SSE 或关闭应用。管理员令牌也可以采集。即便显式 dev 模式关闭普通管理鉴权，Prometheus 端点也要求有效令牌。生产部署仍需按实际网络边界配置 TLS 和外部入口。

主要指标：

| 指标族 | 含义 |
| --- | --- |
| `zenith_gateway_ready` | Spring readiness 状态 |
| `zenith_gateway_requests_seconds_*` | 进入路由链的请求完成数及耗时分布，按状态码类别与完成结果分类 |
| `zenith_ratelimit_redis_seconds_*` | 限流决策等待，包含本地排队、连接、Redis 等待和结果交接；不是 Lua 执行时间 |
| `zenith_ratelimit_decisions_total` | event / action / execution，分别表示事实、动作与扣费确认程度；unknown 是重叠维度 |
| `zenith_audit_*` | 收到、确认、丢弃、未知、排队、在途、预算与等待年龄 |
| JVM / process 标准指标 | 堆使用量、CPU、GC 等 |

请求完成只记录一次；限流 Timer 在决策传递或取消时完成，不包含后续上游响应时间；旧 error 同时包含故障放行和保护性拒绝，不能据其判断动作。自定义请求指标最多 7 × 4 组标签，旧 Timer 指标 4 组，新决策指标预注册 36 组；不把客户端 IP、原始路径作为标签。内置 HTTP URI、Gateway routeId 标签分别设 100 值上限，超过上限的对应时序不再注册。

27 个看板面板包含实例筛选、监控数据状态、许可、显式绕过、429、故障放行、保护性 503、扣费未知、决策等待、最终请求结果及原审计/JVM/告警。unknown 不与动作分类相加；故障占比分母为全部已终结限流决策（含 disabled/cancel），零流量时留空。Prometheus histogram 分位数是桶内插值估算；`increase()` 也是按采样窗口外推，可能显示小数。精确事件对账使用 `/monitor/audit/status` 的累计计数；年龄原始指标单位是毫秒，看板换算为秒。

`zenith.observability.enabled=false` 仅用于性能诊断：关闭自定义请求/限流 Timer 和决策计数器，仍保留就绪指标及既有审计指标。它不关闭管理鉴权。新规则会如实报告决策指标缺失，不把这种诊断设置当作健康零流量。

## 故障演示

环境启动后，在根目录运行：

```sh
node observability/demo.mjs
```

脚本检查采集凭据权限、Prometheus target、Grafana provisioning，创建唯一测试路由并暂存原运行配置，随后执行：

1. 健康状态发送 25 秒、120 次/秒请求。
2. 只暂停此 Compose 项目的 Redis 40 秒，同时继续请求。
3. 恢复 Redis，继续请求 30 秒，等待队列排空与告警解除。
4. 校验每个阶段响应、审计计数守恒、看板的全部查询；删除测试路由、恢复运行配置。

期望至少观察到 `ZenithAuditUncertain` 和 `ZenithRateLimitFailOpen`。积压和延迟告警是否进入 firing 还受 5 秒采样边界、负载影响。失败会返回非零退出码，报告保存在 `.dev/third-round/observability-result.json`，不包含令牌。

脚本正常异常退出和终端中断会恢复 Redis；若执行进程被强制杀死，可手动恢复：

```sh
docker compose -f observability/compose.yml unpause redis
```

告警定义位于 `observability/prometheus/alerts.yml`，包括采集不可用、审计停滞、预算压力、丢弃、结果未知、限流故障放行、保护性拒绝、扣费未知、指标缺失及 P95 延迟。阈值是演示起点，需按业务 SLO 调整。当前告警在 Prometheus / Grafana 中可见，未配置邮件、短信或外部通知。

审计是有界内存队列加 Redis 批量写入。故障中的 unknown 表示“可能已提交，但确认未收到”，不能当作明确丢失或确认成功。告警解除只说明近期不再出现异常，不会追回历史记录；没有新增跨进程持久化缓冲或 exactly-once 保证。

## Linux 复验

```sh
node observability/setup.mjs
docker compose -f observability/compose.yml --profile verify build verify
docker compose -f observability/compose.yml --profile verify run --rm verify
```

验证镜像固定 Microsoft JDK、Node 和 Redis，与宿主机 JDK 无关。任务使用专用 Redis 网络命名空间，执行 Maven verify、npm ci、前端测试和构建；结果在 `.dev/third-round/linux/`。下载缓存保存在本机 `.dev/linux-m2` 和独立 npm 卷；可用环境变量 `ZENITH_MAVEN_REPOSITORY` 指向已有 Maven 依赖缓存。不要在故障演示暂停 Redis 时并行运行此测试。

GitHub Actions 使用 node observability/test-monitoring.mjs，同时执行告警规则与实际 Grafana 查询的语义回归。完整验证镜像会下载系统工具与依赖，首次构建较慢。

依据：[Spring Boot 启动事件顺序](https://docs.spring.io/spring-boot/reference/features/spring-application.html)、[Actuator metrics](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)、[Prometheus 规则测试](https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/)、[Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)。

容器启动命令显式启用 G1，避免资源限制变化时 JVM 自动选择不同收集器。初始 1 GB 容器的 JFR 实测使用了 Serial；原因与 [JDK 21 的自动选择规则](https://docs.oracle.com/en/java/javase/21/gctuning/ergonomics1.html)一致。性能比较必须固定收集器、堆及 CPU 条件。

## 限流故障策略的监控补齐

告警迁移、unknown 抑噪、完整计时边界、独立验证入口、实际截图与剩余边界见 [本轮设计与验证](backend-limiter-monitoring.md) 和 [验证摘要](backend-limiter-monitoring-validation.json)。本轮未升级现有开发实例。
