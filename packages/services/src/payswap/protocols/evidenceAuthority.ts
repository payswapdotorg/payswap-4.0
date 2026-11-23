/**
 * PaySwap P3-A —— 宿主证据权威（结算证据的唯一签发者与验证端口）。
 *
 * 法则（normative）：
 * 1. **单一签发者**：只有本权威可以铸造 `PayswapProtocolSettlementEvidence`；
 *    适配器只拿到 `verifier`（验证端口），拿不到 `issue`。这是 P3 的可信度
 *    边界 —— 结构合法但没有签发记录的对象一律 `protocol_evidence_untrusted`。
 *    与 P1 grant ledger 的配对 minter 同一纪律（shared CONTRACT §1.3）：签发
 *    能力是进程内能力，不暴露给任何不受信调用方。
 * 2. **不可伪造性 = 进程内能力 + 不可变快照**：签发记录进私有 Map 与 WeakSet；
 *    证据对象被 `Object.freeze`。克隆/序列化/重造对象失去身份 → 验证失败；
 *    篡改冻结对象在严格模式下抛错。另一个权威实例签发的对象同样不被采信。
 *    跨进程传输需要 P7 账本的签名信封，P3 不假装支持。
 * 3. **签发即合形**：`issue` 只接受收据门（evidence-gate）会接受的形状 —— 不
 *    存在「已签发却被门拒绝」的记录。
 * 4. **协议与主体绑定**：证据记录 protocolId + subjectRef（执行/对账记录引用）；
 *    适配器侧另做跨协议复用拒绝（evidence-gate 法则 2）。
 * 5. **不新增第二账本**：本模块不是账本、不持久化、不记录资金事实；它只是
 *    P7 权威账本/证据服务暴露给协议边界的签发与验证端口。证据内容必须由宿主
 *    执行/对账服务提供，适配器与 agent 无权构造。**P3 没有这样的签发者**：
 *    生产装配不暴露 `issue`（见 protocolRuntime），所以 P3 的生产宿主发不出
 *    任何协议收据 —— 直到 P7 的执行/对账权威接管签发。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PayswapProtocolEvidenceVerifier,
  PayswapProtocolId,
  PayswapProtocolSettlementEvidence,
} from "@zcode/shared/payswap";

/** 与 evidence-gate 的结构 schema 同形（签发时刻就强制 —— 法则 3）。 */
const hostEvidenceClaimSchema = z
  .object({
    evidenceRef: z.string().min(1),
    evidenceDigest: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    state: z.enum(["settled-verified", "indeterminate", "pending", "failed"]),
    capturedAt: z.string().datetime({ offset: true }),
    protocolId: z.enum(["ap2", "x402", "mpp"]),
    subjectRef: z.string().min(1),
  })
  .strict();

export interface PayswapHostEvidenceClaim {
  readonly evidenceRef: string;
  readonly evidenceDigest: string;
  readonly state: "settled-verified" | "indeterminate" | "pending" | "failed";
  readonly capturedAt: string;
  readonly protocolId: PayswapProtocolId;
  /** 执行/对账记录引用（宿主服务提供 —— 适配器不可构造）。 */
  readonly subjectRef: string;
}

export interface PayswapHostEvidenceAuthority {
  /** 签发（宿主内部调用；适配器拿不到）。重复 evidenceRef = 宿主编程错误。 */
  issue(claim: PayswapHostEvidenceClaim): PayswapProtocolSettlementEvidence;
  /** 验证端口（注入适配器工厂的唯一证据可信度判据）。 */
  readonly verifier: PayswapProtocolEvidenceVerifier;
  /** 宿主内部按引用取回（收据发射只接受本权威签发过的证据）。 */
  lookup(evidenceRef: string): PayswapProtocolSettlementEvidence | null;
}

export function createPayswapHostEvidenceAuthority(): PayswapHostEvidenceAuthority {
  const issued = new WeakSet<object>();
  const byRef = new Map<string, PayswapProtocolSettlementEvidence>();

  function issue(claim: PayswapHostEvidenceClaim): PayswapProtocolSettlementEvidence {
    // 签发即合形：畸形 claim 是宿主编程错误 —— 抛错，不落记录。
    const shape = hostEvidenceClaimSchema.safeParse(claim);
    if (!shape.success) {
      const first = shape.error.issues[0];
      throw new Error(
        `Payswap host evidence authority refused a malformed claim at '${first?.path.join(".") ?? "claim"}': ${
          first?.message ?? "schema error"
        }`,
      );
    }
    if (byRef.has(claim.evidenceRef)) {
      throw new Error(
        `Payswap host evidence ref '${claim.evidenceRef}' was already issued; evidence refs must be unique.`,
      );
    }
    const evidence: PayswapProtocolSettlementEvidence = Object.freeze({
      evidenceRef: claim.evidenceRef,
      evidenceDigest: claim.evidenceDigest,
      state: claim.state,
      capturedAt: claim.capturedAt,
      hostAttestationId: randomUUID(),
      protocolId: claim.protocolId,
      subjectRef: claim.subjectRef,
    });
    issued.add(evidence);
    byRef.set(evidence.evidenceRef, evidence);
    return evidence;
  }

  const verifier: PayswapProtocolEvidenceVerifier = {
    async verify(evidence): Promise<boolean> {
      if (typeof evidence !== "object" || evidence === null) return false;
      // 对象身份即签发记录：克隆 / 序列化往返 / 另一权威实例的对象都不在册。
      if (!issued.has(evidence)) return false;
      const record = byRef.get(evidence.evidenceRef);
      if (record === undefined || record !== evidence) return false;
      return (
        record.evidenceDigest === evidence.evidenceDigest &&
        record.state === evidence.state &&
        record.capturedAt === evidence.capturedAt &&
        record.hostAttestationId === evidence.hostAttestationId &&
        record.protocolId === evidence.protocolId &&
        record.subjectRef === evidence.subjectRef
      );
    },
  };

  return {
    issue,
    verifier,
    lookup(evidenceRef) {
      return byRef.get(evidenceRef) ?? null;
    },
  };
}
