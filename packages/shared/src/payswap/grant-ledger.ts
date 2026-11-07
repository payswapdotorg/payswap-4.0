/**
 * PaySwap grant ledger（addendum §1.3/§1.4 —— 单一写者、host 分配序列、单一铸造
 * 路径；enforcement seam = P7 executor 调用的授权检查；playbook P1.7）。
 *
 * 法则（normative）：
 * - **单一铸造路径**（§1.3）：grant 只能经 host 渲染授权卡 → host account service →
 *   ledger 这条路径铸造 —— ledger 的 `appendApprovedGrant` 只接受与**本 ledger 实例**
 *   配对的 minter 铸出的 mint（per-instance CSPRNG nonce；结构化品牌 + 运行时验证）。
 *   手工伪造、或另一 ledger 实例的 minter → `unauthorized_mint` 抛错，ledger 不动。
 *   任何工具调用/子代理/自动化/webhook/模型路径都不存在铸造 API（N8 的结构性臂）。
 * - **host 分配**：authorizationId 与 sequence 全部由 ledger 分配 —— 铸造命令里
 *   没有序列/ID 字段可供给（client-supplied 序列在结构上不可能）。
 * - **拒绝码族**（§7.4 的 `authorization_required`-family，两枚调用方可观察码 +
 *   审计 reason）：未呈现 authorizationId → `authorization_required`（N1/N3–N9：
 *   每个旁路上下文一律拒绝 —— 上下文只是审计注记，**永不改变裁决**）；呈现而不获
 *   授权（unknown/forged、expired、consumed、tuple 偏差）→ `authorization_mismatch`
 *   （N2/N10/N11/N12 —— 审计 reason 区分 grant_unknown/grant_expired/grant_consumed/
 *   tuple_deviation）。
 * - **单一用途**（N11）：`authorizeOperation` 通过即原子消耗（consumedAt +
 *   consumedByOperationId）；第二次尝试 → grant_consumed。恰好一次授权。
 * - 拒绝审计：每次拒绝记录 (at, code, reason, invocationContext, operationId) ——
 *   上下文被观察、被记录、但永不授权的证明通道。
 */

import { randomBytes, randomUUID } from "node:crypto";
import type {
  PayswapAuthorizationTuple,
  PayswapTupleBindingVerdict,
} from "./authorization-tuple.js";
import { evaluatePayswapTupleBinding, payswapTupleDigest } from "./authorization-tuple.js";

/** §1.4/§1.1 的旁路上下文全集（N1/N3–N7/N9 —— 它们只能沉默 Layer-1 提示）。 */
export const PAYSWAP_BYPASS_INVOCATION_CONTEXTS = [
  "yolo_session",
  "guarded_confirm",
  "session_allow_rule",
  "allowed_tools",
  "workflow_amend",
  "subagent_yolo_parent",
  "automation_run",
] as const;

/** 上下文全集（旁路 + 正常交互默认）—— 审计注记的封闭枚举。 */
export const PAYSWAP_INVOCATION_CONTEXTS = [
  ...PAYSWAP_BYPASS_INVOCATION_CONTEXTS,
  "interactive_default",
] as const;

export type PayswapInvocationContext = (typeof PAYSWAP_INVOCATION_CONTEXTS)[number];

/** 调用方可观察的拒绝码（§7.4 authorization_required-family）。 */
export type PayswapGrantRefusalCode = "authorization_required" | "authorization_mismatch";

/** 审计 reason（调用方不区分 —— 审计记录区分）。 */
export type PayswapGrantRefusalReason =
  | "no_grant"
  | "grant_unknown"
  | "grant_expired"
  | "grant_consumed"
  | "tuple_deviation";

export interface PayswapGrantRecord {
  authorizationId: string;
  /** host 分配的单调序列（铸造命令无法供给）。 */
  sequence: number;
  tuple: PayswapAuthorizationTuple;
  tupleDigest: string;
  /** 批准者 principal（server 侧解析 / host 验证 —— 永不由客户端声明）。 */
  principal: string;
  workspaceId: string;
  /** 批准用的角色（§1.6.3 item 9 的 (principal, workspace, role used) 三元组）。 */
  approvedRole?: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
  consumedByOperationId?: string;
}

export type PayswapAuthorizeOperationVerdict =
  | { status: "authorized"; authorizationId: string; sequence: number }
  | {
      status: "refused";
      code: PayswapGrantRefusalCode;
      reason: PayswapGrantRefusalReason;
      firstDeviation?: string;
    };

export interface PayswapGrantRefusalAuditEntry {
  at: number;
  code: PayswapGrantRefusalCode;
  reason: PayswapGrantRefusalReason;
  invocationContext: PayswapInvocationContext;
  operationId?: string;
  firstDeviation?: string;
}

/** 铸造命令的输入域（无 authorizationId/sequence —— 两者 host 分配）。 */
export interface PayswapApprovedGrantMintInput {
  tuple: PayswapAuthorizationTuple;
  tupleDigest: string;
  principal: string;
  workspaceId: string;
  approvedRole?: string;
  issuedAt: number;
}

/** per-instance 品牌键（模块私有符号 —— 运行时 nonce 验证的落点）。 */
const PAYSWAP_MINT_NONCE = Symbol("payswap.approvedGrantMint.nonce");

/** 已批准的铸造命令（只能由配对 minter 构造；appendApprovedGrant 验证 nonce）。 */
export interface PayswapApprovedGrantMint extends PayswapApprovedGrantMintInput {
  readonly [PAYSWAP_MINT_NONCE]: string;
}

