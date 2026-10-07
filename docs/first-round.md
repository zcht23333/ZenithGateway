# 第一轮优化：使用与验证

## 管理端认证

默认环境和 `prod` 环境必须设置 `ZENITH_ADMIN_TOKEN`，缺失时启动失败。仅显式使用 `dev` 且没有同时启用 `prod` 时允许空密钥；即使在 dev 中，设置了密钥也会启用认证。

```powershell
$env:JAVA_HOME = '你的 JDK 21 安装目录'
$env:SPRING_PROFILES_ACTIVE = 'prod'
$env:ZENITH_ADMIN_TOKEN = '替换为足够长的随机凭据'
mvn -f backend/pom.xml spring-boot:run
```

打开前端后，在连接页面输入相同凭据。凭据只保存在页面内存，刷新后需重新输入；不要将它放入 `VITE_*`、源码或浏览器存储。生产部署通过 HTTPS 访问管理端。

管理接口 `/settings/**`、`/monitor/**`、`/dashboard/**`、`/actuator/**` 需要认证；精确路径 `/actuator/health` 可用于健康检查。REST 接口使用 `Authorization: Bearer <token>`，不接受 URL 内的管理密钥。SSE 使用从受保护接口获取的专用令牌，且该令牌只允许访问 `/monitor/stream`。SSE 令牌响应禁止缓存，前端重连会重新获取令牌。

## 本地与生产前端地址

默认请求 `/api`。Vite 开发服务器只监听本机，将该前缀代理到 `http://127.0.0.1:8080` 并移除 `/api`。

复制 `frontend/.env.example` 到 `frontend/.env.local` 后，可设置：

- `GATEWAY_PROXY_TARGET`：本地开发代理的后端地址。
- `VITE_API_BASE_URL`：公开的 API 地址，不是凭据。

生产部署需要在反向代理中把 `/api/*` 转到后端并移除 `/api`，关闭 SSE 响应缓冲；也可将公开的 API 基址设为后端 HTTPS 地址，并在后端配置准确的 CORS 来源。Vite 的开发代理不会随静态构建产物发布。

前端统一处理非 2xx 响应及超时，保留失败前的有效列表；401 会返回凭据输入页面。监控连接显示在线或断开状态，按 1–30 秒退避重连，离开页面后停止连接与重试。日志每 5 秒刷新，单次刷新完成后才安排下一次。

## 可信代理与客户端 IP

默认 `zenith.proxy.trusted-proxies` 为空，限流和审计使用 TCP 对端地址，忽略客户端传入的转发头。部署在代理后时，只填写真实代理地址或精确网段，例如：

```yaml
zenith:
  proxy:
    trusted-proxies:
      - 10.20.0.10/32
      - 2001:db8:100::10/128
```

只有直接连接的对端可信时，才解析 `X-Forwarded-For`，并从右往左遍历可信代理，取第一个不可信地址作为客户端；无 XFF 时可使用可信代理提供的 `X-Real-IP`。无效 IP、过长或过多跳数的头回退到对端地址，不执行 DNS 查询。

入口代理应覆盖或规范追加转发头，禁止外部客户端伪造可信链。保留 `server.forward-headers-strategy: none`，以便此解析器看到原始对端地址。多个实例必须使用相同的可信代理配置。

## 动态路由校验与兼容性变化

保存路由时，URI、路径、启用的重写规则及 fallback 必须有效，否则返回：

```json
{"code":400,"field":"uri","message":"uri must be a valid http(s) address without credentials, query or fragment"}
```

- 必填 `path`、`uri`。当前支持 HTTP/HTTPS，未集成服务发现，因此不接受 `lb://`。
- URI 不接受内嵌凭据、query、fragment 或无效端口。
- ID 可省略并生成 UUID；显式 ID 限 1–100 个字母、数字、点、下划线、连字符，首字符为字母或数字。
- 启用重写时校验正则和替换串引用的分组；省略正则仅适用于以 `/**` 结尾的路径，自动生成的正则会转义路径中的点等字符。
- 当前实现的 fallback 为 `/fallback/default`，其他启用的 fallback 会被拒绝。
- 历史 Redis 中的坏路由跳过并告警，不再自动改成外部网站。升级前检查现有路由配置。
- 保存成功表示配置已持久化并触发刷新；路由缓存刷新仍是异步的，集成测试会等待实际转发生效。

## 测试与 CI

```powershell
mvn -f backend/pom.xml test
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

普通后端测试不要求 Redis；真实 Redis 集成测试默认跳过。运行完整检查：

```powershell
docker compose -f benchmarks/compose.yml up -d --wait
$env:ZENITH_TEST_REDIS_PORT = '16379'
mvn -f backend/pom.xml verify
Remove-Item Env:ZENITH_TEST_REDIS_PORT
docker compose -f benchmarks/compose.yml down
```

只将集成测试指向专用 Redis。测试会写入集成路由、运行配置和本地客户端限流键。提供的容器绑定本机 16379，关闭磁盘持久化，与常用的 6379 实例分开。

GitHub Actions 工作流 `.github/workflows/verify.yml` 在 push/PR 时执行后端单元及 Redis 集成测试、前端行为测试和生产构建。

## 本轮性能测量

见 [压测说明](../benchmarks/README.md)。本轮增加启动时的 `zenith.audit.enabled` 开关，以及以下受管理端认证保护的 Actuator 指标：

- `zenith.audit.received`：进入审计发布入口的记录数。
- `zenith.audit.persisted`：完成 Redis 写入和裁剪的记录数。
- `zenith.audit.dropped`：事件流发射失败数，带 `reason` 标签。

审计开关关闭时，依赖审计事件的看板统计也停止增长。此开关主要用于对比转发开销，不会影响 API 基础健康检查。

指标用于暴露现有审计链路问题，本轮未实现批量写入、审计队列重构、多实例配置同步。发射失败计数不包含所有可能的持久化失败；received 与 persisted 的差额也可能包含队列积压，应结合日志分析。
