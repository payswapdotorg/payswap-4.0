/**
 * PaySwap operator 注册表（addendum §1.6.3 items 1/2/5/6/8/9 —— 状态owner）。
 *
 * 纪律（normative）：
 * - item 1/8：digest-only 存储 —— 记录里只有 sha256(token)，keyed lookup + 常时比较；
 *   明文只在 provision/rotate 一次性返回。rotation 有限 grace（默认 24h）：窗口内
 *   新旧皆有效、旧凭据 verdict 带 `rotating:true` 审计标记；窗口后旧凭据 rotated_out。
 * - item 2：principal = stable server-assigned operatorId；凭据（含轮换后的新凭据）
 *   反复验证解析到同一 principal。
 * - item 6：revocation 立即且 **principal 域**（"the principal's active sessions"）——
 *   撤销一条凭据即撤销该 operator 全部 sessions 并失效其 pending challenges；
 *   rotation 窗口结束的收尾是 **record 域**（"sessions it authenticated"），由
 *   sweepRotationWindows 以惰性 + 主动扫的方式执行。
 * - item 6：session 有界生命周期（默认 15min）；session 存活 = 未过期 ∧ 未撤销 ∧
 *   铸造它的凭据仍有效（惰性凭据法则 —— 窗口结束的 session 在下一次验证处死亡，
 *   不依赖定时器）。
 * - item 3/6：challenge 一次性、绑定 (签发 session, 签发 principal, purpose)；解析
 *   顺序：challenge 状态 → session 存活 → principal 匹配 → secret 匹配 → 消耗。
 *   他人 principal 解析 = principal_mismatch（N29），challenge 不消耗。
 * - item 5/9：角色是 (operator, ledger) 绑定 —— resolveRoles/authorizeAction 按目标
 *   workspace 评估，永无全局继承（N31/N41）。
 *
 * 状态形态：host 进程私有；operator/凭据/角色绑定可经 serializeState 持久化
 * （digest-only）；sessions 与 challenges 是内存态（重启即失效 —— 正是期望语义）。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mintPayswapOperatorCredential,
  parsePayswapOperatorCredential,
  verifyPayswapOperatorCredentialDigests,
} from "./operator-credentials.js";

export type PayswapOperatorRole = "proposer" | "approver" | "auditor" | "viewer";

export const PAYSWAP_OPERATOR_ROLES: readonly PayswapOperatorRole[] = [
  "proposer",
  "approver",
  "auditor",
  "viewer",
] as const;

/** P1.6 的封闭动作表（P1.7 的 approval 流将复用 approve 门）。 */
export type PayswapOperatorAction = "approve";

export const PAYSWAP_OPERATOR_ACTION_REQUIRED_ROLE: Readonly<
  Record<PayswapOperatorAction, PayswapOperatorRole>
> = {
  approve: "approver",
} as const;

export interface PayswapProvisionOperatorInput {
  name?: string;
  /** (ledgerId, roles) 绑定列表；重复 ledgerId 以先到为准（append-only 纪律）。 */
  roleBindings: ReadonlyArray<{ ledgerId: string; roles: readonly PayswapOperatorRole[] }>;
}

export interface PayswapProvisionedOperator {
  operatorId: string;
  recordId: string;
  /** 明文 —— 恰在此一次性返回。 */
  token: string;
}

export interface PayswapRotatedCredential {
  recordId: string;
  token: string;
  graceEndAt: number;
}

export type PayswapCredentialVerdict =
  | { status: "valid"; operatorId: string; recordId: string; rotating: boolean }
  | { status: "unknown" }
  | { status: "revoked" }
  | { status: "rotated_out" };

export interface PayswapOperatorSessionMint {
  sessionId: string;
  operatorId: string;
  expiresAt: number;
}

export type PayswapSessionVerdict =
  | { status: "live"; operatorId: string }
  | { status: "unknown" }
  | { status: "expired" }
  | { status: "revoked" }
  | { status: "credential_invalid" };

export interface PayswapRevocationResult {
  closedSessions: string[];
  invalidatedChallenges: string[];
}