export interface PayswapApprovedGrantMinter {
  /** 唯一铸造通道 —— 只交给 approval flow（§1.3 单一铸造路径纪律）。 */
  mintApprovedGrant(input: PayswapApprovedGrantMintInput): PayswapApprovedGrantMint;
}

export interface PayswapGrantLedger {
  /** 单一铸造入口（非配对 mint → unauthorized_mint 抛错，ledger 不动）。 */
  appendApprovedGrant(mint: PayswapApprovedGrantMint): PayswapGrantRecord;
  /**
   * enforcement seam（P7 executor 调用）：呈现操作对绑定 tuple 的授权检查。
   * invocationContext 只是审计注记 —— 裁决永不变（N1–N9 的核心）。
   */
  authorizeOperation(input: {
    authorizationId?: string;
    presentedTuple: PayswapAuthorizationTuple;
    invocationContext: PayswapInvocationContext;
    operationId?: string;
  }): PayswapAuthorizeOperationVerdict;
  records(): readonly PayswapGrantRecord[];
  refusalAudit(): readonly PayswapGrantRefusalAuditEntry[];
}

export interface PayswapGrantLedgerHandle {
  ledger: PayswapGrantLedger;
  /** 唯一铸造通道 —— 只交给 approval flow。 */
  minter: PayswapApprovedGrantMinter;
}

export const PAYSWAP_UNAUTHORIZED_MINT_CODE = "unauthorized_mint";

export function createPayswapGrantLedger(options: { now?: () => number } = {}): PayswapGrantLedgerHandle {
  const now = options.now ?? Date.now;
  const instanceNonce = randomBytes(32).toString("hex");
  const grants: PayswapGrantRecord[] = [];
  const audit: PayswapGrantRefusalAuditEntry[] = [];
  let nextSequence = 1;

  const minter: PayswapApprovedGrantMinter = {
    mintApprovedGrant(input) {
      return { ...input, [PAYSWAP_MINT_NONCE]: instanceNonce } as PayswapApprovedGrantMint;
    },
  };

  function refuse(
    code: PayswapGrantRefusalCode,
    reason: PayswapGrantRefusalReason,
    invocationContext: PayswapInvocationContext,
    operationId: string | undefined,
    at: number,
    firstDeviation?: string,
  ): PayswapAuthorizeOperationVerdict {
    audit.push({
      at,
      code,
      reason,
      invocationContext,
      ...(operationId !== undefined ? { operationId } : {}),
      ...(firstDeviation !== undefined ? { firstDeviation } : {}),
    });
    return {
      status: "refused",
      code,
      reason,
      ...(firstDeviation !== undefined ? { firstDeviation } : {}),
    };
  }

  const ledger: PayswapGrantLedger = {
    appendApprovedGrant(mint) {
      const carried = (mint as { [PAYSWAP_MINT_NONCE]?: unknown })[PAYSWAP_MINT_NONCE];
      if (typeof carried !== "string" || carried !== instanceNonce) {
        throw new Error(PAYSWAP_UNAUTHORIZED_MINT_CODE);
      }
      // digest 由 ledger 独立重算（不信任铸造命令携带的 digest 输入侧）—— 铸造命令的
      // digest 与重算不一致 = 流程内漂移，fail-closed 拒绝铸造。
      const recomputed = payswapTupleDigest(mint.tuple);
      if (recomputed !== mint.tupleDigest) {
        throw new Error(PAYSWAP_UNAUTHORIZED_MINT_CODE);
      }
      const record: PayswapGrantRecord = {
        authorizationId: randomUUID(),
        sequence: nextSequence,
        tuple: mint.tuple,
        tupleDigest: recomputed,
        principal: mint.principal,
        workspaceId: mint.workspaceId,
        ...(mint.approvedRole !== undefined ? { approvedRole: mint.approvedRole } : {}),
        issuedAt: mint.issuedAt,
        expiresAt: mint.tuple.expiresAt,
      };
      nextSequence += 1;
      grants.push(record);
      return record;
    },

    authorizeOperation({ authorizationId, presentedTuple, invocationContext, operationId }) {
      const at = now();
      if (authorizationId === undefined || authorizationId.length === 0) {
        return refuse("authorization_required", "no_grant", invocationContext, operationId, at);
      }
      const record = grants.find((grant) => grant.authorizationId === authorizationId);
      if (!record) {
        return refuse("authorization_mismatch", "grant_unknown", invocationContext, operationId, at);
      }
      if (at >= record.expiresAt) {
        return refuse("authorization_mismatch", "grant_expired", invocationContext, operationId, at);
      }
      if (record.consumedAt !== undefined) {
        return refuse(
          "authorization_mismatch",
          "grant_consumed",
          invocationContext,
          operationId,
          at,
        );
      }
      const binding: PayswapTupleBindingVerdict = evaluatePayswapTupleBinding(
        record.tuple,
        presentedTuple,
      );
      if (binding.status === "mismatch") {
        return refuse(
          "authorization_mismatch",
          "tuple_deviation",
          invocationContext,
          operationId,
          at,
          binding.firstDeviation,
        );
      }
      // 全部通过 → 原子消耗（N11：恰好一次授权）。
      record.consumedAt = at;
      if (operationId !== undefined) {
        record.consumedByOperationId = operationId;
      }
      return { status: "authorized", authorizationId: record.authorizationId, sequence: record.sequence };
    },

    records() {
      return grants;
    },

    refusalAudit() {
      return audit;
    },
  };

  return { ledger, minter };
}
