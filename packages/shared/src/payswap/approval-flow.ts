/**
 * PaySwap 批准流法则（addendum §1.3 + §1.6.2 items 1–3 —— proposal → 一次性
 * challenge → 验证过的批准事件 → grant 铸造；N14/N15/N18 的流级臂；playbook P1.7）。
 *
 * 法则（normative）：
 * - **proposal**：host 侧状态（P1.7 由法则测试/服务端装配供给；生产由 P4/P6 的
 *   intent/route 状态组装）。发卡对象 = 一个 bearer：desktop 卡实例（webContents，
 *   §1.6.2 item 1）或 server operator session（§1.6.3 item 3）。tuple 已过期 →
 *   拒绝发卡（dead-on-arrival proposal 不存在）；bearer 不可用（session 不活）→ 拒绝。
 * - **challenge**：经 challenge port 签发 —— 一次性、绑定单一 pending proposal 与
 *   签发 bearer、随 proposal 过期（expiresAt = tuple.expiresAt）。desktop 卡实例
 *   challenge 存储的单一实现（`createPayswapCardInstanceChallengeStore`）在本模块；
 *   server 侧端口适配器在 packages/server/src/payswap（复用 P1.6 registry challenge
 *   法则 —— N29/N30 的解析顺序由注册表法则拥有）。
 * - **解析顺序**（每一步失败都是 typed 拒绝、零 grant）：
 *   1. 事件判别（N26/N17 —— plugin 回调形状/模型文本/malformed 不是批准事件）；
 *   2. 发送者验证（N13/N16 —— desktop 三检；sender kind 与签发 bearer 不配 =
 *      sender_mismatch，N8 的流级臂：子代理/自动化上下文不存在到达此通道的渲染
 *      事件）；
 *   3. proposal 状态（unknown / 非 pending / 过期）；
 *   4. challenge 绑定（他人 proposal 的 challenge → challenge_mismatch，N15）；
 *   5. challenge port 解析（challenge 状态 → bearer → secret → server 侧
 *      session/principal 法则 = N29/N30）；
 *   6. deny → 无 grant、challenge 已消耗、proposal = denied；
 *   7. 角色端口（可选 —— server 装配供给 (operator, workspace) 绑定法则：N31/N41）；
 *   8. 铸造：digest 由 host 从自身 proposal 状态重算（§1.6.2 item 2 —— 永不从
 *      事件/卡/插件/模型供给的内容计算），grant principal = 签发 principal
 *      （server 侧解析、host 验证 —— 永不由客户端声明）。
 * - **N18 流级臂**：invalidateProposal（卡实例 teardown/失效）后的陈旧 challenge
 *   重放 → proposal_not_pending（challenge 已失效）。
 * - **T3 卡臂（P1.8）**：issueProposal 装配金融模式 live 读（`financialMode` option，
 *   每次发卡现读 —— spawn-wiring per-request 纪律）；非 S2 一律拒发（typed
 *   `financial_mode_inactive`，门在最外层 —— 未 opt-in 时先于 tuple 过期评估，
 *   「no card can be pending」是结构性保证而非引申）；缺省 reader = 无法证明 S2 →
 *   fail-closed 拒发（readPayswapFinancialModeFromConfig 的缺省姿态同款）。S2 行为
 *   不变（保真臂）。
 * - **T7 item 3（P1.8）**：`revokePendingProposals` 批量失效所有 pending proposal 及其
 *   一次性 challenge（opt-out 转移时 host 调用）；只扫 pending —— approved/denied
 *   审计历史不重写、已铸 grant 不回收；事后到达的 approve/deny 事件 →
 *   proposal_not_pending（N15 无 live challenge 臂）；重新 opt-in 后的新发卡用全新
 *   challenge（旧一次性 challenge 永不复活）。
 * - **单一铸造路径**：flow 是 minter 的唯一持有者 —— grant-ledger 的
 *   appendApprovedGrant 只接受本流配对的 mint（伪造/异源 mint = unauthorized_mint）。
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildPayswapAuthorizationCardPayload,
  type PayswapAuthorizationCardPayload,
} from "./approval-card.js";
import {
  classifyPayswapApprovalEventInput,
  evaluatePayswapApprovalSender,
  type PayswapApprovalSender,
} from "./approval-origin.js";
import type {
  PayswapAuthorizationTuple,
} from "./authorization-tuple.js";
import { payswapTupleDigest } from "./authorization-tuple.js";
import type {
  PayswapApprovedGrantMinter,
  PayswapGrantLedger,
  PayswapGrantRecord,
} from "./grant-ledger.js";

// ---------------------------------------------------------------------------
// proposal 记录与 bearer
// ---------------------------------------------------------------------------

export type PayswapProposalStatus = "pending" | "approved" | "denied" | "invalidated";

export interface PayswapProposalRecord {
  proposalId: string;
  tuple: PayswapAuthorizationTuple;
  tupleDigest: string;
  workspaceId: string;
  issuingPrincipal: string;
  issuedAt: number;
  expiresAt: number;
  status: PayswapProposalStatus;
  /** 签发时绑定该 proposal 的 challenge id（N15 的 foreign-proposal 检查面）。 */
  challengeId: string;
  /** 签发 bearer（desktop 卡实例或 server operator session）。 */
  targetKind: "card_instance" | "operator_session";
  targetWebContentsId?: number;
  targetSessionId?: string;
}

