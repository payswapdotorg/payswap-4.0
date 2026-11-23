/**
 * PaySwap P3-A —— 协议宿主边界（challenge 签发/消费 + 收据证据的唯一生产调用面）。
 *
 * 法则（normative）：
 * 1. **适配器只是不受信消息解释器**：本宿主是唯一调用 `translateInbound` /
 *    `emitReceipt` 的生产方；适配器不持有 challenge 注册表、证据权威或 provider
 *    凭据（类型面与装配面都不注入）。
 * 2. **challenge 关联在宿主裁决**：
 *    - MPP：凭据回显按规范绑定字段投影后，与宿主签发记录的摘要逐字比对；
 *      一个 challenge id 恰好消费一次（challengeRegistry 法则 3）。
 *    - x402：wire 上没有 challenge id —— 两个身份分开：选中的 requirements 必须
 *      命中宿主签发的 402（摘要绑定），付款授权身份（network + from + nonce）
 *      恰好消费一次（challengeRegistry 法则 4）。同一 requirements 的第二笔合法
 *      付款不是重放。
 *    - AP2：mandate / receipt 不是宿主签发的 challenge —— 进站只是不可信提案，
 *      本宿主不假装拥有其单次使用语义（AP2 的重放防线是 verifier 侧的
 *      transaction_id 唯一性，随 P6/P7 的 verifier 角色落地）。
 * 3. **宿主时钟是唯一时间源**：进站调用不接收时间参数 —— 过期裁决不可能被
 *    调用方供时影响。
 * 4. **消费 ≠ 认证**：消费成功的结局是 `challenge-consumed` 且
 *    `credential: "unverified"`。P3 不做密码学验签（shared CONTRACT「签名姿态」）
 *    —— 凭据真实性必须经网络 / facilitator 验证后才能履行；本结局没有任何
 *    「已验证 / 已结算」位可被下游读取。
 * 5. **收据只从宿主证据权威签发过的证据发出**：调用方只能给 `evidenceRef`，
 *    宿主按引用取回自己的签发记录再交给适配器；伪造引用 / 未签发证据 typed 拒绝。
 * 6. **重连不重置重放状态**：注册表是宿主实例状态，agent/适配器重连不重建它。
 */

import {
  evaluatePayswapX402RequirementSupport,
  payswapCanonicalDigest,
  type PayswapProtocolAdapter,
  type PayswapProtocolId,
  type PayswapProtocolInboundValidated,
  type PayswapProtocolReceiptOutcome,
  type PayswapProtocolRefusal,
} from "@zcode/shared/payswap";
import {
  createPayswapProtocolChallengeRegistry,
  type PayswapProtocolChallengeRecord,
  type PayswapProtocolChallengeRegistry,
  type PayswapX402RequirementsRecord,
} from "./challengeRegistry.js";
import type { PayswapHostEvidenceAuthority } from "./evidenceAuthority.js";

/** JS Date 的最大 epoch 毫秒 —— 上钳位（防畸形超大 validBefore 溢出成 Invalid Date）。 */
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface PayswapProtocolHostOptions {
  readonly adapters: readonly PayswapProtocolAdapter[];
  /** 可注入（测试 / 宿主单例）；缺省 = 新建。生命周期 = 宿主金融服务的进程生命周期。 */
  readonly challengeRegistry?: PayswapProtocolChallengeRegistry;
  /** 宿主证据权威（P7 账本/证据服务暴露给协议边界的签发/验证端口）。 */
  readonly evidenceAuthority: PayswapHostEvidenceAuthority;
  /** 宿主时钟（过期裁决的唯一时间源）；缺省 = 系统时钟。 */
  readonly clock?: () => Date;
}

export type PayswapProtocolHostInboundOutcome =
  | PayswapProtocolInboundValidated
  | {
      readonly kind: "challenge-consumed";
      readonly protocolId: PayswapProtocolId;
      readonly versionPin: string;
      readonly untrustedPayloadDigest: string;
      readonly challenge: {
        readonly challengeId: string;
        readonly expiresAt: string;
        readonly consumedAt: string;
      };
      /** 凭据真实性未验证 —— 消费 ≠ 认证：履行前必须经网络 / facilitator 验证。 */
      readonly credential: "unverified";
    }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

