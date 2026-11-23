/**
 * PaySwap P3-A —— 宿主 challenge 注册表（MPP challenge 绑定 / 过期 / 原子单次使用
 * + x402 requirements 广告与付款授权单次使用）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **权威所有权在宿主**：本注册表只由宿主服务实例化；适配器、agent、模型与
 *    插件都拿不到它。适配器对 challenge 的任何说法都是不受信声明，必须与本
 *    注册表的记录比对后才可采信。
 * 2. **生命周期 = 宿主金融服务的进程生命周期**（addendum §3.5(7) 同款纪律：
 *    dedupe scope 是实例，不是连接）—— 适配器/agent 重连不重建本实例；宿主
 *    进程重启 = 全部记录丢失 = 一切旧 challenge 答 unknown（fail-closed，不
 *    恢复半截状态）。全内存、无 IO、无持久化 —— 它不是账本，不记录任何资金
 *    事实（「one ledger」不受影响）。
 * 3. **MPP：一个 challenge id 恰好消费一次**。签发时记录绑定投影的 canonical
 *    摘要；消费时由宿主重算回显投影的摘要逐字比对。裁决次序：unknown →
 *    method/intent 错配 → 绑定错配 → consumed → expired → 消费。
 *    - 过期裁决用**宿主时钟**（调用方不能供时）；过期不消费记录。
 *    - 「已消费」排在「已过期」之前：被消费的 challenge 其后过期时，重放仍答
 *      consumed —— 重放事实不被过期掩盖。
 * 4. **x402：两个身份分开**（core §10.1：重放防线是付款人 nonce，不是
 *    requirements）：
 *    - `advertise`：宿主签发的 402 的每个 accepts 条目一条 requirements 记录，
 *      按摘要**幂等**（重发刷新有效期）—— 同一 requirements 可被多次合法付款；
 *      有效期 = 广告时刻 + 该条目的 maxTimeoutSeconds（**宿主策略**：spec 对
 *      stale-402 服务端行为沉默 —— 注册表 unsupportedCapabilities Row 5）。
 *    - `consumeCredential`：付款授权身份（network + from + nonce）**恰好消费
 *      一次**，记录保留至该授权的 `validBefore`（或保留上限 —— 见常量）。
 * 5. **原子 check-and-set**：检查与置位之间没有 await（Node 单线程同步段）
 *    —— 并发重复提交恰有一个成功。摘要由宿主经 shared 的单一实现
 *    （`payswapCanonicalDigest`）计算后传入；本模块不自带第二份摘要实现。
 */

import type { PayswapProtocolId, PayswapProtocolRefusal } from "@zcode/shared/payswap";

/** JS Date 的最大 epoch 毫秒 —— 上钳位（防畸形超大秒数溢出成 Invalid Date）。 */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * 摊还清理：规模达到阈值才全量扫，阈值随清理后的规模增长 —— 每次 issue/
 * advertise 摊还 O(1)，长期运行的宿主不会退化成每次 O(n)。
 */
const MIN_SWEEP_THRESHOLD = 64;

/**
 * 已消费 x402 付款授权的保留上限（按消费时刻保留最近的 N 条）。每个不同的
 * (network, from, nonce) 各占一条；不设上限则可用「远期 validBefore + 海量
 * nonce」把宿主内存撑满。被淘汰的旧授权在链上已是 used nonce（EIP-3009 的
 * authorizationState 是协议自身的重放防线）—— 本注册表是宿主侧的第一道防线，
 * 不是唯一的一道。
 */
export const PAYSWAP_X402_CONSUMED_CREDENTIAL_RETENTION_MAX = 10_000;

