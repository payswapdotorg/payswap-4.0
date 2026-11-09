/**
 * PaySwap 桌面批准卡接线法则（addendum §1.6.2 items 1–4 的接线半；ADR-12 D12.7 ——
 * 「the real IPC mapping, the production trusted-origin value … arrive with the
 * surface work」；playbook P1.8 work package「the desktop card wiring」）。
 *
 * 法则（normative）：
 * - **真实 IPC 映射**（§1.6.2 item 3）：Electron ipcMain 事件的结构面映射到法则的
 *   `PayswapDesktopFrameSender`（本模块不 import electron —— 结构类型；真实
 *   `IpcMainInvokeEvent` 的 sender.id/senderFrame/sender.mainFrame 满足该面，
 *   desktop 装配（desktop-payswap 模块）以此把真实事件交给法则）：
 *   1. `webContentsId` = `event.sender.id`；
 *   2. `isMainFrame` = `event.senderFrame` 与 `event.sender.mainFrame` 是**同一对象**
 *      （引用相等，Electron 语义）；缺 senderFrame / sender 面缺 mainFrame = 无法证明
 *      主框架 → fail-closed false；
 *   3. `frameUrl` = `event.senderFrame.url`（非字符串 = ""）。
 *   三检本体（expected webContents / main frame / trusted application origin）由
 *   approval-origin 法则在流内执法 —— 本模块只供给真实事件形状。
 * - **生产受信 origin 值**（§1.6.2 item 3 第 3 检的供给）：`derivePayswapTrustedAppOrigins`
 *   从**主窗口自身的当前 URL** 派生（`payswapFrameOriginOf` 单一实现 —— 与三检第 3 检
 *   的提取字节一致）：dev `http://localhost:<port>/…` → `http://localhost:<port>`；
 *   打包 `file:///…renderer/index.html?…` → `file://`。窗口 URL 不可得（空/空白）→
 *   空集 = fail-closed（每个 desktop frame 拒绝）。
 * - **桌面批准 host**（§1.6.2 items 1–2 + D12.6 in-process 纪律）：flow 装配（卡实例
 *   challenge 存储 = §1.6.2 item 1 的单一实现；ledger/minter 配对缺省）；发卡
 *   `issueProposal`（bearer = card_instance —— operator_session 是 server host 的
 *   形状）；解析 `handleApprovalResolution({ipcEvent, payload})` = 映射真实事件 →
 *   法则 sender → `flow.resolveApproval`（解析顺序法则拥有一切：事件判别 → 发送者
 *   三检 → proposal 状态 → challenge 绑定 → port 解析 → deny → 铸造；digest 永远从
 *   host 自身状态重算 —— §1.6.2 item 2）。**每次解析前现读主窗口 URL** 刷新受信
 *   origin 集（spawn-wiring per-request live-read 纪律 —— 第 3 检不吃构造期快照）。
 * - **N18 / T7 item 3**：`invalidateProposal`（卡实例 teardown → 陈旧 challenge 重放
 *   = proposal_not_pending）与 `revokePendingProposals`（opt-out 批量撤销 —— 卡面
 *   消除接线的输入）透传流法则。
 * - **IPC 通道**：`PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL` —— desktop main 的
 *   ipcMain.handle 注册名（desktop-payswap 装配；通道无条件注册是安全的：无 pending
 *   proposal 的事件得到 typed proposal_unknown，fail-closed）。
 */

import type { PayswapAuthorizationCardPayload } from "./approval-card.js";
import {
  createPayswapApprovalFlow,
  createPayswapCardInstanceChallengeStore,
  type PayswapApprovalFlow,
  type PayswapApprovalResolutionVerdict,
  type PayswapCardInstanceChallengeStore,
  type PayswapProposalRecord,
} from "./approval-flow.js";
import { payswapFrameOriginOf, type PayswapDesktopFrameSender } from "./approval-origin.js";
import type { PayswapAuthorizationTuple } from "./authorization-tuple.js";
import {
  createPayswapGrantLedger,
  type PayswapApprovedGrantMinter,
  type PayswapAuthorizeOperationVerdict,
  type PayswapGrantLedger,
  type PayswapGrantRecord,
  type PayswapInvocationContext,
} from "./grant-ledger.js";

/** desktop main 的批准通道注册名（ipcMain.handle —— desktop-payswap 装配）。 */
export const PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL = "payswap:approval" as const;