export interface PayswapProtocolHost {
  /** MPP challenge 签发（wire challenge 必须过 pinned schema 且携未过期的 RFC 3339 expires —— 宿主策略）。 */
  issueMppChallenge(input: { readonly wireChallenge: unknown }): Promise<PayswapProtocolChallengeRecord>;
  /**
   * x402 PaymentRequired 广告（每个 accepts 条目一条 requirements 记录；按摘要幂等
   * —— 重发刷新宿主有效期）。条目必须落在本面 supported subset 内 —— 宿主不得
   * 广告自己无法承兑的 requirements。
   */
  issueX402PaymentRequired(input: {
    readonly wirePaymentRequired: unknown;
  }): Promise<readonly PayswapX402RequirementsRecord[]>;
  /** 进站消息：结构验证 + challenge 关联/单次消费（宿主权威；宿主时钟）。 */
  handleInbound(input: {
    readonly protocolId: PayswapProtocolId;
    readonly message: unknown;
  }): Promise<PayswapProtocolHostInboundOutcome>;
  /** 出站收据：按宿主证据引用取回签发记录后交给适配器。 */
  emitReceipt(input: {
    readonly protocolId: PayswapProtocolId;
    readonly evidenceRef: string;
  }): Promise<PayswapProtocolReceiptOutcome>;
  /** 只读观测（运维/测试）。 */
  readonly challengeRegistry: PayswapProtocolChallengeRegistry;
}

function refusal(
  code: PayswapProtocolRefusal["code"],
  message: string,
): PayswapProtocolRefusal {
  return { code, message };
}

/**
 * MPP 绑定投影（规范绑定字段闭集）：id/realm/method/intent/request/expires/
 * digest/opaque/header。`description` 是展示字段（官方明示不得用于验证）
 * —— 不入绑定；未知参数客户端「MUST be ignored」—— 不入绑定。
 */
function projectMppBinding(challenge: unknown): Record<string, unknown> {
  if (typeof challenge !== "object" || challenge === null) {
    throw new Error("MPP challenge projection requires an object.");
  }
  const source = challenge as Record<string, unknown>;
  const binding: Record<string, unknown> = {
    id: source.id,
    realm: source.realm,
    method: source.method,
    intent: source.intent,
    request: source.request,
  };
  for (const optional of ["expires", "digest", "opaque", "header"] as const) {
    if (source[optional] !== undefined) binding[optional] = source[optional];
  }
  return binding;
}

/** 宿主签发面的结构验证：不过 pinned schema 的 challenge / 402 是装配/编程错误 → 抛错，不登记。 */
async function validatedIssue(
  adapter: PayswapProtocolAdapter,
  message: unknown,
  what: string,
): Promise<void> {
  const translated = await adapter.translateInbound(message);
  if (translated.kind === "refused") {
    throw new Error(
      `Payswap host refused to issue a structurally invalid ${what} (${translated.refusal.code}): ${translated.refusal.message}`,
    );
  }
}

