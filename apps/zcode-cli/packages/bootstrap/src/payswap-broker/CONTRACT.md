# payswap-broker

PaySwap broker 的 **host 侧运行时**（P1.3 Step 3 + P1.4 Step 4 + P1.5 Step 5 + P1.6 Step 6）：UDS 端点落位（per-boot
0700 目录 + 0600 socket、绑定前拒绝/移除既有条目）、启动期自探针（真实 loopback 对上
验证对等凭据读取路径，失败即 `degraded_refusing`）、§5.5 检查序（对等验证 → 解析+
1 MiB 上限 + §6.1 `.strict()` 请求 schema → 时序安全 token 比对 → 实例/注册表绑定
（tombstone 原因分裂）→ **§8 会话解析 + 工作区隔离（Step 5：live 实例经 resolver 权威
下游解析 sessionId hint，判定字段 = 注册条目 sessionScope；实体引用对照 workspace；
无 resolver 即 fail-closed session_unresolvable）** → **§9 重放检查（Step 6：连续水标/
保留集引擎 + 冻结 G=64 —— 受理边界在此，重放/缺口先于 dispatch 拒绝；退役声明按
载体命运独立处理）** → 闭集 dispatch）、全响应签名
（null-bound / request-attributed 拒绝纪律）、生命周期（close 兜底）与审计 ingress。

Step 4 落地（§6/§7）：`dispatch.ts` 的闭集六操作表（enum → per-op schema 的字面 map，
N21 皮带扣 operation_not_found）、§7.3 三码法则（live reader 每次请求现读；缺省 S2
not_connected；reader 故障 internal_error）、§7.4 dormant grant hook（authorizationId
在 Wave 2 是未知 params 键，schema 层即拒）、D5.6 升级（disable tombstone 流通到
financial_mode_disabled 业务拒绝）。宿主接线（lazy boot / 受信注入 / 进程观察 /
disable 撤销）在 `payswap-broker/spawn-wiring.ts`（宿主接线半边，
经本模块公开入口导出）。

Step 5 落地（§8，ADR-8）：`session-scope.ts` 的 resolver 端口（§8.1 会话 / §8.3 实体）
与 §8.2 判定（`isSessionWithinBindingScope` —— 只认 sessionScope 字段）；server.ts
步 (4.5) 执行（disable 撤销臂绕过，D8.3）；spawn-wiring.ts 的 `bindSessionScopeResolver`
facade（每次请求现读槽位，绑定晚于 boot 也生效）与 app 面单会话工厂；协议宿主面的
`createPayswapSessionScopeResolver`（server-types.ts，requireSession 模式）。

Step 6 落地（§9，ADR-9）：seen-record 引擎（连续水标 W + 保留集 R + resolved-missing
集 M，§9.3/§9.4）以共享模块 `@zcode/shared/payswap/replay.ts` 的单一实现接入 server.ts
步 (5) —— 受理边界在 dedupe 步（accepted-for-dispatch，与 dispatch 结局无关；§8 拒绝
在界前不烧序列，D8.1；disable 撤销臂同过界，D5.6）；重放/缺口先于 dispatch 拒绝
（N33/N34/N35/N39、W+64/W+65）；退役声明按载体命运独立处理（rev 2a —— 过了步 (1)-(4)
的载体在一切出路上都解析其 retiredSeqs），调用点在载体自身判定之后（D9.1）；
`seenRecords` boot 选项注入（缺省内部新建；测试内省用，同 liveStateReader/
sessionScopeResolver 注入面纪律）。

## 不变量

- §5.5 检查序不可重排：未知 pid 在任何载荷字节被解析之前丢弃（§5.1/§5.2）；§8 在步
  (4) 与步 (5)（重放，Step 6 已落地）之间 —— pre-dispatch 拒绝不烧序列（ADR-8 D8.1）；
  §9 受理边界在步 (5)（ADR-9 D9.4 —— 过界即烧序列，与 dispatch 结局无关）；载体自身
  判定先于其退役处理（ADR-9 D9.1）。
- §5.4 fail-closed：子系统不可用 → degraded_refusing；token-only 回退被禁止。
- §8.1 fail-closed：无会话 resolver → live 请求一律 session_unresolvable（resolved,
  never asserted）；会话身份永不取自载荷（ADR-8 D8.2）。
- §9.4 冻结 G=64：无任何配置面（ADR-2）；|R| ≤ G 恒成立（结构性 + belt 不变量检查，
  违反即实现缺陷 → internal_error）；退役仅在过步 (1)-(4) 的载体上处理（ADR-9 D9.1）。
- 一切响应签名（§6.5(2)）；pre-binding 拒绝 null-bound（§6.4(3)）。
- failPeer = `end + resume`（D5.4）：错误行完整可达，剩余字节消费-丢弃、绝不解析。
- close()：先摘路径、宽限强断（默认 250 ms）、finally 无条件清理、幂等（ADR-6）。
- 审计只记 typed code（新增 `retired` outcome 逐条携带退役效果，ADR-9 D9.6）；token /
  verify key / endpoint path 永不入审计；§8 拒绝额外不记 session hint 与解析出的
  工作区值（§11(2) 精神，ADR-8 D8.7）。
- Linux 对等验证的每个 pid/uid 都来自内核（ss SOCK_DIAG 配对 + /proc 持有者扫描 +
  /proc/<pid>/status），线上 claim 永不被采纳（ADR-3）。

## 模块交集

- `@zcode/shared/payswap`：信封签名 / 注册表 / 摘要 / op 闭表 —— 协议数学的唯一实现，
  本模块只消费不复制（§6.4(5)）。
- payswap-plugin（child 侧，Step 4+ 接线）：不经本模块；child 经 shared 的
  `verifyResponseEnvelope` 验签。
- `@zcode/shared/payswap` operations（Step 4）：六操作 per-op params schema、§6.1
  请求 schema、三码业务拒绝 —— dispatch 只消费不复制。
- `@zcode/bootstrap` mcp-config / `payswap-broker/spawn-wiring.ts` / `@zcode/cli`
  plugin-host-command：受信注入、spawn 表注册观察与启动断言（Step 4 已接线）。
- `@zcode/bootstrap` zcode-protocol（Step 5）：`createPayswapSessionScopeResolver`
  （requireSession 模式的 §8 端口）+ `ZCodeProtocolAgentServer.payswapSessionScopeResolver`
  窄端口 —— 入口（zcode-protocol-entrypoint.ts）构造 server 后绑进协调器；create-app
  的自有协调器用 `createSingleSessionScopeResolver`（app 面单会话）。
