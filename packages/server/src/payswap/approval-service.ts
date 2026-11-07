/**
 * PaySwap server 批准服务（addendum §1.6.2 item 5 + §1.6.3 items 3/5/9 —— 批准通道的
 * server 装配、§1.6.2 item 5c 暴露策略、grant ledger 的单一写者；ADR-12）。
 *
 * 职责（法则实现住 shared-payswap —— 单一实现纪律；本模块是 server 侧组装与
 * 暴露策略 owner）：
 * - **approval host**：registry challenge 适配器（issue/resolve 经 P1.6 法则 ——
 *   N29/N30 的解析顺序由注册表法则拥有：challenge 状态 → session 存活 → principal
 *   匹配 → secret 匹配 → 消耗）+ 角色端口（`authorizeAction` 的 (operator,
 *   workspace) 绑定法则 —— N31/N41）+ grant ledger handle 装配
 *   `createPayswapApprovalFlow`。
 * - **暴露策略（§1.6.2 item 5c）**：批准通道只对 operator 绑定连接可达 —— 注册进
 *   ServiceCollection 的默认实例是**拒绝 stub**（`approval_channel_unauthorized`，
 *   fail-closed）；只有 /ws 升级完成两级握手绑定 session 的连接经 per-connection
 *   override 换到 session-bound 真 service（`channelForSession`）。任何其它暴露面
 *   （stdio / zcode-server-cli / trusted-host face）拿到的都是 stub。
 * - **in-process host API（D11.7 纪律）**：`issueProposal`（发卡给 operator session；
 *   生产由 P2+ 的 request_authorization 接线调用 —— P1.7 无网络发卡端点）、
 *   `grants`/`authorizeOperation`（enforcement seam 的进程内观察面）。
 * - **session-bound facade**：`resolveApproval`（解析事件骑已认证 operator 连接 ——
 *   sender = operator_connection{sessionId}）与 `listPendingProposals`（该 session
 *   的 pending 卡 —— §1.6.3 item 6 的 "resolve, inspect, mint" 三臂中的 inspect 臂
 *   按 session 过滤：看不到别人的卡）。
 */

import { createServiceDescriptor, type ServiceDescriptor } from "@zcode/services";
import {
  createPayswapApprovalFlow,
  createPayswapGrantLedger,
  type PayswapApprovalChallengePort,
  type PayswapApprovalResolutionVerdict,
  type PayswapApprovalRolePort,
  type PayswapAuthorizationCardPayload,
  type PayswapAuthorizationTuple,
  type PayswapGrantLedger,
  type PayswapGrantLedgerHandle,
  type PayswapGrantRecord,
  type PayswapAuthorizeOperationVerdict,
  type PayswapProposalRecord,
} from "@zcode/shared/payswap";
import type { PayswapOperatorStore } from "./operator-store.js";

/** 批准通道名（§1.6.2 item 5c 暴露策略的对象）。 */
export const PAYSWAP_APPROVAL_CHANNEL_NAME = "payswap-approval";

/** 暴露策略 stub 的 typed 拒绝码（未绑定连接到不了批准通道 —— N28 client 臂）。 */
export const PAYSWAP_APPROVAL_CHANNEL_UNAUTHORIZED = "approval_channel_unauthorized" as const;

/** 批准通道的 /ws 暴露面（ProxyChannel 自动代理方法；返回值为 JSON 可序列化裁决）。 */
export interface PayswapApprovalChannel {
  resolveApproval(event: unknown): Promise<
    PayswapApprovalResolutionVerdict | { status: typeof PAYSWAP_APPROVAL_CHANNEL_UNAUTHORIZED }
  >;
  listPendingProposals(): Promise<
    PayswapAuthorizationCardPayload[] | { status: typeof PAYSWAP_APPROVAL_CHANNEL_UNAUTHORIZED }
  >;
}

export const payswapApprovalChannelDescriptor: ServiceDescriptor<PayswapApprovalChannel> =
  createServiceDescriptor<PayswapApprovalChannel>(PAYSWAP_APPROVAL_CHANNEL_NAME);

export type PayswapProposalIssueVerdict =
  | {
      status: "issued";
      proposalId: string;
      cardPayload: PayswapAuthorizationCardPayload;
    }
  | { status: "issue_refused"; reason: "tuple_expired" | "bearer_unavailable" };

export interface PayswapApprovalHost {
  /** 暴露策略的 fail-closed 默认（注册进 ServiceCollection 的就是这个）。 */
  readonly channelDefault: PayswapApprovalChannel;
  /** operator 绑定连接的真 service（/ws per-connection override 供给）。 */
  channelForSession(sessionId: string): PayswapApprovalChannel;
  /** in-process host API：发卡（目标 session 必须存活）。 */
  issueProposal(input: {
    tuple: PayswapAuthorizationTuple;
    workspaceId: string;
    targetSessionId: string;
  }): PayswapProposalIssueVerdict;
  /** 审计/测试观察面：已铸 grant。 */
  grants(): readonly PayswapGrantRecord[];
  /** enforcement seam 的进程内面（P7 executor 接线前的观察/测试面）。 */
  authorizeOperation(input: {
    authorizationId?: string;
    presentedTuple: PayswapAuthorizationTuple;
    invocationContext: Parameters<PayswapGrantLedger["authorizeOperation"]>[0]["invocationContext"];
    operationId?: string;
  }): PayswapAuthorizeOperationVerdict;
  /** 审计/测试观察面：proposal 记录。 */
  proposals(): readonly PayswapProposalRecord[];
}

