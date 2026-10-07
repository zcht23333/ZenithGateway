# 阶段 A：公共基础与运行概览

日期：2026-09-25  
状态：2026-09-26 已通过用户的设计与预览交互复核。后续系统配置成果见 [阶段 B](settings-stage-b.md)，P95 与加载收尾见 [阶段 C](stage-c-final.md)。本文保留阶段 A 的历史实现与证据。

## 查看页面

- 本次独立前端预览：[运行概览](http://127.0.0.1:15174/overview/preview)。
- 正式运行概览仍为 `/`，通过现有管理认证连接真实后端。
- [根目录启动脚本](D:/Java/ZenithGateway/dev.ps1) 启动常规开发环境；预览入口也可在该环境访问 `/overview/preview`。
- 概览与路由的预览分别明确配置为 `/overview/preview`、`/routes/preview`。它们使用本地场景数据，不读取或修改真实网关。其他地址仍受认证约束。

概览预览提供正常、零流量、无历史、首次加载、局部失败与旧数据、监控关闭、审计停止接收、P95 超范围和采样缺口九个场景。

## 三个设计决定

1. **把时间展开为主画面。** QPS 与 P95 使用上下对齐的两条趋势带，分别标明 req/s、ms，共用实际时间范围。左侧当前窗口大数字保持稳定，悬停或键盘滑块查看的是独立的采样读数。1440×900 首屏同时容纳主要趋势与审计摘要。小于 1 req/s 的刻度保留精度。
2. **用明暗组织任务。** 延续路由页的深石墨、黄绿色焦点与中文字体，明亮数字和宽幅趋势先吸引注意。审计摘要收在趋势下方；展开后才显示容量、内存和进程累计。下方浅色工作区用于逐条阅读、完整路径及 JSON 复制。
3. **让状态跟随各自的数据源。** 快照、历史采样、SSE、审计状态和最近记录各有读取与恢复状态。局部失败保留带时间的旧数据，并提供对应重试入口；一处失败不会把其他数据改成零或抹掉。

三页共用 ZenithHeader、基础色值、焦点和认证外观。手机通过“导航”菜单到达三个页面，Escape 关闭并返回按钮。路由页原有画布、底部目录、全部路由、长名称和节点展开保持原有布局。

## 真实语义与更新行为

| 内容 | 当前实现 |
| --- | --- |
| 当前窗口 | GET /dashboard/snapshot，随后接收 SSE traffic；QPS = 已结束代理请求数 / windowSeconds |
| 趋势 | GET /dashboard/series?size=120，与 SSE 按 timestamp 合并、去重，最多 120 点；展示实际起止日期与时间 |
| 采样间断 | 时间轴按真实间距定位；关闭监控、已知订阅中断及超过 6 秒的间隔留空。6 秒阈值依据当前后端支持 1–5 秒推送间隔 |
| P95 超范围 | -1 显示为 > 60,000 ms；趋势在上界用三角标记，不能解释为 0 或 -1 ms |
| 审计摘要 | pending、oldestAgeMs、enabled、accepting 与最近读取时间；pending 非零不直接等同故障 |
| 审计详情 | 容量、队列、写入中、预留内存、最近批次，以及本次进程累计；uncertain 明确可能已经写入 Redis |
| 最近审计记录 | GET /monitor/audit/recent?size=40，约每 5 秒独立读取；事件时间和读取时间分开，可包含跨日和进程启动前记录 |
| 特殊结果 | statusCode = 0 显示未形成 HTTP 状态；cancelled 明确显示已取消 |
| 数据新鲜度 | 当前快照或最近成功接收时间超过 15 秒，或更新出错时标注旧数据；审计与记录分别显示读取错误和最后成功时间 |
| 生命周期 | 退出页面关闭 SSE、取消请求与轮询、销毁图表；晚到响应不会覆盖其他页面；重新进入重新建立一次订阅 |

首次尚未取得数据显示“—”；真实 0 正常显示；监控关闭单独说明。取消、请求异常、未知状态不与状态码分组相加。历史记录不会被描述为实时请求，订阅连通不代表上游健康。没有新增健康评分、逐路由指标或 1h / 24h 历史筛选。

## 实际浏览器截图与录屏

以下场景由 Edge 实际渲染，预览图明确显示“演示数据 · 不连接真实网关”。

| 场景 | 文件 |
| --- | --- |
| 正常首屏，1440×900 | [截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-normal-1440.png) |
| 手机首屏，390×844 | [截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-first-screen-390.png) |
| 手机完整页面，390px 宽 | [长截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-normal-390.png) |
| 真实零窗口、无历史、无记录 | [空数据截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-empty-1440.png) |
| 流量旧数据、历史及记录读取失败、审计仍可读 | [局部失败截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-partial-1440.png) |
| 审计停止接收、待写入积压 | [审计异常截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-audit-1440.png) |
| P95 超过 60,000 ms | [超范围截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-overflow-1440.png) |
| 不等间隔与缺失段 | [缺口截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-gaps-1440.png) |
| 隔离真实后端，3 次真实代理请求 | [真实数据截图](D:/Java/ZenithGateway/docs/images/overview-stage-a-live-1440.png) |

[实际交互录屏，14.8 秒](D:/Java/ZenithGateway/docs/media/overview-stage-a-interaction.webm)：查看趋势 → 展开审计详情 → 收起 → 查看完整长路径记录 → 复制 → 关闭。1440×900、25 fps、WebM，使用明确标注的正常预览场景；没有伪造实时请求动画。

## 本轮验证

本轮重新执行，详细结果保存在 [验收记录](D:/Java/ZenithGateway/docs/overview-stage-a-validation.json)。

| 检查 | 结果与范围 |
| --- | --- |
| 前端测试 | 25 / 25 通过：原有 15 项，加本轮 10 项状态、时间和生命周期测试；含低 QPS 轴刻度精度 |
| 生产构建 | vue-tsc 与 Vite 构建通过；没有新增依赖 |
| 概览浏览器 | 13 组通过：真实首屏、趋势与键盘滑块、审计详情、完整记录与复制、多场景、独立恢复、导航、认证及资源释放 |
| 概览尺寸 | 1440 / 960 / 700 / 390 / 320 px 无横向溢出；窄屏三个导航入口可达，长记录详情可读 |
| 路由打磨回归 | 10 组通过：32 条、长短名称稳定、共享搜索筛选选择、全部目录、节点状态、分支、复制、窄屏 |
| 路由行为回归 | 14 组通过：分页、选择、节点、配置读取失败与恢复、预览增删改校验、减少动效及隔离 |
| 路由真实后端回归 | 12 组通过：管理认证、真实增删改与转发、重写、熔断、配置更新、独立读取失败与恢复、断开清理 |
| 概览真实后端 | 独立 Redis + 本项目后端 + 测试上游；2 次 HTTP 200、1 次 HTTP 500；浏览器确认 3 条审计、10 秒窗口 3 请求、QPS 0.30 和持续到达的新 SSE |
| 隔离与清理 | 预览管理 API 请求为 0；浏览器脚本错误为 0；真实概览检查只读，测试数据仅写入独立后端；测试后端和 Redis 已清理 |

概览故障浏览器检查通过拦截各自接口及控制测试 SSE 注入；正常真实接口另用隔离后端验证。两者分别记录，不将演示或模拟恢复当作真实后端恢复证据。现有路由真实后端回归另外覆盖读取失败恢复及管理操作。

构建保留 Vite 的大包提示：主 JS 约 704.27 kB（gzip 245.42 kB），包含现有 ECharts；本轮没有做路由拆包。项目后端未改动，不重复运行后端全量测试；使用既有构建包完成真实接口集成检查。

## 剩余取舍

- 两条趋势分别采用适合各自单位的纵轴，不应直接按线高比较 QPS 与延迟。出现超范围 P95 时保持线性上界标记，会压缩常规毫秒级细节。
- 为保留清楚的字号，最近记录位于首屏下方；展开审计详情会继续向下推移。手机采用纵向阅读，完整状态与记录需要滚动。
- 首屏专注窗口与趋势；完整数据来源、平均延迟分类、审计计数按需展开。最多 120 点仍是短期采样，没有任意历史范围。
- 系统配置仅接入公共外壳，Settings.vue 主体及保存行为未改动。阶段 A 验收后再进入阶段 B。

## 复现

在项目根目录导入已有开发工具链后运行：

```powershell
. ./.dev/upgrade-tools/env.ps1
npm --prefix frontend test
npm --prefix frontend run build

# 先启动前端；若端口不同，调整环境变量。
$env:ROUTE_CONSOLE_URL = 'http://127.0.0.1:15174'
node verification/overview-stage-a.mjs

# 需要本地 Docker、已有 Redis 7.4 镜像和 backend/target/zg-1.0.0.jar。
# 自动创建并清理独立 Redis、网关、测试上游。
node verification/overview-live-isolated.mjs
```

浏览器脚本使用项目已有的 .dev/browser Playwright 工具及 Edge。概览录屏可用 OVERVIEW_RECORD=0 跳过；路由回归脚本保持原有用法。
