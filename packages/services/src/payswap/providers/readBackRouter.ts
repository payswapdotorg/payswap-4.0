/**
 * PaySwap P3 provider half —— 读回端口路由器（per-provider 读回 adapter 的
 * 分发面；runtime 的单一 `PayswapAccountReadBackPort` 注入点）。
 *
 * 法则：按 `input.providerId` 分发到注册的 adapter；未注册 provider = 装配
 * 错误 → 抛出（accountService 把端口异常映射为 typed `read_back_unavailable`
 * 拒绝，状态不变 —— fail-closed，绝不猜）。adapter 自身继续执行各自文件头的
 * 装配防线（providerId/secretKind 错配抛出、custodian 标记拒绝、模式一致性）。
 */

import type {
  PayswapAccountReadBackInput,
  PayswapAccountReadBackOutcome,
  PayswapAccountReadBackPort,
} from "@zcode/shared/payswap";

export interface PayswapAccountReadBackRouterDependencies {
  /** per-provider 读回 adapter（键 = providerId；至少一个 —— 空表 = 装配缺陷）。 */
  readonly byProvider: Readonly<Record<string, PayswapAccountReadBackPort>>;
}

/** 创建按 providerId 分发的读回端口（runtime 的单一注入点）。 */
export function createPayswapAccountReadBackRouter(
  dependencies: PayswapAccountReadBackRouterDependencies,
): PayswapAccountReadBackPort {
  const byProvider = dependencies.byProvider;
  if (Object.keys(byProvider).length === 0) {
    throw new Error(
      "The PaySwap read-back router was assembled with no provider adapters; check the host wiring.",
    );
  }
  return async (input: PayswapAccountReadBackInput): Promise<PayswapAccountReadBackOutcome> => {
    const adapter = byProvider[input.providerId];
    if (adapter === undefined) {
      throw new Error(
        `No PaySwap read-back adapter is registered for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    return adapter(input);
  };
}
