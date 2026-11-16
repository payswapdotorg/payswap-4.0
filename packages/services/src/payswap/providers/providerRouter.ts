/**
 * PaySwap P3 —— provider 端口路由器（runtime 装配面：多 provider 的读回/数据读
 * 端口按 providerId 分发）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **哑分发**：路由器只做 providerId → adapter 的闭集查表分发；无逻辑、无
 *    重试、无缓存、无字段改写（与 runtime reader 面零转换同款纪律）。
 * 2. **未知 provider = 装配错误**：查表失败 → 抛出（fail-closed 响亮 ——
 *    accountService 把端口异常映射为 typed `read_back_unavailable` / 数据面
 *    `unavailable` 拒绝，状态不变）。
 * 3. **单实例单写者不变**：路由器不创建服务实例；唯一写者仍是 accountService。
 */

import type {
  PayswapAccountDataReadInput,
  PayswapAccountDataReadPort,
  PayswapAccountReadBackInput,
  PayswapAccountReadBackOutcome,
  PayswapAccountReadBackPort,
  PayswapReadonlyCategoryResult,
} from "@zcode/shared/payswap";

/** 读回端口的 per-provider 路由表（providerId → port）。 */
export function createPayswapProviderReadBackRouter(
  routes: ReadonlyMap<string, PayswapAccountReadBackPort>,
): PayswapAccountReadBackPort {
  return async (input: PayswapAccountReadBackInput): Promise<PayswapAccountReadBackOutcome> => {
    const port = routes.get(input.providerId);
    if (port === undefined) {
      throw new Error(
        `No PaySwap provider read-back adapter is routed for '${input.providerId}'; check the host wiring.`,
      );
    }
    return port(input);
  };
}

/** 数据读端口的 per-provider 路由表（providerId → port）。 */
export function createPayswapProviderDataReadRouter(
  routes: ReadonlyMap<string, PayswapAccountDataReadPort>,
): PayswapAccountDataReadPort {
  return async (input: PayswapAccountDataReadInput): Promise<PayswapReadonlyCategoryResult> => {
    const port = routes.get(input.providerId);
    if (port === undefined) {
      throw new Error(
        `No PaySwap provider data-read adapter is routed for '${input.providerId}'; check the host wiring.`,
      );
    }
    return port(input);
  };
}
