# 阶段 B：系统配置

日期：2026-09-26  
状态：2026-09-26 已通过用户的设计与交互复核。后续加载与手机核对入口改进见 [阶段 C](stage-c-final.md)。

> 后续更新：运行配置已加入版本条件写入、存储确认与冲突核对。本文记录阶段 B 基线；当前协议见 [运行配置一致性](backend-config-consistency.md)。

## 查看页面

- [系统配置预览](http://127.0.0.1:15174/settings/preview)：明确标注演示数据，所有修改仅在本页内存中有效，不调用真实管理接口。
- 正式入口仍为 `/settings`，沿用管理认证与 GET /settings/runtime、PUT /settings/runtime。
- 常规开发环境通过根目录 [dev.ps1](D:/Java/ZenithGateway/dev.ps1) 启动；也可在其前端端口打开 `/settings/preview`。
- 三页预览之间通过公共导航跳转；只有明确注册的三个 preview 路由免认证，近似地址不属于预览。

预览场景包括正常、首次读取失败、保存被拒绝、保存响应中断、保存后读取失败、限流关闭、首次读取中。正常场景可自行修改参数、查看差异并保存。

## 构图与交互

**浅色区负责编辑，深色区负责核对。** 左侧将六个参数分成“流量控制 / 监控采样”，全局限流开关并入分组标题。桌面 1440×900 可直接看到全部六个控件及右侧摘要；中文说明维持 14–16px，不以缩小文字换空间。

**每个输入保留当前基准，摘要只列差异。** 修改后的输入采用浅黄绿色底色，旁边仍能读到当前已确认值；右侧逐项显示“当前 → 待保存”。错误用深红色文字与具体说明，摘要也标出待修正字段。普通字段保持安静，不使用持续动效。

**将服务端确认作为独立信息。** 保存返回值成为新基准，成功反馈保留在摘要下方；之后重新读取失败，不会把已确认的保存改成失败。手机将摘要放在参数之后，自然纵向阅读，三个公共导航入口均可到达。

## 六个字段与边界

| 字段 | 标签与单位 | 允许输入 |
| --- | --- | --- |
| rateLimitEnabled | 全局限流 | 开 / 关 |
| replenishRate | 令牌补充速率，令牌/秒 | 整数 1–10,000 |
| burstCapacity | 令牌桶容量，令牌 | 整数 1–10,000 |
| requestedTokens | 单次请求消耗，令牌/请求 | 整数 1–100 |
| monitorWindowSeconds | 指标统计窗口，秒 | 整数 1–120 |
| emitIntervalSeconds | 快照推送间隔，秒 | 整数 1–5 |

全局限流是统一开关，桶按 IP 独立生效。补充速率不是直接的 QPS；关闭限流仍保留参数，重新开启时使用。单次消耗超过容量会解释“令牌桶正常执行时无法放行”，不擅自增加后端未规定的组合校验。

输入使用原始字符串草稿，空值、小数、非数字与越界都明确指出，不静默截断或改写。有效值与服务端配置分开保存。

## 保存、读取与草稿状态

| 状态 | 页面行为 |
| --- | --- |
| 首次读取 / 失败 | 字段为空并显示“—”，禁止编辑和提交；失败给出重试，不拿默认值充当已生效配置 |
| 已读取、无差异 | 建立六字段基准，保存按钮不可重复提交 |
| 有草稿 | 保留原始输入；只比较有变化的字段；可恢复当前已确认值 |
| 重新读取 | 暂停编辑；成功后仅保留已修改字段，未修改字段采用服务端新值，避免覆盖新读取到的值 |
| 保存中 | 同步锁定保存、输入、重读与恢复操作，重复 submit 不会追加 PUT |
| 保存已确认 | 采用 PUT 返回的有效六字段；不自动追加 GET，也不把草稿直接当作成功结果 |
| 明确拒绝 | 对明确的 4xx 拒绝保留基准、草稿及服务端字段错误；修正后可重新提交 |
| 写入结果不确定 | 网络中断、超时、5xx 或无效成功响应不能证明未写入；保留草稿，暂停再次保存，先读取服务端当前值 |
| 读取确认后 | 如果当前值与草稿一致，说明已读取确认；若仍有差异则保留差异，等待用户明确保存，不自动重发 PUT |
| 保存成功、后续读取失败 | 保留 PUT 返回值与保存时间，显示“保存已确认，重新读取失败”，单独重试读取 |
| 认证失效 | 回到现有认证入口；草稿与待确认结果仅保留在当前页面内存中，重新连接后先读取核对 |
| 有草稿离开 / 断开 | 仅在有未保存或待确认内容时使用浏览器确认；取消后原样保留，确认后清理草稿；含 /settings/ 尾斜线地址 |
| 刷新或关闭 | 有草稿时触发 beforeunload 提醒；刷新后不持久化草稿，也不把管理凭据写入浏览器存储 |

“当前”指最近一次成功读取或保存响应，不承诺多人同时编辑时的实时状态。没有新增配置版本、历史、回滚协议、监控开关或审计开关。

## 实际截图与录屏

预览截图中的值来自明确标注的本地演示场景，均为实际 Edge 渲染。认证恢复图使用隔离的模拟管理接口；真实后端图使用独立测试实例。

| 场景 | 文件 |
| --- | --- |
| 正常，1440×900 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-normal-1440.png) |
| 未保存差异，1440×900 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-dirty-1440.png) |
| 手机首屏，390×844 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-first-screen-390.png) |
| 手机完整页面，390px | [正常长截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-normal-390.png) · [手机实际编辑并保存](D:/Java/ZenithGateway/docs/images/settings-stage-b-saved-390.png) |
| 首次读取中 / 失败 | [读取中](D:/Java/ZenithGateway/docs/images/settings-stage-b-loading-1440.png) · [失败](D:/Java/ZenithGateway/docs/images/settings-stage-b-read-failure-1440.png) · [手机失败](D:/Java/ZenithGateway/docs/images/settings-stage-b-read-failure-390.png) |
| 无效输入 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-invalid-1440.png) |
| 保存被拒绝，草稿保留 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-rejected-1440.png) |
| 写入结果不确定 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-uncertain-1440.png) |
| 保存成功 / 后续读取失败 | [已确认](D:/Java/ZenithGateway/docs/images/settings-stage-b-saved-1440.png) · [读取失败](D:/Java/ZenithGateway/docs/images/settings-stage-b-saved-read-failure-1440.png) |
| 注入认证失效后重新连接，保留差异 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-auth-restored-1440.png) |
| 独立真实后端保存已确认 | [截图](D:/Java/ZenithGateway/docs/images/settings-stage-b-live-saved-1440.png) |

