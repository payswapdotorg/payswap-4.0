/**
 * PaySwap P3 provider half —— 只读数据端口路由器（per-provider 数据 adapter 的
 * 分发面；runtime 的单一 `PayswapAccountDataReadPort` 注入点）。
 *
 * 法则：按 `input.providerId` 分发到注册的 adapter；未注册 provider = 装配错误
 * → 抛出（accountService 把端口异常映射为 honest `unavailable` 类别结果 ——
 * fail-closed，绝不猜）。adapter 自身继续执行各自文件头的装配防线。
 */

import type {
  PayswapAccountDataReadInput,
  PayswapAccountDataReadPort,
  PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";

export interface PayswapAccountDataReadRouterDependencies {
  /** per-provider 数据 adapter（键 = providerId；至少一个 —— 空表 = 装配缺陷）。 */
  readonly byProvider: Readonly<Record<string, PayswapAccountDataReadPort>>;
}

/** 创建按 providerId 分发的数据读端口（runtime 的单一注入点）。 */
export function createPayswapAccountDataReadRouter(
  dependencies: PayswapAccountDataReadRouterDependencies,
): PayswapAccountDataReadPort {
  const byProvider = dependencies.byProvider;
  if (Object.keys(byProvider).length === 0) {
    throw new Error(
      "The PaySwap data-read router was assembled with no provider adapters; check the host wiring.",
    );
  }
  return async (input: PayswapAccountDataReadInput): Promise<PayswapReadonlyCategoryResult> => {
    const adapter = byProvider[input.providerId];
    if (adapter === undefined) {
      throw new Error(
        `No PaySwap data-read adapter is registered for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    return adapter(input);
  };
}