export interface PayswapProtocolChallengeRecord {
  readonly challengeId: string;
  readonly protocolId: PayswapProtocolId;
  readonly method: string;
  readonly intent: string;
  /** 绑定投影（规范绑定字段的 plain object；不可变快照）。 */
  readonly binding: Readonly<Record<string, unknown>>;
  /** canonical(binding) 的摘要（base64url-nopad；宿主经 shared 单一实现计算）。 */
  readonly bindingDigest: string;
  /** 宿主实际发出的 wire challenge（逐字，供审计/重放取证）。 */
  readonly wireChallenge: unknown;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: "issued" | "consumed";
  readonly consumedAt?: string;
}

export interface PayswapMppChallengeIssueInput {
  readonly challengeId: string;
  readonly method: string;
  readonly intent: string;
  readonly binding: Readonly<Record<string, unknown>>;
  readonly bindingDigest: string;
  readonly wireChallenge: unknown;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface PayswapMppChallengeConsumeInput {
  readonly challengeId: string;
  readonly protocolId: PayswapProtocolId;
  readonly method: string;
  readonly intent: string;
  /** 宿主对回显 challenge 重算的绑定投影摘要（不受信输入的派生值）。 */
  readonly presentedBindingDigest: string;
  readonly now: Date;
}

export type PayswapChallengeConsumeOutcome =
  | { readonly kind: "consumed"; readonly record: PayswapProtocolChallengeRecord }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

export interface PayswapMppChallengeRegistryFace {
  issue(input: PayswapMppChallengeIssueInput): PayswapProtocolChallengeRecord;
  consume(input: PayswapMppChallengeConsumeInput): PayswapChallengeConsumeOutcome;
}

/** x402：宿主签发的 402 中的一个 PaymentRequirements 条目。 */
export interface PayswapX402RequirementsRecord {
  /** `x402:<requirementsDigest>` —— 摘要即身份（x402 的 wire 上没有 challenge id）。 */
  readonly challengeId: string;
  readonly protocolId: "x402";
  readonly requirementsDigest: string;
  /** 已广告的 requirements（逐字，不可变快照）。 */
  readonly requirement: unknown;
  readonly advertisedAt: string;
  readonly expiresAt: string;
}

export interface PayswapX402AdvertiseInput {
  readonly requirementsDigest: string;
  readonly requirement: unknown;
  readonly maxTimeoutSeconds: number;
  readonly wirePaymentRequired: unknown;
  readonly now: Date;
}

export type PayswapX402RequirementsMatch =
  | { readonly kind: "matched"; readonly record: PayswapX402RequirementsRecord }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

export type PayswapX402CredentialConsume =
  | { readonly kind: "consumed"; readonly consumedAt: string; readonly retainUntil: string }
  | { readonly kind: "refused"; readonly refusal: PayswapProtocolRefusal };

export interface PayswapX402PaymentRegistryFace {
  advertise(input: PayswapX402AdvertiseInput): PayswapX402RequirementsRecord;
  match(input: { readonly requirementsDigest: string; readonly now: Date }): PayswapX402RequirementsMatch;
  consumeCredential(input: {
    readonly credentialDigest: string;
    readonly retainUntil: Date;
    readonly now: Date;
  }): PayswapX402CredentialConsume;
}

export interface PayswapProtocolChallengeRegistry {
  readonly mpp: PayswapMppChallengeRegistryFace;
  readonly x402: PayswapX402PaymentRegistryFace;
  /** 清理全部过期记录，返回清理数。 */
  sweep(now: Date): number;
  /** 摊还清理（规模达到阈值才扫）。签发路径每次调用。 */
  maybeSweep(now: Date): number;
  /** 只读观测（测试/运维；不暴露给适配器）。 */
  readonly size: number;
}

function refusal(
  code: PayswapProtocolRefusal["code"],
  message: string,
): PayswapProtocolRefusal {
  return { code, message };
}

function epochMs(date: Date, label: string): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Payswap challenge registry received an invalid ${label} timestamp.`);
  }
  return ms;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clampMs(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_DATE_MS);
}

/**
 * 创建宿主 challenge 注册表（法则 1-5）。无 IO、无持久化副作用 —— 生命周期与
 * 宿主进程一致；重连不重建本实例（宿主所有权）。
 */
export function createPayswapProtocolChallengeRegistry(): PayswapProtocolChallengeRegistry {
  const mppById = new Map<string, PayswapProtocolChallengeRecord>();
  const x402Requirements = new Map<string, PayswapX402RequirementsRecord>();
  const x402ConsumedCredentials = new Map<
    string,
    { readonly consumedAt: string; readonly retainUntilMs: number }
  >();
  let sweepThreshold = MIN_SWEEP_THRESHOLD;

  const total = () => mppById.size + x402Requirements.size + x402ConsumedCredentials.size;

  function sweep(now: Date): number {
    const nowMs = epochMs(now, "sweep");
    let removed = 0;
    for (const [id, record] of mppById) {
      if (Date.parse(record.expiresAt) <= nowMs) {
        mppById.delete(id);
        removed += 1;
      }
    }
    for (const [digest, record] of x402Requirements) {
      if (Date.parse(record.expiresAt) <= nowMs) {
        x402Requirements.delete(digest);
        removed += 1;
      }
    }
    for (const [digest, consumed] of x402ConsumedCredentials) {
      if (consumed.retainUntilMs <= nowMs) {
        x402ConsumedCredentials.delete(digest);
        removed += 1;
      }
    }
    return removed;
  }

  const mpp: PayswapMppChallengeRegistryFace = {
    issue(input) {
      if (input.challengeId.length === 0) {
        throw new Error("Payswap challenge registry requires a non-empty challenge id.");
      }
      if (mppById.has(input.challengeId)) {
        throw new Error(
          `Payswap challenge id '${input.challengeId}' was already issued; challenge ids must be unique per host while live.`,
        );
      }
      const issuedAtMs = epochMs(input.issuedAt, "issuedAt");
      const expiresAtMs = epochMs(input.expiresAt, "expiresAt");
      if (expiresAtMs <= issuedAtMs) {
        throw new Error(
          `Payswap challenge '${input.challengeId}' expiresAt (${input.expiresAt.toISOString()}) must be after now (${input.issuedAt.toISOString()}).`,
        );
      }
      const record: PayswapProtocolChallengeRecord = Object.freeze({
        challengeId: input.challengeId,
        protocolId: "mpp",
        method: input.method,
        intent: input.intent,
        binding: Object.freeze({ ...input.binding }),
        bindingDigest: input.bindingDigest,
        wireChallenge: input.wireChallenge,
        issuedAt: iso(issuedAtMs),
        expiresAt: iso(expiresAtMs),
        state: "issued" as const,
      });
      mppById.set(record.challengeId, record);
      return record;
    },

    consume(input) {
      const record = mppById.get(input.challengeId);
      if (record === undefined) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_unknown",
            `challenge '${input.challengeId}' 从未由本宿主签发（未知 / 已清理 / 宿主已重启）—— fail-closed`,
          ),
        };
      }
      if (
        record.protocolId !== input.protocolId ||
        record.method !== input.method ||
        record.intent !== input.intent
      ) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_mismatch",
            `challenge '${input.challengeId}' 的协议/方法/intent 与签发记录不一致（签发 ${record.protocolId}/${record.method}/${record.intent}，回显 ${input.protocolId}/${input.method}/${input.intent}）`,
          ),
        };
      }
      if (input.presentedBindingDigest !== record.bindingDigest) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_mismatch",
            `challenge '${input.challengeId}' 的回显绑定与签发记录不一致（id/realm/method/intent/request/expires/digest/opaque/header 任一被改动）`,
          ),
        };
      }
      // 「已消费」先于「已过期」：被消费的 challenge 其后过期时，重放仍答 consumed。
      if (record.state === "consumed") {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_consumed",
            `challenge '${input.challengeId}' 已于 ${record.consumedAt} 被消费（原子单次使用；并发重复与重连后重放均拒绝）`,
          ),
        };
      }
      const nowMs = epochMs(input.now, "now");
      if (nowMs >= Date.parse(record.expiresAt)) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_expired",
            `challenge '${input.challengeId}' 已于 ${record.expiresAt} 过期（宿主时钟 ${iso(nowMs)}）—— 拒绝且不消费`,
          ),
        };
      }
      // 原子 check-and-set：本段无 await（Node 单线程同步段）。
      const consumed: PayswapProtocolChallengeRecord = Object.freeze({
        ...record,
        state: "consumed" as const,
        consumedAt: iso(nowMs),
      });
      mppById.set(record.challengeId, consumed);
      return { kind: "consumed", record: consumed };
    },
  };

  const x402: PayswapX402PaymentRegistryFace = {
    advertise(input) {
      if (input.requirementsDigest.length === 0) {
        throw new Error("Payswap x402 requirements registry requires a non-empty requirements digest.");
      }
      if (!Number.isFinite(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 0) {
        throw new Error(
          `Payswap x402 requirements registry requires a positive maxTimeoutSeconds (got ${String(input.maxTimeoutSeconds)}).`,
        );
      }
      const advertisedAtMs = epochMs(input.now, "now");
      const record: PayswapX402RequirementsRecord = Object.freeze({
        challengeId: `x402:${input.requirementsDigest}`,
        protocolId: "x402",
        requirementsDigest: input.requirementsDigest,
        requirement: input.requirement,
        advertisedAt: iso(advertisedAtMs),
        expiresAt: iso(clampMs(advertisedAtMs + input.maxTimeoutSeconds * 1000)),
      });
      // 幂等：同一 requirements 重发 = 刷新有效期（同一资源可被多次合法付款）。
      x402Requirements.set(input.requirementsDigest, record);
      return record;
    },

    match(input) {
      const record = x402Requirements.get(input.requirementsDigest);
      if (record === undefined) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_unknown",
            "x402 付款载荷选中的 requirements 从未由本宿主广告（未知 / 已过期清理 / 宿主已重启）—— fail-closed",
          ),
        };
      }
      const nowMs = epochMs(input.now, "now");
      if (nowMs >= Date.parse(record.expiresAt)) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_expired",
            `x402 requirements '${record.challengeId}' 的宿主有效期已于 ${record.expiresAt} 结束（宿主时钟 ${iso(nowMs)}）—— 需要新的 402`,
          ),
        };
      }
      return { kind: "matched", record };
    },

    consumeCredential(input) {
      if (x402ConsumedCredentials.has(input.credentialDigest)) {
        return {
          kind: "refused",
          refusal: refusal(
            "protocol_challenge_consumed",
            "该 x402 付款授权（network + from + nonce）已被消费（原子单次使用；换签名字节重放同样拒绝）",
          ),
        };
      }
      const nowMs = epochMs(input.now, "now");
      const retainUntilMs = Math.max(clampMs(epochMs(input.retainUntil, "retainUntil")), nowMs);
      // 原子 check-and-set：本段无 await。
      x402ConsumedCredentials.set(input.credentialDigest, {
        consumedAt: iso(nowMs),
        retainUntilMs,
      });
      // 保留上限：只保留最近的 N 条（Map 保持插入序 —— 最旧者先淘汰）。
      while (x402ConsumedCredentials.size > PAYSWAP_X402_CONSUMED_CREDENTIAL_RETENTION_MAX) {
        const oldest = x402ConsumedCredentials.keys().next();
        if (oldest.done) break;
        x402ConsumedCredentials.delete(oldest.value);
      }
      return { kind: "consumed", consumedAt: iso(nowMs), retainUntil: iso(retainUntilMs) };
    },
  };

  return {
    mpp,
    x402,
    sweep,
    maybeSweep(now) {
      if (total() < sweepThreshold) return 0;
      const removed = sweep(now);
      sweepThreshold = Math.max(MIN_SWEEP_THRESHOLD, 2 * total());
      return removed;
    },
    get size() {
      return total();
    },
  };
}
