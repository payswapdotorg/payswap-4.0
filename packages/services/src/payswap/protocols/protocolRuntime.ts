/**
 * PaySwap P3-D —— 协议宿主的生产装配（单一实例）。
 *
 * 法则（normative）：
 * 1. **一个宿主、一个协议宿主实例**：生产装配只经本工厂 —— 证据权威、challenge
 *    注册表、三个已落地消息面与协议宿主在同一处成套创建；重连/重建宿主面时
 *    注册表随实例保留（challengeRegistry 法则 2）。
 * 2. **签发能力不出厂**：返回面只有 `protocolHost`（收据发射只收 `evidenceRef`）。
 *    证据权威的 `issue` 留在闭包内 —— P3 没有结算事实的签发者（P7 的执行/对账
 *    权威才接管），所以 P3 的生产宿主**发不出任何协议收据**（fail-closed）。
 * 3. **适配器只拿验证端口**：三个消息面以 `evidenceVerifier` 装配；不持有注册
 *    表、签发能力、provider 凭据（类型面与装配面都不注入）。
 */

import { createPayswapProtocolMessageFaces } from "@zcode/shared/payswap";
import { createPayswapProtocolChallengeRegistry } from "./challengeRegistry.js";
import { createPayswapHostEvidenceAuthority } from "./evidenceAuthority.js";
import { createPayswapProtocolHost, type PayswapProtocolHost } from "./host.js";

export interface PayswapProtocolRuntimeDependencies {
  /** 宿主时钟（过期裁决的唯一时间源）；缺省 = 系统时钟。测试注入。 */
  readonly clock?: () => Date;
}

export interface PayswapProtocolRuntime {
  /** 协议宿主面 —— 唯一生产调用面。不含证据签发能力。 */
  readonly protocolHost: PayswapProtocolHost;
}

export function createPayswapProtocolRuntime(
  dependencies: PayswapProtocolRuntimeDependencies = {},
): PayswapProtocolRuntime {
  // 证据权威留在闭包内：`issue` 不出现在任何返回面上。
  const evidenceAuthority = createPayswapHostEvidenceAuthority();
  const protocolHost = createPayswapProtocolHost({
    adapters: createPayswapProtocolMessageFaces({ evidenceVerifier: evidenceAuthority.verifier }),
    challengeRegistry: createPayswapProtocolChallengeRegistry(),
    evidenceAuthority,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  return Object.freeze({ protocolHost });
}
