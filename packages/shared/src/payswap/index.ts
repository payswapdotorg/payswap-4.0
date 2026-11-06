/**
 * `@zcode/shared/payswap` —— PaySwap broker 协议的共享单一实现（契约 w2-01 §6.1(3)、
 * §6.4(5)、§12.1；ADR-1）。
 *
 * canonical JSON、信封签名/验签的**唯一**实现住在这里：host（签名）与 child（验签）用
 * 同一份代码，两份实现漂移即违约。五键凭据组常量/校验、host-boot 身份铸造、实例注册表
 * 一并在此（P1.2 Step 2；契约 §4、§6.5(1)、§10）。
 */

export * from "./canonical-json.js";
export * from "./broker-env.js";
export * from "./broker-identity.js";
export * from "./envelope.js";
export * from "./instance-registry.js";
export * from "./operations.js";