export interface PayswapChallengeIssueInput {
  sessionId: string;
  purpose: string;
  expiresAt: number;
}

export interface PayswapIssuedChallenge {
  challengeId: string;
  /** 明文 secret —— 只发给签发侧（host↔trusted 层）；注册表内存态保存。 */
  secret: string;
}

export interface PayswapChallengeResolutionInput {
  challengeId: string;
  secret: string;
  sessionId: string;
}

export type PayswapChallengeResolutionVerdict =
  | { status: "resolved" }
  | { status: "challenge_unknown" }
  | { status: "challenge_consumed" }
  | { status: "challenge_expired" }
  | { status: "challenge_invalidated" }
  | { status: "secret_mismatch" }
  | { status: "session_invalid" }
  | { status: "principal_mismatch" };

export interface PayswapOperatorRegistryOptions {
  now?: () => number;
  /** operator session 有界生命周期（默认 15min —— §1.6.3 item 7 cookie 纪律）。 */
  sessionLifetimeMs?: number;
  /** rotation grace 窗口（默认 24h）。 */
  rotationGraceMs?: number;
  /** 持久化快照恢复（serializeState 的输出）；损坏 → 抛错（fail-closed 由调用方处理）。 */
  initialStateJson?: string;
}

export interface PayswapOperatorRegistry {
  provisionOperator(input: PayswapProvisionOperatorInput): PayswapProvisionedOperator;
  rotateOperatorCredential(operatorId: string): PayswapRotatedCredential;
  revokeOperatorCredential(recordId: string): PayswapRevocationResult;
  revokeOperator(operatorId: string): PayswapRevocationResult;
  verifyCredential(token: string): PayswapCredentialVerdict;
  mintSessionForCredential(token: string): PayswapOperatorSessionMint | null;
  verifySession(sessionId: string): PayswapSessionVerdict;
  /** 内省（server 侧连接绑定/测试）：session 记录及其存活态（不含 secret 类材料）。 */
  listSessions(): ReadonlyArray<{ sessionId: string; operatorId: string; live: boolean }>;
  /** rotation 窗口收尾（record 域）：关闭过窗 record 铸的 sessions、失效其 challenges。 */
  sweepRotationWindows(): PayswapRevocationResult;
  resolveRoles(operatorId: string, ledgerId: string): readonly PayswapOperatorRole[];
  authorizeAction(input: {
    operatorId: string;
    ledgerId: string;
    action: PayswapOperatorAction;
  }): { status: "authorized"; role: PayswapOperatorRole } | { status: "unknown_operator" } | { status: "role_required" };
  issueChallenge(input: PayswapChallengeIssueInput): PayswapIssuedChallenge | null;
  resolveChallenge(input: PayswapChallengeResolutionInput): PayswapChallengeResolutionVerdict;
  /** 持久化快照（digest-only；不含 sessions/challenges 明文与 secret）。 */
  serializeState(): string;
}

const DEFAULT_SESSION_LIFETIME_MS = 15 * 60_000;
const DEFAULT_ROTATION_GRACE_MS = 24 * 3_600_000;

type CredentialState = "current" | "rotating" | "revoked";

interface CredentialRecord {
  recordId: string;
  digest: string;
  state: CredentialState;
  rotatingSince: number;
  graceEndAt: number;
}

interface OperatorRecord {
  operatorId: string;
  name?: string;
  /** ledgerId → roles（(operator, workspace) 绑定 —— item 9）。 */
  roleBindings: Map<string, PayswapOperatorRole[]>;
  /** append-only 记录链；至多一条 state==="current"。 */
  credentials: CredentialRecord[];
}

interface SessionRecord {
  sessionId: string;
  operatorId: string;
  credentialRecordId: string;
  expiresAt: number;
  revoked: boolean;
}

interface ChallengeRecord {
  challengeId: string;
  secret: string;
  operatorId: string;
  sessionId: string;
  purpose: string;
  expiresAt: number;
  consumed: boolean;
  invalidated: boolean;
}

interface SerializedCredential {
  recordId: string;
  digest: string;
  state: CredentialState;
  rotatingSince: number;
  graceEndAt: number;
}