/** registry challenge 适配器：经 P1.6 法则（N29/N30 顺序法则在注册表内）。 */
function createOperatorChallengePort(store: PayswapOperatorStore): PayswapApprovalChallengePort {
  return {
    issue({ proposalId, bearer, expiresAt }) {
      if (bearer.kind !== "operator_session") return null;
      return store.issueOperatorChallenge({
        sessionId: bearer.sessionId,
        purpose: `payswap_grant_approval:${proposalId}`,
        expiresAt,
      });
    },
    resolve({ challengeId, secret, sender }) {
      if (sender.kind !== "operator_connection") {
        return { status: "bearer_mismatch" };
      }
      // N29/N30：challenge 状态 → session 存活 → principal 匹配 → secret → 消耗
      // （注册表法则的顺序；他人 principal 不消耗 challenge）。
      return store.resolveOperatorChallenge({
        challengeId,
        secret,
        sessionId: sender.sessionId,
      });
    },
    invalidateProposal() {
      // server 侧 proposal 失效由注册表级联（撤销/过期/rotation 收尾）拥有；
      // 流状态轴（proposal_not_pending）对 teardown 兜底。
    },
  };
}

/** 角色端口：approve 动作需要目标 workspace 的 approver 角色（N31/N41）。 */
function createOperatorRolePort(store: PayswapOperatorStore): PayswapApprovalRolePort {
  return {
    authorizeApprover(principal, workspaceId) {
      const verdict = store.authorizeOperatorAction({
        operatorId: principal,
        ledgerId: workspaceId,
        action: "approve",
      });
      if (verdict.status === "authorized") return { status: "authorized" };
      if (verdict.status === "unknown_operator") return { status: "unknown_operator" };
      return { status: "role_required" };
    },
  };
}

export function createPayswapApprovalHost(options: {
  store: PayswapOperatorStore;
  now?: () => number;
}): PayswapApprovalHost {
  const { store } = options;
  const ledgerHandle: PayswapGrantLedgerHandle = createPayswapGrantLedger({
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const flow = createPayswapApprovalFlow({
    ...(options.now !== undefined ? { now: options.now } : {}),
    challengePort: createOperatorChallengePort(store),
    rolePort: createOperatorRolePort(store),
    ledger: ledgerHandle.ledger,
    minter: ledgerHandle.minter,
  });

  /** 发卡时的完整卡面（challenge 骑卡 —— host↔受信 renderer/operator 客户端层）。 */
  const issuedCards = new Map<string, PayswapAuthorizationCardPayload>();

  /** 目标 session 的存活 principal（不活 → undefined）。 */
  function livePrincipalOf(sessionId: string): string | undefined {
    return store.activeSessions().find((s) => s.sessionId === sessionId && s.live)?.operatorId;
  }

  const channelDefault: PayswapApprovalChannel = {
    async resolveApproval() {
      return { status: PAYSWAP_APPROVAL_CHANNEL_UNAUTHORIZED };
    },
    async listPendingProposals() {
      return { status: PAYSWAP_APPROVAL_CHANNEL_UNAUTHORIZED };
    },
  };

  function channelForSession(sessionId: string): PayswapApprovalChannel {
    return {
      async resolveApproval(event) {
        return flow.resolveApproval({
          event,
          sender: { kind: "operator_connection", sessionId },
        });
      },
      async listPendingProposals() {
        // inspect 臂隔离：只返回签发给本 session 的 pending 卡。
        return flow
          .proposals()
          .filter(
            (proposal) =>
              proposal.status === "pending" && proposal.targetSessionId === sessionId,
          )
          .map((proposal) => issuedCards.get(proposal.proposalId))
          .filter((payload): payload is PayswapAuthorizationCardPayload => payload !== undefined);
      },
    };
  }

  const host: PayswapApprovalHost = {
    channelDefault,
    channelForSession,
    issueProposal({ tuple, workspaceId, targetSessionId }) {
      const principal = livePrincipalOf(targetSessionId);
      if (principal === undefined) {
        return { status: "issue_refused", reason: "bearer_unavailable" };
      }
      const issued = flow.issueProposal({
        tuple,
        workspaceId,
        target: { kind: "operator_session", sessionId: targetSessionId, principal },
      });
      if (issued.status !== "issued") {
        return { status: issued.status, reason: issued.reason };
      }
      issuedCards.set(issued.proposal.proposalId, issued.cardPayload);
      return {
        status: "issued",
        proposalId: issued.proposal.proposalId,
        cardPayload: issued.cardPayload,
      };
    },
    grants() {
      return ledgerHandle.ledger.records();
    },
    authorizeOperation(input) {
      return ledgerHandle.ledger.authorizeOperation(input);
    },
    proposals() {
      return flow.proposals();
    },
  };

  return host;
}
