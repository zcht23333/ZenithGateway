# 路由管理概念验证：轨道调度台

> 首轮设计归档：当前 `/routes/preview` 已切换到[第二版方向实验](route-dispatch-design.md)。下文截图与验证结果记录首轮实现；真实管理页 `/routes` 也已[采用第二版](route-dispatch-live.md)，旧预览验证脚本入口现在运行第二版检查。

2026-09-24。改造现有 Vue 路由管理页，保留原有接口与管理凭据机制；新增独立演示入口，供视觉和交互评审。

## 查看与截图

本次本地预览运行在 `http://127.0.0.1:15174`。页面顶部可切换三个场景。

| 场景 | 地址 | 截图 |
| --- | --- | --- |
| 正常 | [/routes/preview?scenario=normal](http://127.0.0.1:15174/routes/preview?scenario=normal) | [正常状态](images/routes-orbit-normal.png) |
| 异常 | [/routes/preview?scenario=exception](http://127.0.0.1:15174/routes/preview?scenario=exception) | [读取失败与缓存配置](images/routes-orbit-exception.png) |
| 多条目 / 长名称 | [/routes/preview?scenario=dense](http://127.0.0.1:15174/routes/preview?scenario=dense) | [32 条路由与完整长名称](images/routes-orbit-dense.png) |

另附 [编辑抽屉](images/routes-orbit-editor.png) 与 [390px 窄屏](images/routes-orbit-mobile.png)。

预览持续标注“演示数据 · 不连接真实网关”。新建、编辑和删除仅作用于当前页面内存，刷新或切换场景恢复示例。预览无需后端与管理凭据，也不会更改真实页面的认证状态。演示表单用于交互评审；完整的 Java 正则、PathPattern 与替换分组校验仍由真实后端负责。

预览进程关闭后，在项目根目录运行（Node 24，前端依赖已安装）：

```powershell
npm --prefix frontend run dev -- --host 127.0.0.1 --port 15174 --strictPort
```

真实管理页仍为 `/routes`。通过根目录 `dev.ps1` 启动完整项目后，默认地址为 `http://127.0.0.1:5173/routes`；使用原有管理凭据登录。独立预览进程的 API 代理已恢复指向默认后端端口 8080。

## 三个关键设计决定

1. **把目录当作调度表。** 路由 ID、Path 入口条件、目标 URI、配置状态保持固定列序。搜索与规则筛选紧邻目录，8 条一页；长 ID、路径和主机名完整换行。新建与编辑放入抽屉，使日常浏览优先于表单操作。顶部只保留路由数量与已有全局指标。
2. **让选中状态解释请求去向。** 电青色同时连接选中行、入口与目标；右侧按实际顺序展开全局限流、可选路径重写、可选熔断保护和上游转发。实线表示请求处理顺序，虚线表示条件分支。未启用的路由过滤器省略并文字说明，响应完成后的统计和审计独立展示。窄屏选择路由后定位到详情，并提供返回目录操作。
3. **用明暗与语义色建立可读层级。** 深石墨背景区分底层、目录与当前详情，基础正文 16px，主要路由名称和路径 15px；辅助标注适当缩小。电青色只用于选择与操作焦点；绿、琥珀、红分别配合成功、待确认、失败文字。异常时保留缓存目录和读取时间，暂停修改并给出重试入口。动效限于选择与展开，支持减少动态效果设置。

## 数据与处理关系的依据

| 界面内容 | 真实来源与边界 |
| --- | --- |
| ID、Path、URI、重写与熔断配置 | `GET /settings/routes`。保留字段含义；编辑使用原有按 ID 覆盖保存能力，删除保留二次确认。 |
| 配置“已读取 / 待确认” | 前端请求结果与保留的上次读取结果。它们不表示上游健康、路由启停或当前熔断状态。 |
| QPS、P95、窗口请求数 | `GET /dashboard/snapshot`，均为网关全局统计；P95 的 `-1` 显示为 `> 60,000 ms`。 |
| 审计待写入 | `GET /monitor/audit/status` 的 `pending`，全局队列数据。 |
| 全局限流 | `GET /settings/runtime`。按 IP 的令牌桶；显示补充的令牌/秒、容量和每次消耗，避免把令牌速率误写成请求速率。超额返回 HTTP 429。 |
| 过滤器顺序 | `RateLimitFilter` 的顺序为 -200；`DynamicRouteService` 依次声明 RewritePath、CircuitBreaker，Gateway 将它们包装为声明次序 1、2；随后转发。 |
| 异常降级 | 现有 `/fallback/default` 返回 HTTP 503。连接异常、超时或熔断拒绝可触发；上游普通 HTTP 500 不会因这张图而被宣称必定触发降级。 |
| 完成后记录 | `RequestCompletionRecorder` 在响应完成后记录统计，并在启用时提交异步审计。 |

全局指标与限流配置每 5 秒读取一次。读取失败时清除相应指标的展示值并说明不可用；卸载或切换模式会取消请求及定时器。配置刷新失败保留旧目录，成功保存但后续刷新失败会分别提示两种结果。

异常演示模拟配置读取 HTTP 503 与审计待写入 128 条。目录显示的是缓存配置；这不是虚构的“上游服务离线”状态。示例路由仅使用系统现有的 Path、HTTP(S) URI、重写、熔断和默认降级能力。

## 验证

结果见 [验证记录](route-console-validation.json)。

- TypeScript 检查与生产构建通过；现有前端 10 项测试通过。测试用 Vite 服务关闭不需要的浏览器依赖扫描，避免测试结束时的异步扫描噪声。
- 7 组预览浏览器检查：选择与键盘导航、规则筛选、空结果、异常恢复、分页、表单增删改、焦点与 Escape；预览请求真实 API 的次数为 0。
- 390、768、1024、1280、1440、1600、1920px 下检查长内容，没有页面横向溢出或路径截断。
- 10 组真实后端联调检查：认证、Java 正则校验、Redis 保存、实际重写转发、HTTP 500 与 503 降级区别、全局配置刷新、读取失败恢复、保存后的刷新失败、导航与删除、空重写字段启用、凭据失效，以及测试后端退出等合并场景。
- 测试使用隔离的 Redis 键、后端端口与本地上游；结束后已清理测试键并停止测试后端与本轮启动的测试 Redis。
- 构建仍提示主 JS 块超过 500 kB。现有运行概览、图表与路由页共用入口，整站拆包不在这次单页概念验证范围内。

预览检查脚本保存在 [verification/route-console.mjs](../verification/route-console.mjs)。在预览服务运行时，可于项目根目录复现；它会重新生成截图。Windows 默认使用本机 Edge，Playwright 仅安装在忽略提交的本地工具目录，不增加产品依赖：

```powershell
npm install --prefix .dev/browser --no-save --no-package-lock playwright@1.63.0
node verification/route-console.mjs
```

可通过 `ROUTE_CONSOLE_URL` 更改预览地址，通过 `BROWSER_CHANNEL` 更改浏览器通道。真实联调的本地复现脚本位于 `.dev/browser/route-console-live-test.mjs`，汇总结果已保存在上述验证记录中。