export function createPayswapProtocolHost(
  options: PayswapProtocolHostOptions,
): PayswapProtocolHost {
  const adapters = new Map<PayswapProtocolId, PayswapProtocolAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.descriptor.protocolId)) {
      throw new Error(
        `Payswap protocol host received two adapters for '${adapter.descriptor.protocolId}'; exactly one adapter per protocol is allowed.`,
      );
    }
    adapters.set(adapter.descriptor.protocolId, adapter);
  }
  const challengeRegistry =
    options.challengeRegistry ?? createPayswapProtocolChallengeRegistry();
  const evidenceAuthority = options.evidenceAuthority;
  const clock = options.clock ?? (() => new Date());

  function requireAdapter(protocolId: PayswapProtocolId): PayswapProtocolAdapter {
    const adapter = adapters.get(protocolId);
    if (adapter === undefined) {
      throw new Error(`No Payswap protocol adapter is registered for '${protocolId}'.`);
    }
    return adapter;
  }

  function hostClock(): Date {
    const now = clock();
    if (Number.isNaN(now.getTime())) {
      throw new Error("Payswap protocol host received an invalid clock reading.");
    }
    return now;
  }

  function challengeConsumed(
    translated: PayswapProtocolInboundValidated,
    challengeId: string,
    expiresAt: string,
    now: Date,
  ): PayswapProtocolHostInboundOutcome {
    return {
      kind: "challenge-consumed",
      protocolId: translated.protocolId,
      versionPin: translated.versionPin,
      untrustedPayloadDigest: translated.untrustedPayloadDigest,
      challenge: { challengeId, expiresAt, consumedAt: now.toISOString() },
      credential: "unverified",
    };
  }

  return {
    challengeRegistry,

    async issueMppChallenge({ wireChallenge }) {
      const adapter = requireAdapter("mpp");
      await validatedIssue(adapter, { mppKind: "challenge", payload: wireChallenge }, "MPP challenge");
      const now = hostClock();
      if (typeof wireChallenge !== "object" || wireChallenge === null) {
        throw new Error("MPP challenge issue requires an object.");
      }
      const source = wireChallenge as Record<string, unknown>;
      // 宿主策略：签发的 challenge 必须携 expires 且签发时刻未过期（不签发一出生
      // 就过期的 challenge —— 客户端「MUST NOT submit credentials for expired
      // challenges」，服务端无从对无过期时间的 challenge 裁决过期）。
      if (typeof source.expires !== "string") {
        throw new Error(
          "Payswap host policy requires MPP challenges to carry a valid RFC 3339 expires value before issue.",
        );
      }
      const expiresMs = Date.parse(source.expires);
      if (Number.isNaN(expiresMs)) {
        throw new Error(
          "Payswap host policy requires MPP challenges to carry a valid RFC 3339 expires value before issue.",
        );
      }
      if (expiresMs <= now.getTime()) {
        throw new Error(
          `Payswap host refused to issue MPP challenge '${String(source.id)}': its expires (${source.expires}) is not after the host clock (${now.toISOString()}).`,
        );
      }
      const binding = projectMppBinding(wireChallenge);
      challengeRegistry.maybeSweep(now);
      return challengeRegistry.mpp.issue({
        challengeId: String(source.id),
        method: String(source.method),
        intent: String(source.intent),
        binding,
        bindingDigest: await payswapCanonicalDigest(binding),
        wireChallenge,
        issuedAt: now,
        expiresAt: new Date(expiresMs),
      });
    },

    async issueX402PaymentRequired({ wirePaymentRequired }) {
      const adapter = requireAdapter("x402");
      await validatedIssue(
        adapter,
        { x402Kind: "payment-required", payload: wirePaymentRequired },
        "x402 PaymentRequired",
      );
      const accepts = (wirePaymentRequired as { accepts: unknown[] }).accepts;
      const now = hostClock();
      challengeRegistry.maybeSweep(now);
      const records: PayswapX402RequirementsRecord[] = [];
      for (const entry of accepts) {
        // 宿主不得广告本面不支持的 requirements（广告了也无法承兑 —— 装配错误）。
        const support = evaluatePayswapX402RequirementSupport(entry);
        if (!support.supported) {
          throw new Error(
            `Payswap host refused to advertise x402 requirements outside the supported subset (${support.refusal}): ${support.detail}`,
          );
        }
        const requirementsDigest = await payswapCanonicalDigest(entry);
        records.push(
          challengeRegistry.x402.advertise({
            requirementsDigest,
            requirement: entry,
            maxTimeoutSeconds: (entry as { maxTimeoutSeconds: number }).maxTimeoutSeconds,
            wirePaymentRequired,
            now,
          }),
        );
      }
      return records;
    },

    async handleInbound({ protocolId, message }) {
      const adapter = adapters.get(protocolId);
      if (adapter === undefined) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_not_registered",
            `协议 '${protocolId}' 没有已注册的宿主适配器 —— fail-closed`,
          ),
        };
      }
      const translated = await adapter.translateInbound(message);
      if (translated.kind === "refused") {
        return translated;
      }
      const binding = translated.challengeBinding;
      if (binding === undefined) {
        // challenge / receipt / PaymentRequired / SettlementResponse / AP2 消息：无宿主 challenge 关联。
        return translated;
      }
      const now = hostClock();

      if (binding.kind === "mpp-challenge-echo") {
        if (protocolId !== "mpp") {
          return {
            kind: "refused",
            refusal: refusal(
              "protocol_challenge_mismatch",
              `协议 '${protocolId}' 的进站消息携带了 MPP challenge 绑定 —— 适配器契约违约，fail-closed`,
            ),
          };
        }
        let presentedBindingDigest: string;
        try {
          presentedBindingDigest = await payswapCanonicalDigest(projectMppBinding(binding.echoedChallenge));
        } catch {
          return {
            kind: "refused",
            refusal: refusal(
              "protocol_challenge_mismatch",
              "MPP 凭据的 challenge 回显不是可投影对象 —— 不采信（fail-closed）",
            ),
          };
        }
        const consumed = challengeRegistry.mpp.consume({
          challengeId: binding.challengeId,
          protocolId: "mpp",
          method: binding.method,
          intent: binding.intent,
          presentedBindingDigest,
          now,
        });
        if (consumed.kind === "refused") {
          return { kind: "refused", refusal: consumed.refusal };
        }
        return challengeConsumed(
          translated,
          consumed.record.challengeId,
          consumed.record.expiresAt,
          now,
        );
      }

      if (binding.kind === "x402-requirements-binding") {
        if (protocolId !== "x402") {
          return {
            kind: "refused",
            refusal: refusal(
              "protocol_challenge_mismatch",
              `协议 '${protocolId}' 的进站消息携带了 x402 requirements 绑定 —— 适配器契约违约，fail-closed`,
            ),
          };
        }
        // (1) 选中的 requirements 必须命中宿主签发的 402（摘要绑定 + 宿主有效期）。
        const matched = challengeRegistry.x402.match({
          requirementsDigest: binding.requirementsDigest,
          now,
        });
        if (matched.kind === "refused") {
          return { kind: "refused", refusal: matched.refusal };
        }
        // (2) 付款授权身份恰好消费一次 —— 记录保留至该授权自己的 validBefore。
        //     窗口本身是否仍在有效期内属于凭据验证（facilitator /verify），P3 宿主不执行。
        const validBeforeMs = Number(BigInt(binding.authorization.validBefore)) * 1000;
        const consumedCredential = challengeRegistry.x402.consumeCredential({
          credentialDigest: binding.credentialDigest,
          retainUntil: new Date(Math.min(Math.max(validBeforeMs, 0), MAX_DATE_MS)),
          now,
        });
        if (consumedCredential.kind === "refused") {
          return { kind: "refused", refusal: consumedCredential.refusal };
        }
        return challengeConsumed(
          translated,
          matched.record.challengeId,
          matched.record.expiresAt,
          now,
        );
      }

      // 不可达（绑定类型是闭集）—— 未知绑定形态 fail-closed，不模拟。
      return {
        kind: "refused",
        refusal: refusal(
          "protocol_challenge_mismatch",
          `协议 '${protocolId}' 的进站消息携带了未知形态的 challenge 绑定 —— fail-closed`,
        ),
      };
    },

    async emitReceipt({ protocolId, evidenceRef }) {
      const adapter = adapters.get(protocolId);
      if (adapter === undefined) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_not_registered",
            `协议 '${protocolId}' 没有已注册的宿主适配器 —— fail-closed`,
          ),
        };
      }
      // 只按引用取回本宿主签发的记录 —— 调用方永远给不出证据对象本身。
      const evidence = evidenceAuthority.lookup(evidenceRef);
      if (evidence === null) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_receipt_unavailable",
            `证据引用 '${evidenceRef}' 不是本宿主证据权威签发的记录 —— 协议 accepted ≠ 结算（fail-closed）`,
          ),
        };
      }
      return adapter.emitReceipt(evidence);
    },
  };
}
