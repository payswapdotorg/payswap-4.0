/**
 * PaySwap P3 —— 已落地协议消息面的登记表（单一装配源）。
 *
 * 法则（normative）：
 * 1. **登记即承诺**：出现在本登记表 = 该协议的消息面已落地 = 注册表的
 *    `reverifyBeforeAdapter` 必须为空（protocol-contract.ts 法则 5）。law 电池
 *    （`payswap-protocol-contract.test.ts`）直接枚举本表逐个断言 —— 新增消息面
 *    而不清空清单会在电池上失败，注册门也会以 `protocol_reverify_pending`
 *    拒绝装配。
 * 2. **描述符不手抄**：每个消息面的描述符由注册表 pin 派生
 *    （`payswapProtocolAdapterDescriptor`）—— URL / 检索日期 / 版本只有一个来源。
 * 3. **适配器不持签发能力**：装配只把 `evidenceVerifier`（验证端口）交给消息面；
 *    证据签发能力留在宿主证据权威（services 侧）。
 */

import { createPayswapAp2MessageFace } from "./ap2-message-face.js";
import type {
  PayswapProtocolAdapter,
  PayswapProtocolEvidenceVerifier,
} from "./protocol-contract.js";
import { payswapProtocolAdapterDescriptor } from "./protocol-contract.js";
import { createPayswapMppMessageFace } from "./mpp-message-face.js";
import { createPayswapX402MessageFace } from "./x402-message-face.js";
import type { PayswapProtocolId } from "./protocol-facts.js";

export interface PayswapProtocolMessageFaceOptions {
  readonly evidenceVerifier?: PayswapProtocolEvidenceVerifier;
}

export type PayswapProtocolMessageFaceFactory = (
  descriptor: ReturnType<typeof payswapProtocolAdapterDescriptor>,
  options?: PayswapProtocolMessageFaceOptions,
) => PayswapProtocolAdapter;

/** 已落地消息面（protocolId → 工厂）。新增协议 = 注册表 + 本表 + law 电池同变更。 */
export const PAYSWAP_PROTOCOL_MESSAGE_FACE_FACTORIES = {
  ap2: createPayswapAp2MessageFace,
  mpp: createPayswapMppMessageFace,
  x402: createPayswapX402MessageFace,
} as const satisfies Record<PayswapProtocolId, PayswapProtocolMessageFaceFactory>;

export type PayswapLandedProtocolId = keyof typeof PAYSWAP_PROTOCOL_MESSAGE_FACE_FACTORIES;

export const PAYSWAP_LANDED_PROTOCOL_IDS = [
  "ap2",
  "mpp",
  "x402",
] as const satisfies readonly PayswapLandedProtocolId[];

/**
 * 按登记表装配全部已落地消息面（生产装配入口；描述符由注册表派生）。
 * 任一协议的注册门未关 → 该工厂抛错（装配期 fail-loud，不降级装配）。
 */
export function createPayswapProtocolMessageFaces(
  options: PayswapProtocolMessageFaceOptions = {},
): PayswapProtocolAdapter[] {
  return PAYSWAP_LANDED_PROTOCOL_IDS.map((protocolId) =>
    PAYSWAP_PROTOCOL_MESSAGE_FACE_FACTORIES[protocolId](
      payswapProtocolAdapterDescriptor(protocolId),
      options,
    ),
  );
}
