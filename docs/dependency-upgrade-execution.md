# 依赖升级实施与验收

日期：2026-09-23。依赖迁移与 Windows 本地验收已完成。采用新平台作为开发基线；性能结果尚不能证明无回退，远程 Linux CI 尚未运行。

## 已建立的基线

- 实际工作区快照：`.dev/upgrade-baseline/workspace.zip`，包含 106 个文件；SHA256：`6c73e3c7432841563204303c45d972ea4abbf0e4751c006f4a416fbfca290952`。快照覆盖未提交源文件，不以旧 Git HEAD 代替当前实现。
- 升级前可运行包：`.dev/upgrade-baseline/baseline.jar`。快照、工具安装和原始日志均位于 Git 忽略目录；交付或换机器时须另行保存。
- 比较运行时：Microsoft OpenJDK 21.0.12.1+1、Node 24.21.0、Redis 7.4.11。Java 与 Maven、Node 的官方归档校验均通过。
- Wrapper 3.3.4 固定 Maven 3.9.16，并提交分发包 SHA256。Windows 用 `mvnw.cmd`，Linux/macOS 用 `bash ./mvnw`。
- 升级前后端 80 项通过，失败、错误、跳过均为 0；其中 77 项为已有覆盖，3 项为新增 JSON 兼容检查。真实 Redis 已启用。
- 新运行时上的旧应用重复压测：`benchmarks/results/2026-09-23T06-44-54-952Z/summary.json`。每个场景三次、15 秒预热、30 秒测量、并发 16、JVM 256/512 MiB。
- 全审计吞吐 4645.8–4815.6 req/s，中位数 4683.6；共确认 424370 条，dropped/uncertain/对账差异均为 0。仅转发吞吐 6377.1–7554.1 req/s，中位数 6536.6。开发机波动明显，后续报告使用重复样本比较。

## 前端依赖

Vue 3.5.43、Vite 7.3.6、插件 6.0.9、ECharts 6.1.0、vue-tsc 3.3.11、PostCSS 8.5.28、@types/node 24.13.6；保留 Router 4.6.4、Pinia 2.3.1、TypeScript 5.9.3、Tailwind 3.4.19。

兼容更新、Vite 迁移、ECharts 迁移分别通过 10 项测试及类型检查/生产构建。最终 npm audit 当前返回 0 告警。原有 brace-expansion 已离开依赖树；nanoid 为 3.3.19，Browserslist 为 4.29.0，baseline-browser-mapping 为 2.11.25，postcss-selector-parser 为 6.1.4，esbuild 为 0.28.2。

生产 JS 为 641.46 kB（gzip 222.20 kB），旧版为 608.03 kB（gzip 209.78 kB）。原有 500 kB chunk 提示仍存在；此次没有将安全迁移描述为包体积优化。浏览器验收结果见下文。

## 迁移决策

1. Boot 3.5.16 / Cloud 2025.0.3 只作中间检查点，验证通过后迁移最终平台。
2. Gateway 采用 WebFlux 专用 starter，响应式架构保持不变。
3. JSON 兼容样本由脱敏契约构造，并先在旧应用的实际 mapper / Redis 持久化服务上验证。比较字段与类型，忽略 JSON 属性顺序；不靠更换测试期望值掩盖迁移差异。
4. 本地停机启用新的 Actuator access 配置；生产配置仍只暴露 health、info、metrics。
5. Windows 与 CI 固定维护版工具。微软官方归档已发布但安装器版本索引滞后，CI 因此直接下载固定 Linux 归档，校验已核实的 SHA256，再交给 setup-java 的 jdkfile 安装器。

## 验证日志

原始构建、测试、浏览器及扫描记录位于 `.dev/upgrade-tools/`；旧版本记录位于 `.dev/upgrade-baseline/`。下文区分实际执行的 Windows 本地验证与尚未运行的远端 GitHub Actions。

## 官方依据