/**
 * desktop main → 目标卡实例 webContents 的卡面推送通道（desktop-payswap 装配；
 * Class-B permission-prompt 投影模式的投递半）。事件与批准解析同一 webContents
 * 定向（§1.6.2 item 1：challenge 只发给该卡实例）。
 */
export const PAYSWAP_DESKTOP_CARD_CHANNEL = "payswap:card" as const;

/**
 * 卡面推送事件（main → renderer）：发卡（含一次性 challenge 的完整 payload）与
 * 卡面消除（T7 item 3 / N18 —— pending 消失时 renderer 同步撤卡）。
 */
export type PayswapDesktopCardEvent =
  | { kind: "payswap-card-issued"; payload: PayswapAuthorizationCardPayload }
  | { kind: "payswap-card-dismissed"; proposalId: string };

/** desktop 渲染层卡组件的消费面（host 派生卡 payload —— Class-B 内容来源法则）。 */
export type { PayswapAuthorizationCardPayload };

// ---------------------------------------------------------------------------
// 真实 IPC 事件的结构面（不 import electron —— IpcMainInvokeEvent 结构满足该面）
// ---------------------------------------------------------------------------

/** Electron `WebContents` 的结构子集（映射只读 id 与 mainFrame 的对象同一性）。 */
export interface PayswapDesktopIpcSenderFace {
  readonly id: number;
  /** 真实 WebContents 恒有；结构面可选 = 缺失即无法证明主框架（fail-closed）。 */
  readonly mainFrame?: unknown;
}

/** Electron `IpcMain(Invoke)Event` 的结构子集（映射只读 sender 与 senderFrame）。 */
export interface PayswapDesktopIpcEventLike {
  readonly sender: PayswapDesktopIpcSenderFace;
  readonly senderFrame?: { readonly url?: string } | null;
}

/**
 * 真实 IPC 映射（纯）：Electron 事件结构面 → 法则 sender。主框架判定 = 引用相等
 * （`event.senderFrame === event.sender.mainFrame`，Electron 语义）；任何一侧缺失
 * （senderFrame null/undefined、sender 面无 mainFrame）= 无法证明 → false。
 */
export function mapPayswapDesktopApprovalSender(
  ipcEvent: PayswapDesktopIpcEventLike,
): PayswapDesktopFrameSender {
  const { sender, senderFrame } = ipcEvent;
  return {
    kind: "desktop_frame",
    webContentsId: sender.id,
    isMainFrame:
      senderFrame != null && sender.mainFrame !== undefined && senderFrame === sender.mainFrame,
    frameUrl: typeof senderFrame?.url === "string" ? senderFrame.url : "",
  };
}

/**
 * 生产受信 origin 值的派生（纯）：主窗口当前 URL → origin 集（单一实现与三检第 3 检
 * 字节一致）。空/空白 URL = 空集（fail-closed —— 每个 desktop frame 拒绝）。
 */
export function derivePayswapTrustedAppOrigins(
  mainWindowFrameUrl: string,
): ReadonlySet<string> {
  const trimmed = mainWindowFrameUrl.trim();
  if (!trimmed) return new Set();
  return new Set([payswapFrameOriginOf(trimmed)]);
}

// ---------------------------------------------------------------------------
// 桌面批准 host
// ---------------------------------------------------------------------------

export interface PayswapDesktopApprovalHostOptions {
  now?: () => number;
  /** 卡实例 challenge 存储（§1.6.2 item 1 单一实现）；缺省自建。 */
  challengeStore?: PayswapCardInstanceChallengeStore;
  /** 配对 ledger/minter（缺省 createPayswapGrantLedger）。 */
  ledger?: PayswapGrantLedger;
  minter?: PayswapApprovedGrantMinter;
  /**
   * T3 金融模式 live 读（addendum §2.2 T3）：每次 issueProposal 现读；非 active →
   * 拒发 financial_mode_inactive；缺省 = 无法证明 S2 → fail-closed 拒发。
   */
  financialMode?: () => { active: boolean };
  /**
   * 主窗口当前 URL（生产受信 origin 的来源）。**每次解析事件前现读**（live ——
   * 三检第 3 检不吃构造期快照）；空 = fail-closed。
   */
  getMainWindowFrameUrl: () => string;
}

/** desktop 发卡对象（bearer = 卡实例 —— operator_session 是 server host 的形状）。 */
export type PayswapDesktopCardInstanceTarget = {
  kind: "card_instance";
  webContentsId: number;
  principal: string;
};

