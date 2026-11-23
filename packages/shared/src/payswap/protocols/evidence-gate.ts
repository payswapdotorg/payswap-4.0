/**
 * PaySwap P3-A —— 宿主收据证据门（三个协议适配器共用的唯一实现）。
 *
 * 法则（normative）：
 * 1. 证据必须由**宿主证据权威**签发 —— 适配器只持有 `verify` 端口，不持有
 *    签发能力；结构合法的伪造对象因验证失败而 `protocol_evidence_untrusted`。
 * 2. 证据必须属于**本协议** —— 跨协议复用（把 MPP 证据拿去发 AP2 收据）即
 *    `protocol_evidence_untrusted`。
 * 3. 状态门不变：仅 `settled-verified` 可产收据；`indeterminate`/`pending`/
 *    `failed` → `protocol_receipt_unavailable`（协议 accepted ≠ 结算）。
 * 4. verifier 缺席 = fail-closed（`protocol_evidence_untrusted`），绝不「无验证
 *    器即放行」。
 */

import { z } from "zod";
import type { PayswapProtocolId } from "./protocol-facts.js";
import type {
  PayswapProtocolEvidenceVerifier,
  PayswapProtocolRefusal,
  PayswapProtocolSettlementEvidence,
} from "./protocol-contract.js";

const settlementEvidenceSchema = z
  .object({
    evidenceRef: z.string().min(1),
    evidenceDigest: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    state: z.enum(["settled-verified", "indeterminate", "pending", "failed"]),
    capturedAt: z.string().datetime({ offset: true }),
    hostAttestationId: z.string().min(1),
    protocolId: z.enum(["ap2", "x402", "mpp"]),
    subjectRef: z.string().min(1),
  })
  .strict();

export type PayswapProtocolReceiptEvidenceOutcome =
  | { readonly kind: "accepted"; readonly evidence: PayswapProtocolSettlementEvidence }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

function refusal(
  code: PayswapProtocolRefusal["code"],
  message: string,
): PayswapProtocolRefusal {
  return { code, message };
}

/**
 * 收据证据门（法则 1-4）。生产适配器与 law 级测试共用本实现 —— 三份漂移即违约。
 */
export async function evaluatePayswapProtocolReceiptEvidence(input: {
  readonly evidence: PayswapProtocolSettlementEvidence | null;
  readonly protocolId: PayswapProtocolId;
  readonly verifier?: PayswapProtocolEvidenceVerifier;
}): Promise<PayswapProtocolReceiptEvidenceOutcome> {
  const { evidence, protocolId, verifier } = input;
  if (evidence === null) {
    return {
      kind: "refused",
      refusal: refusal(
        "protocol_receipt_unavailable",
        "收据面被要求但宿主结算证据缺席 —— 协议 accepted ≠ 结算（typed 拒绝）",
      ),
    };
  }
  const shape = settlementEvidenceSchema.safeParse(evidence);
  if (!shape.success) {
    return {
      kind: "refused",
      refusal: refusal(
        "protocol_receipt_unavailable",
        `宿主结算证据形态非法（畸形引用/摘要/时间戳/签发标识）—— 不伪造结算事实：${
          shape.error.issues[0]?.message ?? "schema error"
        }`,
      ),
    };
  }
  if (shape.data.protocolId !== protocolId) {
    return {
      kind: "refused",
      refusal: refusal(
        "protocol_evidence_untrusted",
        `结算证据属于协议 '${shape.data.protocolId}'，不可用于 '${protocolId}' 收据（跨协议复用拒绝）`,
      ),
    };
  }
  if (verifier === undefined) {
    return {
      kind: "refused",
      refusal: refusal(
        "protocol_evidence_untrusted",
        "适配器未装配宿主证据验证器 —— 无签发权威可核验，收据 fail-closed（不采信自述证据）",
      ),
    };
  }
  let verified = false;
  try {
    // 传原始对象（而非 schema 解析副本）—— 证据权威按对象身份核验签发记录；
    // zod 的 .strict() 会产出新对象，若传副本则所有真证据都会被误判为伪造。
    verified = await verifier.verify(evidence);
  } catch {
    verified = false;
  }
  if (!verified) {
    return {
      kind: "refused",
      refusal: refusal(
        "protocol_evidence_untrusted",
        "结算证据未通过宿主证据权威验证（伪造/篡改/未签发）—— 适配器不得铸造结算事实",
      ),
    };
  }
  if (shape.data.state !== "settled-verified") {
    return {
      kind: "refused",
      refusal: refusal(
        "protocol_receipt_unavailable",
        `结算证据状态为 '${shape.data.state}' —— 不可判定结局不得产生成功收据（协议 accepted ≠ 结算）`,
      ),
    };
  }
  return {
    kind: "accepted",
    evidence,
  };
}