interface SerializedOperator {
  operatorId: string;
  name?: string;
  roleBindings: Record<string, PayswapOperatorRole[]>;
  credentials: SerializedCredential[];
}

interface SerializedState {
  operators: SerializedOperator[];
}

function randomId(prefix: string, bytes = 12): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

/** secret 的常时比较（hex 等长形态由本模块铸造保证；长度不等直接 false）。 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function toSerializedState(state: SerializedState): string {
  return JSON.stringify(state);
}

export function createPayswapOperatorRegistry(
  options: PayswapOperatorRegistryOptions = {},
): PayswapOperatorRegistry {
  const now = options.now ?? Date.now;
  const sessionLifetimeMs = options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
  const rotationGraceMs = options.rotationGraceMs ?? DEFAULT_ROTATION_GRACE_MS;

  const operators = new Map<string, OperatorRecord>();
  /** digest → recordId（keyed lookup；digest 不可变）。 */
  const digestIndex = new Map<string, { operatorId: string; recordId: string }>();
  const sessions = new Map<string, SessionRecord>();
  const challenges = new Map<string, ChallengeRecord>();

  if (options.initialStateJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.initialStateJson) as unknown;
    } catch (error) {
      throw new Error("payswap_operator_registry_corrupt", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || !("operators" in parsed)) {
      throw new Error("payswap_operator_registry_corrupt");
    }
    const state = parsed as SerializedState;
    if (!Array.isArray(state.operators)) {
      throw new Error("payswap_operator_registry_corrupt");
    }
    for (const serialized of state.operators) {
      const record: OperatorRecord = {
        operatorId: serialized.operatorId,
        ...(serialized.name !== undefined ? { name: serialized.name } : {}),
        roleBindings: new Map(Object.entries(serialized.roleBindings ?? {})),
        credentials: (serialized.credentials ?? []).map((credential) => ({
          recordId: credential.recordId,
          digest: credential.digest,
          state: credential.state,
          rotatingSince: credential.rotatingSince,
          graceEndAt: credential.graceEndAt,
        })),
      };
      operators.set(record.operatorId, record);
      for (const credential of record.credentials) {
        digestIndex.set(credential.digest, {
          operatorId: record.operatorId,
          recordId: credential.recordId,
        });
      }
    }
  }

  function findCredentialRecord(
    recordId: string,
  ): { operator: OperatorRecord; record: CredentialRecord } | undefined {
    for (const operator of operators.values()) {
      const record = operator.credentials.find((entry) => entry.recordId === recordId);
      if (record) return { operator, record };
    }
    return undefined;
  }

  function credentialVerdict(record: CredentialRecord, operatorId: string): PayswapCredentialVerdict {
    if (record.state === "revoked") return { status: "revoked" };
    if (record.state === "rotating") {
      if (now() < record.graceEndAt) {
        return { status: "valid", operatorId, recordId: record.recordId, rotating: true };
      }
      return { status: "rotated_out" };
    }
    return { status: "valid", operatorId, recordId: record.recordId, rotating: false };
  }

  /** 级联（principal 域）：撤销 operator 全部 sessions + 失效其 challenges。 */
  function revokeSessionsOfOperator(
    operatorId: string,
    onlySessionIds?: ReadonlySet<string>,
  ): PayswapRevocationResult {
    const closedSessions: string[] = [];
    const invalidatedChallenges: string[] = [];
    for (const session of sessions.values()) {
      if (session.operatorId !== operatorId) continue;
      if (onlySessionIds && !onlySessionIds.has(session.sessionId)) continue;
      if (!session.revoked) {
        session.revoked = true;
        closedSessions.push(session.sessionId);
      }
      for (const challenge of challenges.values()) {
        if (challenge.sessionId !== session.sessionId) continue;
        if (!challenge.invalidated && !challenge.consumed) {
          challenge.invalidated = true;
          invalidatedChallenges.push(challenge.challengeId);
        }
      }
    }
    return { closedSessions, invalidatedChallenges };
  }

  const registry: PayswapOperatorRegistry = {
    provisionOperator(input) {
      const operatorId = randomId("op_", 16);
      const roleBindings = new Map<string, PayswapOperatorRole[]>();
      for (const binding of input.roleBindings) {
        if (!roleBindings.has(binding.ledgerId)) {
          roleBindings.set(binding.ledgerId, [...binding.roles]);
        }
      }
      const minted = mintPayswapOperatorCredential();
      const record: CredentialRecord = {
        recordId: randomId("psorec_", 12),
        digest: minted.digest,
        state: "current",
        rotatingSince: 0,
        graceEndAt: 0,
      };
      const operator: OperatorRecord = {
        operatorId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        roleBindings,
        credentials: [record],
      };
      operators.set(operatorId, operator);
      digestIndex.set(minted.digest, { operatorId, recordId: record.recordId });
      return { operatorId, recordId: record.recordId, token: minted.token };
    },

    rotateOperatorCredential(operatorId) {
      const operator = operators.get(operatorId);
      if (!operator) {
        throw new Error(`payswap_unknown_operator:${operatorId}`);
      }
      const timestamp = now();
      // 既有 current → rotating（grace 从此刻起）。
      for (const record of operator.credentials) {
        if (record.state === "current") {
          record.state = "rotating";
          record.rotatingSince = timestamp;
          record.graceEndAt = timestamp + rotationGraceMs;
        }
      }
      const minted = mintPayswapOperatorCredential();
      const record: CredentialRecord = {
        recordId: randomId("psorec_", 12),
        digest: minted.digest,
        state: "current",
        rotatingSince: 0,
        graceEndAt: 0,
      };
      operator.credentials.push(record);
      digestIndex.set(minted.digest, { operatorId, recordId: record.recordId });
      return {
        recordId: record.recordId,
        token: minted.token,
        graceEndAt: timestamp + rotationGraceMs,
      };
    },

    revokeOperatorCredential(recordId) {
      const found = findCredentialRecord(recordId);
      if (!found) {
        throw new Error(`payswap_unknown_credential_record:${recordId}`);
      }
      found.record.state = "revoked";
      // principal 域级联（item 6："the principal's active sessions"）。
      return revokeSessionsOfOperator(found.operator.operatorId);
    },

    revokeOperator(operatorId) {
      const operator = operators.get(operatorId);
      if (!operator) {
        throw new Error(`payswap_unknown_operator:${operatorId}`);
      }
      for (const record of operator.credentials) {
        record.state = "revoked";
      }
      return revokeSessionsOfOperator(operatorId);
    },

    verifyCredential(token) {
      const parsed = parsePayswapOperatorCredential(token);
      if (!parsed.ok) return { status: "unknown" };
      const indexed = digestIndex.get(parsed.digest);
      if (!indexed) return { status: "unknown" };
      // 常时比较（keyed lookup 之上的第二道 —— digest 形态由本模块保证等长）。
      const operator = operators.get(indexed.operatorId);
      if (!operator) return { status: "unknown" };
      const record = operator.credentials.find((entry) => entry.recordId === indexed.recordId);
      if (!record || !verifyPayswapOperatorCredentialDigests(record.digest, parsed.digest)) {
        return { status: "unknown" };
      }
      return credentialVerdict(record, operator.operatorId);
    },

    mintSessionForCredential(token) {
      const verdict = registry.verifyCredential(token);
      if (verdict.status !== "valid") return null;
      const timestamp = now();
      const session: SessionRecord = {
        sessionId: randomId("psosess_", 16),
        operatorId: verdict.operatorId,
        credentialRecordId: verdict.recordId,
        expiresAt: timestamp + sessionLifetimeMs,
        revoked: false,
      };
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId, operatorId: session.operatorId, expiresAt: session.expiresAt };
    },

    verifySession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return { status: "unknown" };
      if (session.revoked) return { status: "revoked" };
      if (now() >= session.expiresAt) return { status: "expired" };
      // 惰性凭据法则：铸造 record 失效（撤销/过窗）→ session 死亡（无需定时器）。
      const operator = operators.get(session.operatorId);
      const record = operator?.credentials.find(
        (entry) => entry.recordId === session.credentialRecordId,
      );
      if (!operator || !record) return { status: "credential_invalid" };
      const verdict = credentialVerdict(record, operator.operatorId);
      if (verdict.status !== "valid") return { status: "credential_invalid" };
      return { status: "live", operatorId: session.operatorId };
    },

    listSessions() {
      return [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        operatorId: session.operatorId,
        live: registry.verifySession(session.sessionId).status === "live",
      }));
    },

    sweepRotationWindows() {
      const timestamp = now();
      const closedSessions: string[] = [];
      const invalidatedChallenges: string[] = [];
      for (const session of sessions.values()) {
        if (session.revoked) continue;
        const operator = operators.get(session.operatorId);
        const record = operator?.credentials.find(
          (entry) => entry.recordId === session.credentialRecordId,
        );
        if (!record || record.state !== "rotating") continue;
        if (timestamp < record.graceEndAt) continue;
        // record 域收尾（"sessions it authenticated"）。
        session.revoked = true;
        closedSessions.push(session.sessionId);
        for (const challenge of challenges.values()) {
          if (challenge.sessionId !== session.sessionId) continue;
          if (!challenge.invalidated && !challenge.consumed) {
            challenge.invalidated = true;
            invalidatedChallenges.push(challenge.challengeId);
          }
        }
      }
      return { closedSessions, invalidatedChallenges };
    },

    resolveRoles(operatorId, ledgerId) {
      return operators.get(operatorId)?.roleBindings.get(ledgerId) ?? [];
    },

    authorizeAction({ operatorId, ledgerId, action }) {
      const requiredRole = PAYSWAP_OPERATOR_ACTION_REQUIRED_ROLE[action];
      if (!operators.has(operatorId)) return { status: "unknown_operator" };
      const roles = registry.resolveRoles(operatorId, ledgerId);
      if (!roles.includes(requiredRole)) return { status: "role_required" };
      return { status: "authorized", role: requiredRole };
    },

    issueChallenge(input) {
      const verdict = registry.verifySession(input.sessionId);
      if (verdict.status !== "live") return null;
      const challenge: ChallengeRecord = {
        challengeId: randomId("psochal_", 16),
        secret: randomBytes(32).toString("hex"),
        operatorId: verdict.operatorId,
        sessionId: input.sessionId,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        consumed: false,
        invalidated: false,
      };
      challenges.set(challenge.challengeId, challenge);
      return { challengeId: challenge.challengeId, secret: challenge.secret };
    },

    resolveChallenge(input) {
      const challenge = challenges.get(input.challengeId);
      if (!challenge) return { status: "challenge_unknown" };
      if (challenge.invalidated) return { status: "challenge_invalidated" };
      if (challenge.consumed) return { status: "challenge_consumed" };
      if (now() >= challenge.expiresAt) return { status: "challenge_expired" };
      const sessionVerdict = registry.verifySession(input.sessionId);
      if (sessionVerdict.status !== "live") return { status: "session_invalid" };
      if (sessionVerdict.operatorId !== challenge.operatorId) {
        // N29：他人 principal 的解析 = impersonation 尝试；challenge 不消耗。
        return { status: "principal_mismatch" };
      }
      if (!constantTimeHexEqual(challenge.secret, input.secret)) {
        return { status: "secret_mismatch" };
      }
      challenge.consumed = true;
      return { status: "resolved" };
    },

    serializeState() {
      const state: SerializedState = {
        operators: [...operators.values()].map((operator) => ({
          operatorId: operator.operatorId,
          ...(operator.name !== undefined ? { name: operator.name } : {}),
          roleBindings: Object.fromEntries(operator.roleBindings),
          credentials: operator.credentials.map((record) => ({
            recordId: record.recordId,
            digest: record.digest,
            state: record.state,
            rotatingSince: record.rotatingSince,
            graceEndAt: record.graceEndAt,
          })),
        })),
      };
      return toSerializedState(state);
    },
  };

  return registry;
}
