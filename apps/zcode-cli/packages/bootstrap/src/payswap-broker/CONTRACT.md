# payswap-broker

PaySwap broker 的 **host 侧运行时**（P1.3 Step 3）：UDS 端点落位（per-boot 0700 目录 +
0600 socket、绑定前拒绝/移除既有条目）、启动期自探针（真实 loopback 对上验证对等凭据
读取路径，失败即 `degraded_refusing`）、§5.5 检查序（对等验证 → 解析+1 MiB 上限 →
时序安全 token 比对 → 实例/注册表绑定）、全响应签名（null-bound 拒绝纪律）、生命周期
（close 兜底）与审计 ingress。

## 不变量

- §5.5 检查序不可重排：未知 pid 在任何载荷字节被解析之前丢弃（§5.1/§5.2）。
- §5.4 fail-closed：子系统不可用 → degraded_refusing；token-only 回退被禁止。
- 一切响应签名（§6.5(2)）；pre-binding 拒绝 null-bound（§6.4(3)）。
- failPeer = `end + resume`（D5.4）：错误行完整可达，剩余字节消费-丢弃、绝不解析。
- close()：先摘路径、宽限强断（默认 250 ms）、finally 无条件清理、幂等（ADR-6）。
- 审计只记 typed code；token / verify key / endpoint path 永不入审计（§11）。
- Linux 对等验证的每个 pid/uid 都来自内核（ss SOCK_DIAG 配对 + /proc 持有者扫描 +
  /proc/<pid>/status），线上 claim 永不被采纳（ADR-3）。

## 模块交集

- `@zcode/shared/payswap`：信封签名 / 注册表 / 摘要 / op 闭表 —— 协议数学的唯一实现，
  本模块只消费不复制（§6.4(5)）。
- payswap-plugin（child 侧，Step 4+ 接线）：不经本模块；child 经 shared 的
  `verifyResponseEnvelope` 验签。
- `@zcode/bootstrap` mcp-config / `@zcode/cli` plugin-host-command（P1.2 已落）：
  受信注入与启动断言 —— 与本模块的 spawn 表注册在集成 PR（Step 4+）接线。