/** 发卡裁决（与 server host 同款扁平形状 —— 渲染层只拿 proposalId + 卡面）。 */
export type PayswapDesktopProposalIssueVerdict =
  | {
      status: "issued";
      proposalId: string;
      cardPayload: PayswapAuthorizationCardPayload;
    }
  | {
      status: "issue_refused";
      reason: "tuple_expired" | "bearer_unavailable" | "financial_mode_inactive";
    };

export interface PayswapDesktopApprovalHost {
  /** 当前派生的受信 origin 集（观察面 —— 每次现读主窗口 URL）。 */
  trustedAppOrigins(): ReadonlySet<string>;
  /** in-process 发卡（D12.6 纪律：生产由 P2+ request_authorization 接线调用）。 */
  issueProposal(input: {
    tuple: PayswapAuthorizationTuple;
    workspaceId: string;
    target: PayswapDesktopCardInstanceTarget;
  }): PayswapDesktopProposalIssueVerdict;
  /** 真实 IPC 映射 + 法则解析（desktop-payswap 的 ipcMain.handle 处理体）。 */
  handleApprovalResolution(input: {
    ipcEvent: PayswapDesktopIpcEventLike;
    payload: unknown;
  }): PayswapApprovalResolutionVerdict;
  /** N18：卡实例 teardown / 失效。 */
  invalidateProposal(proposalId: string): void;
  /** T7 item 3：批量撤销 pending proposal 及其一次性 challenge。 */
  revokePendingProposals(): readonly PayswapProposalRecord[];
  /** 审计/测试观察面。 */
  proposals(): readonly PayswapProposalRecord[];
  grants(): readonly PayswapGrantRecord[];
  /** enforcement seam 的进程内观察面（P7 executor 接线前）。 */
  authorizeOperation(input: {
    authorizationId?: string;
    presentedTuple: PayswapAuthorizationTuple;
    invocationContext: PayswapInvocationContext;
    operationId?: string;
  }): PayswapAuthorizeOperationVerdict;
}

export function createPayswapDesktopApprovalHost(
  options: PayswapDesktopApprovalHostOptions,
): PayswapDesktopApprovalHost {
  const ledgerHandle =
    options.ledger && options.minter
      ? { ledger: options.ledger, minter: options.minter }
      : createPayswapGrantLedger({
          ...(options.now !== undefined ? { now: options.now } : {}),
        });
  const challengeStore =
    options.challengeStore ??
    createPayswapCardInstanceChallengeStore({
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  /** 法则持有的受信 origin 集（同一 Set 实例；host 每次解析前按现读刷新内容）。 */
  const trustedAppOrigins = new Set<string>();
  const flow: PayswapApprovalFlow = createPayswapApprovalFlow({
    ...(options.now !== undefined ? { now: options.now } : {}),
    challengePort: challengeStore,
    ledger: ledgerHandle.ledger,
    minter: ledgerHandle.minter,
    trustedAppOrigins,
    ...(options.financialMode !== undefined ? { financialMode: options.financialMode } : {}),
  });

  /** 现读主窗口 URL → 刷新法则持有的集内容（per-event live read）。 */
  function refreshTrustedAppOrigins(): void {
    const derived = derivePayswapTrustedAppOrigins(options.getMainWindowFrameUrl());
    trustedAppOrigins.clear();
    for (const origin of derived) trustedAppOrigins.add(origin);
  }

  return {
    trustedAppOrigins() {
      return derivePayswapTrustedAppOrigins(options.getMainWindowFrameUrl());
    },

    issueProposal({ tuple, workspaceId, target }) {
      const verdict = flow.issueProposal({
        tuple,
        workspaceId,
        target: {
          kind: "card_instance",
          webContentsId: target.webContentsId,
          principal: target.principal,
        },
      });
      if (verdict.status === "issued") {
        return {
          status: "issued" as const,
          proposalId: verdict.proposal.proposalId,
          cardPayload: verdict.cardPayload,
        };
      }
      return verdict;
    },

    handleApprovalResolution({ ipcEvent, payload }) {
      refreshTrustedAppOrigins();
      return flow.resolveApproval({
        event: payload,
        sender: mapPayswapDesktopApprovalSender(ipcEvent),
      });
    },

    invalidateProposal(proposalId) {
      flow.invalidateProposal(proposalId);
    },

    revokePendingProposals() {
      return flow.revokePendingProposals();
    },

    proposals() {
      return flow.proposals();
    },

    grants() {
      return ledgerHandle.ledger.records();
    },

    authorizeOperation(input) {
      return ledgerHandle.ledger.authorizeOperation(input);
    },
  };
}
