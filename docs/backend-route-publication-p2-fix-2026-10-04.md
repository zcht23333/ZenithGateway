# 路由保存期间草稿保护 P2 修复与补验 — 2026-10-04

本轮修复“保存中仍可编辑，成功响应关闭窗口并丢失后续输入”。专项补验和相关回归通过，**待独立重新验收**。保留[原验收报告](./backend-route-publication-acceptance-2026-10-04.md)及其复现脚本和证据，不覆盖上一轮结论。

## 行为与取舍

采用验收建议中的“保存期间冻结编辑”方案。在 RouteEditor 的路由参数外层使用原生 disabled fieldset，覆盖新建时的 ID、Path、URI、重写开关及参数、熔断开关及参数（共 9 个现有输入控件）。显示“正在保存本次路由，字段暂时锁定”。表单提交函数也检查 saving / canSubmit，阻止重复提交事件。

锁定只持续到本次请求结束。成功后沿用关闭窗口的行为；再次打开可以正常编辑。校验失败、冲突及结果未知时，保留草稿并解除输入锁；是否允许再次发布，继续由既有版本核对状态决定。认证恢复仍保留草稿、原核对基准并要求重新读取和明确核对。关闭与 Escape 保持原有保存保护。

未改动路由版本协议和后端代码，也未修改 editor.ts 的生命周期隔离或 RouteDispatch.vue 的编辑会话保护。旧请求在明确丢弃后不得恢复草稿，成功后的迟到刷新不得关闭新窗口，这些已有行为重新经过浏览器检查。

取舍是等待保存响应时不能连续修改表单，需要本次保存结束后继续编辑；不引入“已提交草稿”和“继续编辑草稿”两套并行状态。

## 本轮实际执行结果

| 检查 | 结果与证据 |
| --- | --- |
| 前端全量测试 | **106 项通过**，新增 4 项延迟失败状态检查（校验拒绝、冲突、未知、认证失效）。[日志](../.dev/route-publication-save-lock-0350cb674142/frontend-test.log) |
| 类型检查和生产构建 | 通过。既有 ECharts 约 503 kB 分包提示仍在，本轮不调整图表加载。[日志](../.dev/route-publication-save-lock-0350cb674142/frontend-build.log) |
| 新增真实浏览器专项 | **3 组通过**：编辑延迟成功、新建延迟成功、真实校验拒绝后的恢复。[报告](../.dev/route-publication-save-lock-0350cb674142/save-lock-browser-v2/report.json) |
| 既有路由浏览器回归 | **10 组通过**，额外断言冲突、认证恢复和未知结果后 Path、URI 和两类开关可编辑。[报告](../.dev/route-publication-save-lock-0350cb674142/routes-browser/report.json) |
| 验收方原始 P2 复现 | 未修改原脚本直接执行，退出码 0，editingFrozen=true，仅一次页面保存 POST。[报告](../.dev/route-publication-save-lock-0350cb674142/original-repro/report.json) |

新增入口为 [verification/route-publication-save-lock-browser.mjs](../verification/route-publication-save-lock-browser.mjs)。它使用生产构建页面、真实网关和专属 Redis，在后端已经返回实际 201 / committed 后，仅暂扣给浏览器的响应。检查全部 9 个控件已禁用、Path 的普通输入无法执行、真实鼠标点击不改变两类开关、Enter 和重复 submit 不会再次写入，然后显式放行响应。未伪造成功回执，也未用固定睡眠碰撞保存窗口。输入被禁用的负向断言最多等待 350 ms；HTTP 响应释放由显式门控控制。

编辑成功的真实代理结果为 V2:/proof，新建成功的结果为 V1:/proof，转发返回的路由版本与提交版本一致。真实 400 拒绝使用非法 Java 正则“[”；响应解除后该草稿仍可见、全部原本可编辑的控件恢复，Redis 版本不变且没有自动重发。

已有 10 组浏览器回归仍使用两个共享专属 Redis 的真实实例，覆盖版本冲突、取消离开、确认丢弃、新旧读取交错、认证恢复、Redis 确认丢失、待生效及恢复、概念预览隔离。

## 实际截图

- [编辑保存中，1440×900](../.dev/route-publication-save-lock-0350cb674142/save-lock-browser-v2/edit-saving-locked-1440.png)
- [保存成功后重新打开，可编辑](../.dev/route-publication-save-lock-0350cb674142/save-lock-browser-v2/edit-saved-unlocked-1440.png)
- [新建保存中，390×844](../.dev/route-publication-save-lock-0350cb674142/save-lock-browser-v2/create-saving-locked-390.png)
- [真实校验失败，草稿保留并解除锁定](../.dev/route-publication-save-lock-0350cb674142/save-lock-browser-v2/rejected-draft-unlocked-1440.png)

已实际查看桌面、手机及拒绝状态截图；手机未出现水平溢出。

## 复跑

需 Docker 可用、已有项目 Node 24 / JDK 21 工具链、Playwright 与浏览器依赖。后端沿用本轮未修改的已验收产物；如果后端源码另有改动，先按项目流程重新构建，不应混用未知产物。

~~~powershell
Set-Location 'D:/Java/ZenithGateway'
$env:PATH = 'D:/Java/ZenithGateway/.dev/toolchains/node-v24.21.0-win-x64;' + $env:PATH
$env:JAVA_HOME = 'D:/Java/ZenithGateway/.dev/toolchains/jdk-21.0.12.1+1'
Push-Location frontend
npm test
if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
Pop-Location

$env:ROUTE_PUBLICATION_OUTPUT = Join-Path '.dev' ('route-save-lock-' + [guid]::NewGuid().ToString('N'))
node verification/route-publication-save-lock-browser.mjs
if ($LASTEXITCODE -ne 0) { throw 'Save lock verification failed' }

$env:ROUTE_PUBLICATION_OUTPUT = Join-Path '.dev' ('route-browser-recheck-' + [guid]::NewGuid().ToString('N'))
node verification/route-publication-browser.mjs
if ($LASTEXITCODE -ne 0) { throw 'Route browser regression failed' }
~~~

原验收脚本也可按原报告中的命令运行，为输出目录指定新名称即可。

## 产物、清理与未执行范围

完整清单见 [P2 验证索引](./backend-route-publication-p2-validation-2026-10-04.json)。后端 JAR SHA-256 仍为 6580adaa99dc42be8f4c99c442c9d56fa7302016389d0ece0c9dc87a9318e670，与上一轮验收一致。修复前记录的 153 份既有 docs 文件哈希全部保持不变。

四次隔离浏览器运行（含一次脚本调试）均清理了自建 Redis、代理、受控上游、网关、页面服务和浏览器。独立核对所有本轮容器已不存在、26 个记录端口均无监听、无本轮命名空间的残留 Java 进程。[清理结果](../.dev/route-publication-save-lock-0350cb674142/cleanup-check.json)。现有开发实例未升级。

第一次专项脚本把“必须等待目标可点击”的 Playwright click 用在已禁用标签上而超时，属于测试驱动方式问题。修正为真实鼠标点击后通过；该失败报告及清理记录保留在 [首次运行](../.dev/route-publication-save-lock-0350cb674142/save-lock-browser/report.json)，未计入通过组数。

本轮未重跑后端 216 项、路由独立实验 19 组、代理 24 组 / 102 请求、限流 22 组及旧验收 124 项；这些属于原独立验收已通过的记录，不能算成本轮执行结果。此次产品改动限定前端表单保护，验证使用未变的后端产物。未部署、迁移数据或扩展下一阶段工程主题。