/** 发卡对象（desktop：卡实例 = §1.6.2 item 1 的 webContents；server：operator session）。 */
export type PayswapApprovalBearer =
  | { kind: "card_instance"; webContentsId: number; principal: string }
  | { kind: "operator_session"; sessionId: string; principal: string };

export type PayswapProposalIssueVerdict =
  | {
      status: "issued";
      proposal: PayswapProposalRecord;
      cardPayload: PayswapAuthorizationCardPayload;
    }
  | {
      status: "issue_refused";
      reason: "tuple_expired" | "bearer_unavailable" | "financial_mode_inactive";
    };

// ---------------------------------------------------------------------------
// challenge 端口（单一解析顺序法则的 challenge 段 —— 两个实现：卡实例存储（本模块）
// 与 server registry 适配器（packages/server））
// ---------------------------------------------------------------------------

export type PayswapApprovalChallengePortVerdict =
  | { status: "resolved" }
  | { status: "challenge_unknown" }
  | { status: "challenge_consumed" }
  | { status: "challenge_expired" }
  | { status: "challenge_invalidated" }
  | { status: "secret_mismatch" }
  | { status: "bearer_mismatch" }
  | { status: "principal_mismatch" }
  | { status: "session_invalid" };

export interface PayswapApprovalChallengePort {
  /** 签发（bearer 不可用 → null）。 */
  issue(input: {
    proposalId: string;
    bearer: PayswapApprovalBearer;
    expiresAt: number;
  }): { challengeId: string; secret: string } | null;
  /** 解析（发送者即解析 bearer —— 状态 → bearer → secret 顺序由实现保证）。 */
  resolve(input: {
    challengeId: string;
    secret: string;
    sender: PayswapApprovalSender;
  }): PayswapApprovalChallengePortVerdict;
  /** proposal 失效（teardown；server 侧级联由 registry 法则拥有 —— 适配器为 no-op）。 */
  invalidateProposal(proposalId: string): void;
}

// ---------------------------------------------------------------------------
// 角色端口（可选 —— server 装配供给 (operator, workspace) 绑定法则：N31/N41；
// desktop 单人 principal 无角色维度）
// ---------------------------------------------------------------------------

export interface PayswapApprovalRolePort {
  authorizeApprover(
    principal: string,
    workspaceId: string,
  ): { status: "authorized" } | { status: "role_required" } | { status: "unknown_operator" };
}

