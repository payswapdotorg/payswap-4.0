/**
 * `@zcode/ui/payswap` —— PaySwap 表面撤销接线（@zcode/ui 侧 managed 模块；ADR-12
 * D12.7 的「N18's full plugin-handle teardown arm」—— surface-revocation 法则
 * （shared-payswap）与真实 plugin-ui 原语之间的绑定 owner）。
 *
 * 公开面见 contract.ts；实现见 surfaceRevocationWiring.ts 与
 * PayswapAuthorizationCardHost.tsx（Class-B 授权卡组件 —— D12.7 desktop card
 * wiring 的 renderer 半）。
 */

export * from "./surfaceRevocationWiring.js";
export { PayswapAuthorizationCardHost } from "./PayswapAuthorizationCardHost.js";
