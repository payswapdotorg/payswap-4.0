/**
 * `@zcode/shared/payswap` —— PaySwap broker 协议的共享单一实现（契约 w2-01 §6.1(3)、
 * §6.4(5)、§9、§12.1；ADR-1/ADR-2/ADR-9）。
 *
 * canonical JSON、信封签名/验签、重放两侧引擎（seen-record 引擎 + 发送边界分配器）的
 * **唯一**实现住在这里：host（签名/受理）与 child（验签/分配）用同一份代码，两份实现
 * 漂移即违约。五键凭据组常量/校验、host-boot 身份铸造、实例注册表一并在此
 * （P1.2 Step 2；契约 §4、§6.5(1)、§10；重放 §9 = P1.6 Step 6）；子进程侧 bridge
 * transport（UDS connect → 行写 → 验签接线 → 分配器重试环）随 Step 7 落地于此
 * （ADR-9 D9.7 + ADR-10）。P1.6 的 operator-principal 法则（凭据/注册表/两级握手，
 * addendum §1.6.3）也在此：server 侧（packages/server 的 operator 存储与 /ws 接线）
 * 与 law 级测试共用同一份实现（ADR-11）。P1.7 的交易授权 grant 法则（tuple/digest/
 * 绑定、单一铸造路径的 grant ledger 与 enforcement seam、Class-B 卡 payload、
 * 批准 origin 三检与事件判别、批准流状态机 + 卡实例 challenge 存储，addendum
 * §1.3/§1.6）同样在此：server 侧批准装配（packages/server 的 approval host）与
 * law 级测试共用同一份实现（ADR-12）。P1.8 的表面生命周期法则（T3 卡臂的
 * financialMode live 读门 + T7 item 3 的 revokePendingProposals；§2.3 item 1 臂 (b)
 * 的表面内容注册表与 opt-out 撤销执行器，surface-revocation.ts）也在此：桌面卡
 * 接线（D12.7）以 runPluginUiHostTeardown / clearPluginUiSurfaceFeed /
 * clearPluginUiWidgetState 接线本模块的端口。
 */

export * from "./canonical-json.js";
export * from "./broker-env.js";
export * from "./broker-identity.js";
export * from "./envelope.js";
export * from "./instance-registry.js";
export * from "./operations.js";
export * from "./replay.js";
export * from "./bridge-client.js";
export * from "./operator-credentials.js";
export * from "./operator-registry.js";
export * from "./operator-handshake.js";
export * from "./authorization-tuple.js";
export * from "./grant-ledger.js";
export * from "./approval-card.js";
export * from "./approval-origin.js";
export * from "./approval-flow.js";
export * from "./hook-admission.js";
export * from "./browser-admission.js";
export * from "./authorization-surfaces.js";
export * from "./credential-security.js";
export * from "./surface-revocation.js";
export * from "./approval-desktop.js";