[实际交互录屏，13.2 秒](D:/Java/ZenithGateway/docs/media/settings-stage-b-interaction.webm)：修改补充速率 → 修改统计窗口 → 核对两项差异 → 保存确认 → 重新读取。1440×900、25 fps、WebM；录屏使用明确标注的本地预览。抽取第 3、7、10 秒实际帧检查过内容。

## 本轮验证结果

完整记录见 [阶段 B 验收证据](D:/Java/ZenithGateway/docs/settings-stage-b-validation.json)。

| 检查 | 结果 |
| --- | --- |
| 前端测试 | 39 / 39 通过；保留原有 25 项，新增 14 项，覆盖全部字段边界、读取基准、重复提交、拒绝/未知/确认、草稿合并、认证与晚到响应 |
| 生产构建 | vue-tsc 与 Vite 通过，662 个模块；没有新增依赖 |
| 配置浏览器 | 16 组通过；预览交互与正式组件故障注入分别检查；页面脚本错误为 0，预览管理接口请求为 0 |
| 响应式与导航 | 1440 / 1100 / 960 / 700 / 390 / 320 px 无横向溢出；手机三个导航入口均可到达；390px 实际完成两项编辑、查看差异与保存 |
| 独立真实后端 | 6 组通过；随机端口网关、独立 Redis、单独的管理凭据与 Redis 键 |
| 概览回归 | 本轮重新执行 13 组检查通过，包含独立读取恢复、SSE 生命周期、认证和预览隔离 |
| 路由回归 | 本轮重新执行 10 组检查通过，包含 32 条目录、搜索选择、长短名称稳定、节点展开、完整字段复制、异常缓存和窄屏 |
| 真实导航联动 | 系统配置保存后到概览，读取到新的 17 秒窗口；再到路由和手机配置页，保持真实接口和认证 |

真实后端验证的三个关键证据：

1. 浏览器将六字段改为关闭限流、37 令牌/秒、容量 74、单次消耗 2、统计窗口 17 秒、推送间隔 2 秒。一个 PUT 后，页面基准、运行配置 GET 和 Redis 中持久化值一致。
2. 第二次将补充速率改为 41。测试先让真实后端完成写入，再丢弃成功响应；页面进入结果待确认状态。一次 GET 确认当前值后收敛差异，没有重复 PUT。
3. 最后通过页面恢复原始六字段，并同时核对运行配置与 Redis。测试后端退出码 0，独立 Redis 已移除。

确定拒绝、字段错误、认证中途失效、读失败和 500 等通过浏览器拦截注入。真实保存、Redis 持久化、已写入但丢响应、配置恢复在独立真实环境执行；未在用户原有网关上修改参数。

构建仍提示主 JS 大于 500 kB：本轮约 719.54 kB，gzip 250.56 kB。后端代码和依赖未变动；使用项目已有构建包进行真实集成，未重复运行后端全量测试。

## 改动范围与剩余取舍

- 新增 settings/model、editor、preview、leave，集中处理六字段与本页草稿；原有 traffic store 和 API 认证传输逻辑保持。
- Settings.vue 与独立 settings.css 承担页面；公共外壳只增加明确预览入口、可选断开保护和认证草稿提示。
- 已验收概览与路由主体源码未改动。
- 手机摘要位于参数之后，需要滚动；保持自然阅读与足够点击面积。
- 离开确认采用原生浏览器对话框，避免再引入一套模态基础设施；浏览器关闭提示的文案由浏览器控制。
- 草稿只保留在本页面内存中。没有配置版本接口，因此读取确认只能说明读取时的当前值，不提供多人编辑冲突检测或事务历史。

## 复现

```powershell
. ./.dev/upgrade-tools/env.ps1
npm --prefix frontend test
npm --prefix frontend run build

# 前端已启动；按实际端口调整。
$env:ROUTE_CONSOLE_URL = 'http://127.0.0.1:15174'
node verification/settings-stage-b.mjs

# 需要 Docker、已有 redis:7.4-alpine 镜像及 backend/target/zg-1.0.0.jar。
# 创建独立环境，验证后恢复配置并清理。
node verification/settings-stage-b-live.mjs
```

浏览器使用项目已有的 .dev/browser Playwright 与 Edge。设置 SETTINGS_RECORD=0 可跳过重新录屏。