// ---------------------------------------------------------------------------
// 解析裁决
// ---------------------------------------------------------------------------

export type PayswapApprovalResolutionVerdict =
  | { status: "not_an_approval_event"; reason: "plugin_callback_path" | "model_text" | "malformed_event" }
  | { status: "sender_rejected"; reason: "sender_mismatch" | "subframe_event" | "untrusted_origin" }
  | { status: "proposal_unknown" }
  | { status: "proposal_not_pending"; statusWas: PayswapProposalStatus }
  | { status: "proposal_expired" }
  | { status: "challenge_mismatch" }
  | Exclude<PayswapApprovalChallengePortVerdict, { status: "resolved" }>
  | { status: "role_required" }
  | { status: "unknown_operator" }
  | { status: "denied" }
  | { status: "approved"; grant: PayswapGrantRecord };

// ---------------------------------------------------------------------------
// 流
// ---------------------------------------------------------------------------

export interface PayswapApprovalFlowOptions {
  now?: () => number;
  challengePort: PayswapApprovalChallengePort;
  ledger: PayswapGrantLedger;
  minter: PayswapApprovedGrantMinter;
  /** server 装配供给（N31/N41）；缺省 = desktop 单人 principal（无角色维度）。 */
  rolePort?: PayswapApprovalRolePort;
  /** 受信 application origins（§1.6.2 item 3 三检的第 3 检；空集 = fail-closed）。 */
  trustedAppOrigins?: ReadonlySet<string> | readonly string[];
  /**
   * T3 卡臂的金融模式 live 读（addendum §2.2 T3）：每次 issueProposal 现读（非构造期
   * 快照）；非 active → 拒发 financial_mode_inactive。缺省 = 无法证明 S2 → fail-closed
   * 拒发（与 readPayswapFinancialModeFromConfig 的缺省姿态同款）。
   */
  financialMode?: () => { active: boolean };
}

export interface PayswapApprovalFlow {
  issueProposal(input: {
    tuple: PayswapAuthorizationTuple;
    workspaceId: string;
    target: PayswapApprovalBearer;
  }): PayswapProposalIssueVerdict;
  resolveApproval(input: {
    event: unknown;
    sender: PayswapApprovalSender;
  }): PayswapApprovalResolutionVerdict;
  invalidateProposal(proposalId: string): void;
  /**
   * T7 item 3：批量失效所有 pending proposal 及其一次性 challenge（opt-out 转移时
   * host 调用；返回被撤销记录 —— 卡面消除接线的输入）。只扫 pending：approved/denied
   * 原状保留（审计历史不重写）。
   */
  revokePendingProposals(): readonly PayswapProposalRecord[];
  proposals(): readonly PayswapProposalRecord[];
}

