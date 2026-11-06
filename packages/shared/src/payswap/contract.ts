/**
 * shared-payswap 对外契约（P1.2，契约 w2-01 §4/§6.4/§6.5/§10）。
 *
 * 本模块是 PaySwap broker 协议的**唯一共享实现**（w2-01 §6.4(5)，normative）：host 侧签名
 * 与 child 侧验签必须用同一份 canonical JSON / envelope 代码 —— 两份实现漂移即违约。
 *
 * 调用方分两侧，职责不同：
 * - host 侧（bootstrap / cli 的受信注入与启动断言路径）：`mintBrokerBootState` 在 broker
 *   boot 时铸 per-boot Ed25519 密钥对与 host id（私钥**只**存在于 host 内存，§6.5(1)）；
 *   `createPayswapInstanceRegistry` 管 append/tombstone-only 实例注册表（§10）；
 *   `signResponseEnvelope` 对每个响应信封签名（§6.5(2)——v1 无未签名模式）。
 * - child 侧（官方 payswap-plugin 的 bridge client，Step 4+ 接线）：`verifyResponseEnvelope`
 *   按 §6.5(3)(a)–(h) 全序验签与绑定校验，任何失败整封拒绝且不外露被拒字段。
 *
 * 不变量（违反即实现缺陷，不是风格问题）：
 * 1. envelope 的 instanceId/seq/op 是 request-attributed、never claim-echoed（§6.4(3)）：
 *    pre-binding 拒绝一律 null-bound；null-bound 信封永不满足子进程绑定（F1）。
 * 2. requestDigest 的字节区间唯一定义在 §6.4(2)：精确请求行、不含结尾换行（F4）。
 * 3. 五键凭据组 all-or-nothing（§4.4(1)）：部分出现/形状非法 → 快照清空，半组永不启动。
 * 4. 重放缺口 G = 64 是冻结的 v1 协议常量（§9.4/ADR-2）—— 常量与两侧引擎
 *    （broker seen-record 引擎 §9.3、child 发送边界分配器 §9.3(5)）自 Step 6 起以
 *    replay.ts 落在本模块（共享单一实现纪律），但**不引入任何可配置 surface**。
 * 5. 每个验签失败原因机器可读且互不相同（`PayswapBrokerResponseRejectionReason`）。
 *
 * 幂等/持久化：本模块全部为内存态、无 IO 副作用（node:crypto 系统原语除外）；注册表
 * append/tombstone-only，条目冻结。事件：无（观测由 host 侧 audit 层负责，§11）。
 */
export type SharedPayswapId = string & { readonly __brand: "SharedPayswapId" };

export interface SharedPayswapContract {
  // P1.2 的公共面即 index.ts 再导出的模块本身（见各文件的 per-method 契约注释）；
  // 本接口保留为 managed-module 惯例占位 —— shared-payswap 的方法契约分散在
  // broker-env / broker-identity / envelope / instance-registry 的具名导出上，
  // 不经此接口聚合（跨侧调用方按侧取用，聚合反而制造错误的单向依赖印象）。
}
