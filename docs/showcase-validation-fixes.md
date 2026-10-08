# 候选发布中的两项验证工具修正

## 故障期间的恢复探测不等于业务命令残留

提交 `5ddedb1f2f773859d379319dafa04eb072080db1` 的 Linux Release 已通过代理矩阵，在 limiter-policy 的第三种策略组合中等待“全部资源为零”超过 7 秒，发布仍判失败。

原始 RESP 证据显示，`A-local-strict` 的业务命令在连接关闭时丢弃，未转发 Redis；之后是每约 1.5 秒一条、无桶键的恢复探测。夹具同时阻断业务和探测，决策预算 1,500 ms、探测间隔 300 ms，因此相邻探测的空隙可能短于 20 ms 的采样间隔。原报告未保存每次诊断读数，不能事后补造逐次状态；但原来的全零条件确实要求了持续故障期间并不承诺的瞬时空闲。

修正只针对夹具的观察边界：

1. 故障仍存在时，要求这次请求涉及的每条真实 RESP 业务命令均已观察到物理连接关闭、没有保留任务、准入名额全部归还、业务和交接队列归零；仍逐项检查既有资源上限。最多允许一条明确处于 probing 状态的恢复探测，不能把普通工作归入这个例外。
2. 解除故障后，仍要求 transport healthy，并按原条件核对命令、工作线程、队列和任务全部归零。实际额度、上游接收、429/503、unknown、取消、审计与无重发断言都保留。

新增确定性工具测试使每个观察时刻都落在探测期间：原全零判断始终不成立；新判断只在物理业务命令已关闭时通过。额外覆盖“只有 HTTP 完成/Redis 回复但没有关闭”、名额未还、资源超限和恢复后残留。真实入口保存最多 64 条紧凑观察，失败也保留轨迹。没有扩大等待时间或调整业务算法、探测周期、线程和队列配置。

## Windows 克隆必须保持证据字节

在 `core.autocrlf=true` 的全新克隆中，原证据 JSON 被 Git 转换换行，首个成员由 1,245 变为 1,282 字节，校验正确地拒绝。`.gitattributes` 现在对 `docs/evidence/**` 使用 `-text`，保持归档原字节；验证器继续严格检查大小与 SHA256，不做换行归一化。

这项设置只影响证据目录。业务源码的跨平台构建仍各自记录 JAR 身份，不宣称所有系统生成完全相同的 ZIP 字节。

## 证据与复验

失败及补验结果见[候选证据清单](evidence/showcase-candidate-20261008/manifest.json)和[候选发布记录](showcase-release.md)。工具夹具测试与真实 Redis/JVM 故障实验分开统计。

```powershell
node --test verification/limiter-policy-gates.test.mjs
node verification/acceptance.mjs --tier release --out .dev/release-tool-fix --images prepare
node verification/showcase-evidence.mjs
node verification/showcase-evidence.mjs --manifest docs/evidence/showcase-candidate-20261008/manifest.json
```