export function createPayswapApprovalFlow(options: PayswapApprovalFlowOptions): PayswapApprovalFlow {
  const now = options.now ?? Date.now;
  const proposals = new Map<string, PayswapProposalRecord>();
  // T3 卡臂的金融模式 live 读：缺省 = 无法证明 S2 → fail-closed 拒发。
  const readFinancialMode = options.financialMode ?? (() => ({ active: false }));

  function invalidateProposal(proposalId: string): void {
    const proposal = proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") return;
    proposal.status = "invalidated";
    options.challengePort.invalidateProposal(proposalId);
  }

  function revokePendingProposals(): readonly PayswapProposalRecord[] {
    const revoked: PayswapProposalRecord[] = [];
    for (const proposal of proposals.values()) {
      if (proposal.status !== "pending") continue;
      proposal.status = "invalidated";
      options.challengePort.invalidateProposal(proposal.proposalId);
      revoked.push(proposal);
    }
    return revoked;
  }

  return {
    issueProposal({ tuple, workspaceId, target }) {
      // 0. 金融模式门（最外层 —— T3 卡臂）：非 S2 → 无卡可 pending（零副作用：
      // 不评估 tuple、不签 challenge、不写 ledger）。
      if (!readFinancialMode().active) {
        return { status: "issue_refused", reason: "financial_mode_inactive" };
      }
      const at = now();
      if (at >= tuple.expiresAt) {
        return { status: "issue_refused", reason: "tuple_expired" };
      }
      const proposalId = randomUUID();
      const challenge = options.challengePort.issue({
        proposalId,
        bearer: target,
        expiresAt: tuple.expiresAt,
      });
      if (challenge === null) {
        return { status: "issue_refused", reason: "bearer_unavailable" };
      }
      const record: PayswapProposalRecord = {
        proposalId,
        tuple,
        tupleDigest: payswapTupleDigest(tuple),
        workspaceId,
        issuingPrincipal: target.principal,
        issuedAt: at,
        expiresAt: tuple.expiresAt,
        status: "pending",
        challengeId: challenge.challengeId,
        targetKind: target.kind,
        ...(target.kind === "card_instance"
          ? { targetWebContentsId: target.webContentsId }
          : { targetSessionId: target.sessionId }),
      };
      proposals.set(proposalId, record);
      return {
        status: "issued",
        proposal: record,
        cardPayload: buildPayswapAuthorizationCardPayload({
          proposal: { proposalId, tuple },
          challenge,
        }),
      };
    },

    resolveApproval({ event, sender }) {
      // 1. 事件判别（N26/N17）。
      const classified = classifyPayswapApprovalEventInput(event);
      if (classified.kind === "not_an_approval_event") {
        return { status: "not_an_approval_event", reason: classified.reason };
      }
      const approvalEvent = classified.event;

      // 2. proposal 查找 + 发送者验证（N13/N16/N8 流级臂）。
      const proposal = proposals.get(approvalEvent.proposalId);
      if (!proposal) {
        return { status: "proposal_unknown" };
      }
      if (proposal.targetKind === "card_instance") {
        if (sender.kind !== "desktop_frame") {
          return { status: "sender_rejected", reason: "sender_mismatch" };
        }
        const senderVerdict = evaluatePayswapApprovalSender({
          sender,
          expectedWebContentsId: proposal.targetWebContentsId,
          trustedAppOrigins: options.trustedAppOrigins ?? [],
        });
        if (senderVerdict.status === "rejected") {
          return { status: "sender_rejected", reason: senderVerdict.reason };
        }
      } else if (sender.kind !== "operator_connection") {
        return { status: "sender_rejected", reason: "sender_mismatch" };
      }

      // 3. proposal 状态与过期。
      if (proposal.status !== "pending") {
        return { status: "proposal_not_pending", statusWas: proposal.status };
      }
      if (now() >= proposal.expiresAt) {
        proposal.status = "invalidated";
        options.challengePort.invalidateProposal(proposal.proposalId);
        return { status: "proposal_expired" };
      }

      // 4. challenge 绑定（N15：他人 proposal 的 challenge）。
      if (approvalEvent.challengeId !== proposal.challengeId) {
        return { status: "challenge_mismatch" };
      }

      // 5. challenge port 解析（challenge 状态 → bearer → secret；server 侧
      //    session/principal 法则 = N29/N30 由注册表法则拥有 —— 认证法则先行，
      //    跨用户尝试在 principal 轴失败，不泄漏角色信息）。
      const portVerdict = options.challengePort.resolve({
        challengeId: approvalEvent.challengeId,
        secret: approvalEvent.challengeSecret,
        sender,
      });
      if (portVerdict.status !== "resolved") {
        return portVerdict;
      }

      // 6. deny → 无 grant（challenge 已消耗 —— 一次性不分决定）。
      if (approvalEvent.decision === "deny") {
        proposal.status = "denied";
        return { status: "denied" };
      }

      // 7. 角色端口（server：(operator, workspace) 绑定法则 —— N31/N41；在铸造前、
      //    在已认证的正当解析者上评估）。角色失败的 approve 已消耗 challenge ——
      //    人的决定已花掉，重新批准需新 challenge/新卡（内容由 host 重新派生）。
      if (options.rolePort) {
        const roleVerdict = options.rolePort.authorizeApprover(
          proposal.issuingPrincipal,
          proposal.workspaceId,
        );
        if (roleVerdict.status !== "authorized") {
          return roleVerdict;
        }
      }

      // 8. 铸造：digest 从 host 自身 proposal 状态重算（§1.6.2 item 2）；
      //    grant principal = 签发 principal（server 解析/host 验证）。
      const grant = options.ledger.appendApprovedGrant(
        options.minter.mintApprovedGrant({
          tuple: proposal.tuple,
          tupleDigest: payswapTupleDigest(proposal.tuple),
          principal: proposal.issuingPrincipal,
          workspaceId: proposal.workspaceId,
          ...(options.rolePort ? { approvedRole: "approver" } : {}),
          issuedAt: now(),
        }),
      );
      proposal.status = "approved";
      return { status: "approved", grant };
    },

    invalidateProposal,

    revokePendingProposals,

    proposals() {
      return [...proposals.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// 卡实例 challenge 存储（§1.6.2 item 1 的单一实现 —— desktop bearer）
// ---------------------------------------------------------------------------

interface CardInstanceChallengeRecord {
  challengeId: string;
  secret: string;
  proposalId: string;
  webContentsId: number;
  expiresAt: number;
  consumed: boolean;
  invalidated: boolean;
}

/** secret 的常时比较（hex 等长形态由本模块铸造保证；长度不等直接 false）。 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export interface PayswapCardInstanceChallengeStore extends PayswapApprovalChallengePort {
  pendingCount(): number;
}

/**
 * desktop 卡实例 challenge 存储：256-bit CSPRNG secret（64 hex）、一次性、绑定
 * (proposal, 签发卡实例)、随 proposal 过期；解析顺序 unknown → invalidated →
 * consumed → expired → bearer → secret → resolved。
 */
export function createPayswapCardInstanceChallengeStore(
  options: { now?: () => number } = {},
): PayswapCardInstanceChallengeStore {
  const now = options.now ?? Date.now;
  const challenges = new Map<string, CardInstanceChallengeRecord>();

  return {
    issue({ proposalId, bearer, expiresAt }) {
      if (bearer.kind !== "card_instance") return null;
      const record: CardInstanceChallengeRecord = {
        challengeId: `pschal_${randomBytes(16).toString("hex")}`,
        secret: randomBytes(32).toString("hex"),
        proposalId,
        webContentsId: bearer.webContentsId,
        expiresAt,
        consumed: false,
        invalidated: false,
      };
      challenges.set(record.challengeId, record);
      return { challengeId: record.challengeId, secret: record.secret };
    },

    resolve({ challengeId, secret, sender }) {
      const record = challenges.get(challengeId);
      if (!record) return { status: "challenge_unknown" };
      if (record.invalidated) return { status: "challenge_invalidated" };
      if (record.consumed) return { status: "challenge_consumed" };
      if (now() >= record.expiresAt) return { status: "challenge_expired" };
      if (sender.kind !== "desktop_frame" || sender.webContentsId !== record.webContentsId) {
        return { status: "bearer_mismatch" };
      }
      if (!constantTimeHexEqual(record.secret, secret)) {
        return { status: "secret_mismatch" };
      }
      record.consumed = true;
      return { status: "resolved" };
    },

    invalidateProposal(proposalId) {
      for (const record of challenges.values()) {
        if (record.proposalId === proposalId) {
          record.invalidated = true;
        }
      }
    },

    pendingCount() {
      let count = 0;
      for (const record of challenges.values()) {
        if (!record.consumed && !record.invalidated && now() < record.expiresAt) {
          count += 1;
        }
      }
      return count;
    },
  };
}
