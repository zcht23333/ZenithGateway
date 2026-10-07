# 路由调度方向实验 02：请求路径与底部目录

2026-09-25。本轮在现有 /routes/preview 入口实现新的构图与交互，使用现有 Vue 组件、路由字段和演示数据。随后已将同版界面接入真实管理页 /routes，见[正式接入记录](route-dispatch-live.md)。没有新增产品依赖。

## 查看

预览服务地址为 http://127.0.0.1:15174。以下截图均来自实际 Edge 浏览器，主场景为 **1440×900 的首屏截图**，没有使用整页长图冒充首屏。

| 场景 | 预览 | 截图 |
| --- | --- | --- |
| 正常：order-service | [打开正常场景](http://127.0.0.1:15174/routes/preview?scenario=normal) | [1440×900 首屏](images/routes-dispatch-normal-1440.png) |
| 异常：配置读取失败，保留缓存 | [打开异常场景](http://127.0.0.1:15174/routes/preview?scenario=exception) | [1440×900 首屏](images/routes-dispatch-exception-1440.png) |
| 32 条：长 ID、Path、URI | [打开 32 条场景](http://127.0.0.1:15174/routes/preview?scenario=dense) | [1440×900 首屏](images/routes-dispatch-dense-1440.png) |

交互截图：[重写节点展开](images/routes-dispatch-rewrite-1440.png)、[读取异常详情](images/routes-dispatch-exception-detail-1440.png)、[960px 目录](images/routes-dispatch-960.png)、[390px 首屏](images/routes-dispatch-390.png)、[390px 节点展开](images/routes-dispatch-mobile-node-390.png)。

页面持续标注“演示数据 · 不连接真实网关”。新建、编辑、删除、读取恢复均发生在浏览器内存，重新加载或切换场景恢复示例。表单沿用现有字段与基础校验；完整 Java 正则和 Spring PathPattern 校验仍属于真实后端。

预览关闭后，在项目根目录启动（Node 24，前端依赖已安装）：

~~~powershell
npm --prefix frontend run dev -- --host 127.0.0.1 --port 15174 --strictPort
~~~

## 三个关键设计决定

1. **当前路由与请求路径占据主画布。** 顶部收为导航、辅助指标和单一配置状态。醒目的目录序号、完整 ID 与 Path 先回答“正在查看哪条路由”，横贯画面的处理路径回答“请求将去哪里、在哪里可能返回”。目录序号保持原始列表位置，搜索和翻页不会重新编号。
2. **浅色底部目录负责选择，深色画布负责解释。** 石墨底色、象牙白目录、黄绿色选择信号形成鲜明尺度与明暗差异；品牌保留少量青色。黄绿色只指示所选路径和操作焦点，配置读取成功用绿色、条件分支及审计待写入用琥珀色、读取失败用红色，并配合文字或图标。参考图中的口号、等高线和装饰文字没有加入页面。
3. **把反馈放在切换与就地展开。** 点击路由更新名称、入口、阶段和目标；点击节点在节点旁展开规则、示例和复制入口，关闭或按 Escape 恢复整体路径并返回节点焦点。切换路由会关闭上一条路由的节点面板；编辑移除某个处理阶段也会关闭失效面板。动效为一次性选择与展开，尊重“减少动态效果”设置。

## 目录与完整信息

- 宽度 ≥1360px 时每页 6 条；760–1359px 每页 4 条；更窄时每页 2 条。32 条路由分别为 6、8、16 页，页码可直接跳转。
- 搜索完整 ID、Path 或 URI，忽略大小写；搜索、规则筛选和翻页只改变目录，保留画布中的当前路由。选择卡片或在搜索框按 Enter 后才切换；“定位当前路由”清除筛选并回到对应页。
- 目录卡片同时显示稳定序号、ID 的首尾、Path 的首尾及目标主机。缩略 ID 若在整个目录中出现碰撞，回退为完整 ID；hover 标题与无障碍名称包含完整 ID、Path、URI。
- 当前路由的标题与主 Path 完整换行。节点展示完整相关字段，可选择文本或一键复制；“查看与复制完整字段”集中提供全部 9 个字段及完整 JSON，长字段允许换行和滚动。
- 卡片支持左右方向键跨页切换、Home/End 到首尾；普通鼠标翻页不改变选择。
- ≤700px 时请求路径改为纵向，底部目录固定并可收起。选择路由后收起目录并定位到路由标题；选择节点后收起目录并定位到展开处；关闭节点恢复整条纵向路径。搜索与分页始终位于目录中。
- 1440、1280、1100、960、850px 的 32 条路由首屏可完整容纳路径和目录。768px 时有少量纵向滚动；手机端为纵向浏览。320–1440px 的 10 个检查宽度均无页面横向溢出，完整标题没有被裁剪。

## 图与真实能力的对应关系

| 图中内容 | 实现依据与表达边界 |
| --- | --- |
| 匹配入口 | DynamicRouteService 声明 Path 条件。显示匹配模式，不代表已经捕获请求。 |
| 全局限流 | RateLimitFilter 顺序为 -200，按 IP 使用 Redis 令牌桶。节点显示令牌补充速率、容量和每次消耗；令牌不足返回 429。Redis 超时或故障时当前实现降级放行。 |
| 路径重写 → 熔断保护 | DynamicRouteService 依次声明 RewritePath 和 CircuitBreaker，按路由配置显示或省略。前端不增加未配置的处理阶段。 |
| 异常降级分支 | 调用异常、超时或熔断拒绝进入 /fallback/default，返回 503。没有配置 statusCodes 触发条件，上游普通 HTTP 500 按原响应传递。 |
| 目标服务 | 完整 HTTP(S) URI 可在节点或完整字段中查看与复制。 |
| 响应完成后 | RequestCompletionRecorder 记录统计并在启用时提交异步审计，与请求处理线分开呈现。 |
| 配置读取状态 | 集中表示配置请求结果。异常场景模拟 HTTP 503，保留缓存配置并暂停修改；展开说明与重试入口位于同一处。不表示上游离线或当前熔断状态。 |
| 全局指标 | 沿用现有全局 QPS、P95 与审计待写入语义。选择路由不会改变统计范围。异常演示 pending=128，其中 queueDepth=112、inFlight=16。 |

相关后端：[动态路由](../backend/src/main/java/com/zch/route/DynamicRouteService.java)、[全局限流](../backend/src/main/java/com/zch/filter/RateLimitFilter.java)、[默认降级](../backend/src/main/java/com/zch/route/GatewayFallbackController.java)、[完成后记录](../backend/src/main/java/com/zch/monitor/RequestCompletionRecorder.java)。

节点中的请求路径标注为“示例 / 按规则推导”。目前只为可准确推导的字面量 Path 前缀、现有 segment 命名组规则及后端生成的 Java 引用前缀生成示例；未识别的 Java 正则或其他 Spring 模式显示“需在真实网关验证”。不在浏览器中模拟任意 Java 正则，不绘制移动请求点，也不提供未接入的实时请求追踪。

## 验证与复现

结果见 [本轮验证记录](route-dispatch-validation.json)。

- 15 项前端测试通过，其中 5 项覆盖规则示例、关闭重写时的空字段、Java 引用前缀、不支持规则不生成示例、缩略 ID 碰撞。
- 14 组实际浏览器检查通过：实际阶段顺序、节点展开与 Escape 焦点、路由切换、稳定搜索与筛选、32 条分页及键盘操作、完整字段与剪贴板、异常恢复、演示增删改、10 个响应式宽度、移动端操作、场景切换、减少动态效果、截图尺寸、零脚本错误与零 API 请求。
- 32 条示例路由与额外 2 条规则示例，共 34 个结果，经项目构建产物中的 Spring PathPatternParser 与 Java Matcher 实际执行核对一致。
- vue-tsc 类型检查和 Vite 生产构建通过。主 JS 块超过 500 kB 的既有提醒仍存在，整站拆包未纳入本轮页面构图实验。
- 本轮没有运行完整后端联调；真实管理页、认证与后端配置逻辑没有改动。上一轮验证保存在 [首轮记录](route-console-validation.json)。

浏览器复现脚本为 [verification/route-dispatch.mjs](../verification/route-dispatch.mjs)，会重新生成本轮截图。旧入口 route-console.mjs 转发到该脚本。使用本地工具目录中的 Playwright，不增加产品依赖：

~~~powershell
npm install --prefix .dev/browser --no-save --no-package-lock playwright@1.63.0
node verification/route-dispatch.mjs
npm --prefix frontend test
npm --prefix frontend run build
~~~

Windows 默认使用本机 Edge；其他环境使用已安装的 Playwright Chromium。可用 ROUTE_CONSOLE_URL 和 BROWSER_CHANNEL 更改地址与浏览器通道。

本次评审建议先完成三步：进入正常场景，辨认当前路由和目标；在 32 条场景搜索目标 URI、翻页再定位原路由；打开重写节点后关闭，判断是否仍能理解整体处理关系。第一眼识别度、切换感和风格辨识度仍以实际体验反馈为准。
