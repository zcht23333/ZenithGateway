# 展示候选在 Linux CI 发现的响应中断修复

候选 `82e0f8164f4c77160769893babc3a41555e611b0` 的 Verify 通过，但 Release 的真实故障矩阵在 Linux 上失败。上游已经返回部分响应后发出 TCP RST，网关把终态记为 `completed`，客户端仍等待剩余 Content-Length，直到验证工具的 10 秒截止。这个失败没有改为忽略项。

## 原因和范围

使用的 Spring Framework 是 7.0.9。`HttpWebHandlerAdapter` 在响应已提交时调用 `DisconnectedClientHelper`。后者会把 cause 链中 `connection reset by peer` 或 `broken pipe` 判为客户端断开；它明确排除 `WebClientException` 等向外请求的异常。原来的 `UpstreamDisconnect` 是普通 RuntimeException，虽然业务层知道来自上游，最外层适配器仍吞掉错误。

依据为框架对应版本源码：[HttpWebHandlerAdapter](https://github.com/spring-projects/spring-framework/blob/v7.0.9/spring-web/src/main/java/org/springframework/web/server/adapter/HttpWebHandlerAdapter.java)、[DisconnectedClientHelper](https://github.com/spring-projects/spring-framework/blob/v7.0.9/spring-web/src/main/java/org/springframework/web/util/DisconnectedClientHelper.java)。这解释了 Windows 旧复跑成功、Linux 原生异常文字触发失败的差异。

修复只改变向外 HTTP 通道创建的 `UpstreamDisconnect` 的父类型，使用 `WebClientException` 保留其来源身份和原始 cause。已发送的 200/前缀不改写，错误继续向服务器传播并关闭不完整响应；终态为 `error`、原因为 `upstream_disconnect`，熔断仍记一次失败。没有增加重试，也不改变下游取消、六字段配置、限流策略或交接默认值。

新增测试走实际 WebHttpHandlerBuilder、代理保护、审计和完成记录器。Linux reset、Broken pipe 与 Windows reset 三种 cause 验证错误只记录一次、正文不追加错误 JSON；另一个反例保留原始下游断连的框架处理。旧实现 4 例中 2 例失败；修复后 48 项相关测试和 263 项后端全量通过。

真实 Linux 同条件对照也成立：旧包在第 4 组部分响应重置场景超过 10 秒验证截止；修复包完成全部 24 组 / 102 请求及 2 项启动拒绝检查，退出码 0，具名 Redis 客户端和本轮容器均已释放。源码修复提交为 `3a9f0c0183dab846a5c40557b37e184afdaff230`。

## 真实 Linux 补验条件

复用 `verification/proxy-resilience-live.mjs`，可选择由调用方拥有的专属 Redis，并始终使用新的 UUID 键空间。外部 Redis 模式由外层入口负责删除 Redis，子报告不宣称自己已删除。相同镜像、资源、脚本和启动参数对照旧包与修复包。

Docker Desktop 的首次 Lettuce 初始化另外触发了路由读取预算耗尽。750 ms 与 2,000 ms 的失败均保留，均在 readiness 前退出；这不属于代理 RST 修复。为进入功能故障矩阵，单独声明 4,000 ms 路由启动/读取预算；代理连接、响应头、读取停顿和总请求预算未放宽。生命周期 functional/signal 发布夹具也显式记录这一设置；独立冷启动对照入口仍默认 750 ms，产品默认值保持不变。较宽预算不能当作冷启动性能改善或健康容量结论。

原候选 Windows 干净构建包是 `c142c999dcd79acae51b7430cfd8ab60f664ca39a736201fc6aba0f9f752f324`，局部修复构建包是 `0e91dc5a48840bb3736230a30aab61774adfe9c8f4932472f52c1cae3dc2e192`。最后干净提交及 CI 构建另记身份；以上包均没有本轮一小时容量实验。最终真实矩阵、清理与 CI 结果见[候选发布记录](showcase-release.md)。

## 复验

```powershell
./mvnw.cmd -f backend/pom.xml -Dtest=CommittedUpstreamFailureTest test
node verification/proxy-resilience-live.mjs
node verification/acceptance.mjs --tier release --out .dev/release-reproduce --images prepare
```

第一条是适配器时序测试；第二条需按统一工具链说明指定 JAVA_HOME/JAR、Docker，进行真实故障实验；第三条在干净提交上构建并执行完整矩阵。Linux 原生 RST 的真实验证不可由 Windows 测试数量替代。已有一小时结论仍只属于历史 `3f73c65c…` 包。