- [Spring Cloud 兼容矩阵](https://spring.io/projects/spring-cloud/)
- [Boot 4 迁移指南](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.0-Migration-Guide)
- [Boot 4.1 发布说明](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-4.1-Release-Notes)
- [Microsoft JDK 下载及校验文件](https://learn.microsoft.com/en-us/java/openjdk/download)
- [Maven Wrapper](https://maven.apache.org/tools/wrapper/)
- [setup-java](https://github.com/actions/setup-java)

## 已通过的最终平台验证

- Spring Boot 4.1.1 / Cloud 2025.1.3 / Gateway 5.0.3；JAR 中实际为 Framework 7.0.9、Jackson 3.1.5、Lettuce 7.5.2.RELEASE、Reactor 3.8.7、Netty 4.2.17.Final、Micrometer 1.17.1、Resilience4j 2.3.0。均由 BOM 管理，没有分别覆盖底层版本。
- 原有 77 项测试保留，新增 3 项旧 JSON 契约、2 项 Redis ACL/URL 认证、1 项非单机配置拒绝测试。最终 83 项后端测试通过，0 失败、0 错误、0 跳过。
- 实际 JAR 核对后将 Redis 配置迁移为 `DataRedisProperties`；应用注入 Jackson 3 `JsonMapper` 并使用 `JacksonException`。`LocalServerPort` 保持实际 JAR 中的包名。没有引入旧 Jackson 自动配置或永久配置迁移器。
- Lettuce 7 使用 `setAuthentication`；属性凭据、带转义字符的 URL 凭据及 URL 优先级有真实 Redis 测试。新配置模型中的主从模式被明确拒绝，避免忽略该配置后误写默认节点。
- 上游 `spring-cloud-circuitbreaker-resilience4j:5.0.3` 仍传递依赖 Jackson 2.21.5。保留其依赖关系，应用 JSON 使用 Jackson 3；没有未经验证地排除上游需要的库。
- 最终前端 `npm ci`、10 项测试、类型检查和构建均通过。图表显式配置图例顶部位置和蓝/绿色调，修复 ECharts 6 默认图例位置导致的横轴重叠。
- Edge 153.0.4234.48 实际浏览器：错误/正确凭据、路由保存与重写转发、实时 SSE、日志查询、tooltip、桌面与 480px 宽度图表、离线重连、路由删除及正常停机均通过，无未捕获页面异常。预先存在的 favicon 404 未作为业务失败处理。
- Windows PowerShell 5.1 / PowerShell 7：CheckOnly、SmokeTest、Ctrl+C 均完成验证。5.1 的 SmokeTest 实际通过根目录 Wrapper 构建。Ctrl+C 的外层 PowerShell 返回中断退出码 1，但后端日志确认正常停机，服务端口已释放；没有将该退出码误报为应用异常。
- 自定义前端端口的 CORS 已修复：实际通过 15173 端口保存测试路由返回 201，随后删除。脚本创建的 Redis 会停止；复用的 16379 Redis 始终保持运行。
- 同一 Redis 数据上的回退演练已通过：Boot 3 写入 → Boot 4 读取和更新 → Boot 3 读取新版配置、路由、审计并继续转发。JSON 字段顺序可以变化，字段值及类型兼容。演练等待运行配置恢复完成，因为一般健康端点的 UP 不等于 ApplicationRunner 已完成。

版本、校验、逐项告警、浏览器与回退结果见 [可机读清单](dependency-upgrade-inventory.json)。npm 原有 9 个受影响包已更新或从树中移除，最终扫描为 0；OSV 对 160 个 Maven 解析依赖返回 0 告警、0 查询错误。该扫描包含测试依赖，不覆盖 JDK、容器操作系统和 Maven 插件的内部依赖，也不表示不存在未知漏洞。

## 运行与回退

本次维护版工具安装在 `.dev/toolchains/`，未改动系统 Java/Node 安装和全局环境变量。此工作区可使用以下已验证环境；新机器按 README 安装维护版 JDK 21 与 `.node-version` 指定的 Node，使用根目录 Wrapper。

```powershell
. .\.dev\upgrade-tools\env.ps1
.\dev.ps1
```

回退前正常停止新实例，保留 Redis 数据及原有环境变量，以备份 JAR 启动旧应用：

```powershell
& "$env:JAVA_HOME/bin/java.exe" -jar .dev/upgrade-baseline/baseline.jar
```

生产环境继续要求 `ZENITH_ADMIN_TOKEN`。如果需要回退源代码，先将 `workspace.zip` 解压到一个新目录核对，不要用旧 Git HEAD 覆盖已有的未提交目录重构。启动脚本须与应用一起回退：旧 Boot 3.2 的停机参数是 `management.endpoint.shutdown.enabled=true`，新版本使用 `management.endpoint.shutdown.access=unrestricted`，两者不能同时设置。`.dev/upgrade-bridge/` 另保存已通过的 Boot 3.5 检查点，只供迁移诊断。

## 性能验收结论与限制

三次各 5 分钟持续负载实际达到 2987.4～2995.7 req/s，共 **2,691,660** 条请求全部确认写入；审计丢弃、结果不确定和对账差额均为 0。发生器另有 8,288 个调度漏发与 52 个在途上限漏发，未发送请求不计为成功。

首轮完整审计吞吐中位数下降 13.0%，随后增加旧、新、新、旧、旧、新的交替测量。交替复测中新版约高 1.7%，但合并全部样本后仍低约 10.0%，P95 高约 13.6%。因此本轮接受新平台作为开发基线，保留性能不确定性，不宣称性能提升或无回退；生产容量或性能增益声明需要受控环境复验。

故障注入、真实丢响应重试去重和正常／强制停机探针均符合现有设计边界。正常停机约 4.8 秒排空 200 条待写事件，强制终止仍可能丢失内存队列。全部 30 个性能样本、三次持续负载、资源占用、漏发与故障计数见[性能及可靠性报告](../benchmarks/dependency-upgrade-2026-09-23.md)和[原始汇总](../benchmarks/dependency-upgrade-2026-09-23.json)。

GitHub Actions 配置已更新，但本轮没有提交或推送，未实际运行远程 Linux CI；本地 Windows 的测试、构建、浏览器和启动脚本验收已实际完成。

## 已确认的上游提示

启动时 Hibernate Validator 的 `HV000271` 来自 Gateway 5.0.3 的 `GatewayProperties.routes` 字段：实际 JAR 仍把 `@Valid` 放在 List 字段上，而非元素类型上。应用源码没有该注解，当前绑定和功能测试通过；保留 BOM 版本并在后续 Cloud 维护更新时复查。没有通过关闭校验或屏蔽日志掩盖提示。Mockito 在 JDK 21 上的测试代理动态加载提示属于测试设施；本轮没有改变生产 JVM 参数。
