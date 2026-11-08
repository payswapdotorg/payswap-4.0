/**
 * PaySwap P1.8 D12.7 —— 桌面批准卡接线：真实 IPC 映射 + 生产受信 origin 值 +
 * 桌面批准 host（addendum §1.6.2 items 1–4；ADR-12 D12.7 ——「the real IPC
 * mapping, the production trusted-origin value … arrive with the surface work」；
 * playbook P1.8 work package「the desktop card wiring」）。
 *
 * 法则（normative）：
 * - **真实 IPC 映射**（§1.6.2 item 3 的接线半）：Electron ipcMain 事件的结构面
 *   （`event.sender.id` / `event.senderFrame` / `event.sender.mainFrame`）映射到
 *   法则的 `PayswapDesktopFrameSender`：
 *   1. `webContentsId` = `event.sender.id`；
 *   2. `isMainFrame` = `event.senderFrame !== null/undefined && event.senderFrame ===
 *      event.sender.mainFrame`（缺 senderFrame / sender 面缺 mainFrame = 无法证明
 *      主框架 → fail-closed false；上游先例 browser-local-preview 的 owner 检查）；
 *   3. `frameUrl` = `event.senderFrame?.url`（非字符串 = ""）。
 *   三检本体（expected webContents / main frame / trusted application origin）由
 *   approval-origin 法则在流内执法 —— 本接线只供给真实事件形状。
 * - **生产受信 origin 值**（§1.6.2 item 3 第 3 检的供给）：trustedAppOrigins 从
 *   **主窗口自身的当前 URL** 派生（originOf 语义：scheme://host[:port] 前缀域）：
 *   dev `http://localhost:<port>/...` → `http://localhost:<port>`；打包
 *   `file:///...renderer/index.html?...` → `file://`。窗口 URL 不可得（空）→ 空集
 *   = fail-closed（每个 desktop frame 拒绝）。host 在**每次**解析事件前现读主窗口
 *   URL（spawn-wiring per-request live-read 纪律 —— 三检的第 3 检不吃构造期快照）。
 * - **桌面批准 host**（§1.6.2 items 1–2 + D12.6 in-process 纪律）：
 *   - 发卡：`issueProposal`（bearer = card_instance{webContentsId, principal}）走
 *     approval-flow 法则（T3 金融模式 live 读门在外层 —— 非 S2 拒发
 *     `financial_mode_inactive`、零 challenge/ledger 副作用；缺省 reader =
 *     fail-closed）；challenge 存储用 shared 的卡实例存储（§1.6.2 item 1 单一实现）。
 *   - 解析：`handleApprovalResolution({ipcEvent, payload})` —— 映射真实 IPC 事件 →
 *     法则 sender → `flow.resolveApproval`（解析顺序法则拥有一切：事件判别 →
 *     发送者三检 → proposal 状态 → challenge 绑定 → port 解析 → deny → 铸造，
 *     digest 永远从 host 自身状态重算 —— §1.6.2 item 2）。
 *   - N18：`invalidateProposal`（卡实例 teardown）后的陈旧 challenge 重放 →
 *     `proposal_not_pending`。
 *   - T7 item 3：`revokePendingProposals` 批量失效 pending（opt-out 转移时 host
 *     调用）；事后点击 → `proposal_not_pending`、零 grant；审计历史/已铸 grant 不动。
 * - **范围（诚实声明）**：本套件是法则+接线层（真实 Electron 事件形状的结构面、
 *   真实 shared 法则、真实 challenge 存储/ledger）。真实 `ipcMain.handle` 注册进
 *   Electron main、真实渲染层卡组件与桌面 E2E 端到端臂（真实窗口/真实 DOM）属于
 *   roadmap 登记的「desktop Browser E2E battery run」+ 桌面装配接线
 *   （desktop-payswap 模块，typecheck 门）。
 */

import {
  createPayswapDesktopApprovalHost,
  derivePayswapTrustedAppOrigins,
  mapPayswapDesktopApprovalSender,
  payswapTupleDigest,
  type PayswapAuthorizationTuple,
  type PayswapDesktopApprovalHost,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 共享 fixture
// ---------------------------------------------------------------------------

/** §1.3 合法 tuple 固定样本（与 payswap-grant-law 同款纪律：文件内联，独立于被测装配）。 */
function sampleTuple(overrides: Partial<PayswapAuthorizationTuple> = {}): PayswapAuthorizationTuple {
  const base: PayswapAuthorizationTuple = {
    principal: "human-a",
    source: { connectionId: "conn_1", accountId: "acct_1AB" },
    recipient: { recipientId: "rcp_77", evidenceRef: "evd:readback:0001" },
    amount: { value: "125.50", currency: "USD" },
    purpose: "invoice_settlement",
    route: {
      legs: [
        {
          legId: "leg-1",
          provider: "stripe",
          recipientId: "rcp_77",
          amount: "125.50",
          currency: "USD",
          idempotencyKey: "idem-leg-1",
        },
      ],
    },
    fees: { maxTotalFees: "2.75" },
    fx: { rateFloor: "1.0000", rateSource: "trace-2026-11", expiresAt: 1_500_000 },
    expiresAt: 2_000_000,
  };
  return { ...base, ...overrides };
}

/** 可控时钟（过期臂走它）。 */
function controlledClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const MINUTE = 60_000;

/** dev 形态的主窗口 URL（vite dev server；loadURL 分支）。 */
const DEV_WINDOW_URL = "http://localhost:5173/index.html?launchMarks=1";
/** 打包形态的主窗口 URL（loadFile 分支）。 */
const PACKAGED_WINDOW_URL = "file:///opt/zcode/resources/app/renderer/index.html";

/**
 * 真实 Electron ipcMain 事件的结构面（IpcMain(Invoke)Event）：sender.id /
 * senderFrame（WebFrameMain | null）/ sender.mainFrame。主框架事件 =
 * senderFrame 与 sender.mainFrame 是**同一个对象**（引用相等 —— Electron 语义）。
 */
function mainWindowIpcEvent(input: {
  webContentsId: number;
  frameUrl: string;
}): { sender: { id: number; mainFrame: { url: string } }; senderFrame: { url: string } } {
  const mainFrame = { url: input.frameUrl };
  return { sender: { id: input.webContentsId, mainFrame }, senderFrame: mainFrame };
}

/** 子框架事件：senderFrame 是与 mainFrame 不同的对象（同 origin 也算子框架）。 */
function subframeIpcEvent(input: { webContentsId: number; frameUrl: string }) {
  const mainFrame = { url: "http://localhost:5173/index.html" };
  return { sender: { id: input.webContentsId, mainFrame }, senderFrame: { url: input.frameUrl } };
}

/** 装配被测 host（law 级默认：S2 金融模式 + dev 主窗口 URL）。 */
function createHostUnderTest(
  overrides: {
    financialMode?: () => { active: boolean };
    getMainWindowFrameUrl?: () => string;
    now?: () => number;
  } = {},
): PayswapDesktopApprovalHost {
  return createPayswapDesktopApprovalHost({
    getMainWindowFrameUrl: overrides.getMainWindowFrameUrl ?? (() => DEV_WINDOW_URL),
    ...(overrides.financialMode ? { financialMode: overrides.financialMode } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. 真实 IPC 映射（Electron 事件结构面 → 法则 sender）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — the real desktop approval IPC mapping (§1.6.2 item 3)", () => {
  it("maps a main-window main-frame ipc event onto the law sender face", () => {
    const sender = mapPayswapDesktopApprovalSender(
      mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
    );
    expect(sender).toEqual({
      kind: "desktop_frame",
      webContentsId: 7,
      isMainFrame: true,
      frameUrl: DEV_WINDOW_URL,
    });
  });

  it("maps a subframe event as not-main-frame (senderFrame !== sender.mainFrame)", () => {
    const sender = mapPayswapDesktopApprovalSender(
      subframeIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
    );
    expect(sender.kind).toBe("desktop_frame");
    expect(sender.isMainFrame).toBe(false);
  });

  it("fails closed when senderFrame is null/undefined (cannot prove the main frame)", () => {
    const mainFrame = { url: DEV_WINDOW_URL };
    expect(
      mapPayswapDesktopApprovalSender({ sender: { id: 7, mainFrame }, senderFrame: null })
        .isMainFrame,
    ).toBe(false);
    expect(
      mapPayswapDesktopApprovalSender({ sender: { id: 7, mainFrame }, senderFrame: undefined })
        .isMainFrame,
    ).toBe(false);
  });

  it("fails closed when the sender face lacks mainFrame", () => {
    const senderFrame = { url: DEV_WINDOW_URL };
    const sender = mapPayswapDesktopApprovalSender({
      sender: { id: 7 },
      senderFrame,
    });
    expect(sender.isMainFrame).toBe(false);
  });

  it("maps a non-string frame url as the empty string (no origin confusion)", () => {
    const sender = mapPayswapDesktopApprovalSender({
      sender: { id: 7, mainFrame: { url: "http://localhost:5173/index.html" } },
      senderFrame: { url: undefined as unknown as string },
    });
    expect(sender.frameUrl).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. 生产受信 origin 值的派生（主窗口 URL → trustedAppOrigins）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — the production trusted-origin value (§1.6.2 item 3, third check)", () => {
  it("derives the dev-server origin from the main window URL", () => {
    expect(derivePayswapTrustedAppOrigins(DEV_WINDOW_URL)).toEqual(
      new Set(["http://localhost:5173"]),
    );
  });

  it("derives the packaged file:// origin from the main window URL", () => {
    expect(derivePayswapTrustedAppOrigins(PACKAGED_WINDOW_URL)).toEqual(new Set(["file://"]));
  });

  it("derives an empty (fail-closed) set when the window URL is unavailable", () => {
    expect(derivePayswapTrustedAppOrigins("")).toEqual(new Set());
    expect(derivePayswapTrustedAppOrigins("   ")).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// 3. 桌面批准 host —— 真实映射端到端穿过 shared 法则
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — the desktop approval host through the real law", () => {
  it("issues to a card instance and approves from the same window's main frame (N14: host-recomputed digest)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error(`expected issuance, got ${issued.status}`);
    const { proposalId, cardPayload } = issued;
    expect(proposalId).toBeTruthy();
    // §1.6.0/item 2：展示投影与 tuple 一致（卡面来自 host 派生）。
    expect(cardPayload.authorization.amount).toEqual({ value: "125.50", currency: "USD" });

    const verdict = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
      payload: {
        proposalId,
        challengeId: cardPayload.challenge.challengeId,
        challengeSecret: cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toMatchObject({ status: "approved" });
    if (verdict.status !== "approved") throw new Error("unreachable");
    // §1.6.2 item 2：digest 从 host 自身状态重算 —— 与法则实现 byte-equal。
    expect(verdict.grant.tupleDigest).toBe(payswapTupleDigest(sampleTuple()));
    expect(host.grants()).toHaveLength(1);
  });

  it("rejects a resolution from a different webContents (N13 sender_mismatch)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const verdict = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({ webContentsId: 99, frameUrl: DEV_WINDOW_URL }),
      payload: {
        proposalId: issued.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toEqual({ status: "sender_rejected", reason: "sender_mismatch" });
    expect(host.grants()).toHaveLength(0);
  });

  it("rejects a subframe resolution (N13 subframe_event — same origin is not enough)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const verdict = host.handleApprovalResolution({
      ipcEvent: subframeIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
      payload: {
        proposalId: issued.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toEqual({ status: "sender_rejected", reason: "subframe_event" });
    expect(host.grants()).toHaveLength(0);
  });

  it("rejects a plugin-sandbox frame origin (N13/N16 untrusted_origin)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const verdict = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({
        webContentsId: 7,
        frameUrl: "zcode-sandbox://plugin-payswap%40zcode-plugins-official/panel.html",
      }),
      payload: {
        proposalId: issued.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toEqual({ status: "sender_rejected", reason: "untrusted_origin" });
    expect(host.grants()).toHaveLength(0);
  });

  it("rejects a ui:// plugin-resource frame origin (N26-adjacent untrusted_origin)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const verdict = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({
        webContentsId: 7,
        frameUrl: "ui://payswap@zcode-plugins-official/surface/panel",
      }),
      payload: {
        proposalId: issued.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toEqual({ status: "sender_rejected", reason: "untrusted_origin" });
    expect(host.grants()).toHaveLength(0);
  });

  it("fails closed when the main window URL is unavailable (empty trusted set)", () => {
    const host = createHostUnderTest({
      financialMode: () => ({ active: true }),
      getMainWindowFrameUrl: () => "",
    });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const verdict = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
      payload: {
        proposalId: issued.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toEqual({ status: "sender_rejected", reason: "untrusted_origin" });
  });

  it("applies a fresh trusted-origin read per event (the window URL flips → untrusted)", () => {
    let windowUrl = DEV_WINDOW_URL;
    const host = createHostUnderTest({
      financialMode: () => ({ active: true }),
      getMainWindowFrameUrl: () => windowUrl,
    });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const payload = {
      proposalId: issued.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision: "approve",
    };
    // 发卡时主窗口在 dev origin 上：同一窗口主框架解析通过。
    expect(
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: { ...payload, decision: "deny" },
      }).status,
    ).toBe("denied");
    // 重新发一张卡；主窗口 URL 变为不可得（构造期快照不吃这套）→ fail-closed。
    const second = host.issueProposal({
      tuple: sampleTuple({ purpose: "invoice_settlement_2" }),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (second.status !== "issued") throw new Error("expected second issuance");
    windowUrl = "";
    expect(
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: {
          proposalId: second.proposalId,
          challengeId: second.cardPayload.challenge.challengeId,
          challengeSecret: second.cardPayload.challenge.secret,
          decision: "approve",
        },
      }),
    ).toEqual({ status: "sender_rejected", reason: "untrusted_origin" });
  });
});

// ---------------------------------------------------------------------------
// 4. T3 金融模式门（发卡面 —— 非 S2 无卡可 pending）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — the T3 financial-mode gate at the desktop issuance face", () => {
  it("refuses issuance with zero side effects when the mode is inactive", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: false }) });
    const verdict = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    expect(verdict).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
    expect(host.proposals()).toHaveLength(0);
    expect(host.grants()).toHaveLength(0);
  });

  it("fails closed when no financial-mode reader is supplied", () => {
    const host = createHostUnderTest({});
    const verdict = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    expect(verdict).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
  });

  it("reads the mode live per issuance (S2 → off refuses the next card)", () => {
    let active = true;
    const host = createHostUnderTest({ financialMode: () => ({ active }) });
    expect(
      host.issueProposal({
        tuple: sampleTuple(),
        workspaceId: "ws-1",
        target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
      }).status,
    ).toBe("issued");
    active = false;
    expect(
      host.issueProposal({
        tuple: sampleTuple({ purpose: "invoice_settlement_2" }),
        workspaceId: "ws-1",
        target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
      }),
    ).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
    expect(host.proposals()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. N18 + T7 item 3（卡实例 teardown 与 opt-out 批量撤销）
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — N18 stale-replay and the T7 item 3 revocation at the host", () => {
  it("refuses a stale challenge after the card instance teardown (N18: proposal_not_pending)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    host.invalidateProposal(issued.proposalId);
    const verdict = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
      payload: {
        proposalId: issued.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    expect(verdict).toEqual({ status: "proposal_not_pending", statusWas: "invalidated" });
    expect(host.grants()).toHaveLength(0);
  });

  it("sweeps pending proposals on revokePendingProposals; post-revoke clicks refused, history untouched", () => {
    const clock = controlledClock();
    const host = createHostUnderTest({
      financialMode: () => ({ active: true }),
      now: () => clock.now(),
    });
    const first = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    const second = host.issueProposal({
      tuple: sampleTuple({ purpose: "invoice_settlement_2" }),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (first.status !== "issued" || second.status !== "issued") throw new Error("expected both");
    // 先批准一张（审计历史 + 已铸 grant 不在撤销集）。
    const approved = host.handleApprovalResolution({
      ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
      payload: {
        proposalId: first.proposalId,
        challengeId: first.cardPayload.challenge.challengeId,
        challengeSecret: first.cardPayload.challenge.secret,
        decision: "approve",
      },
    });
    if (approved.status !== "approved") throw new Error("expected approval");

    const revoked = host.revokePendingProposals();
    expect(revoked.map((record) => record.proposalId)).toEqual([second.proposalId]);

    // 事后点击 → proposal_not_pending、零新 grant。
    expect(
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: {
          proposalId: second.proposalId,
          challengeId: second.cardPayload.challenge.challengeId,
          challengeSecret: second.cardPayload.challenge.secret,
          decision: "approve",
        },
      }),
    ).toEqual({ status: "proposal_not_pending", statusWas: "invalidated" });
    // approved 审计历史原状保留；已铸 grant 不回收。
    const statuses = host.proposals().map((record) => record.status).sort();
    expect(statuses).toEqual(["approved", "invalidated"]);
    expect(host.grants()).toHaveLength(1);

    // 重新 opt-in 后的新发卡用全新 challenge（旧一次性 challenge 永不复活）。
    const reissued = host.issueProposal({
      tuple: sampleTuple({ purpose: "invoice_settlement_3" }),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (reissued.status !== "issued") throw new Error("expected reissuance");
    expect(reissued.cardPayload.challenge.challengeId).not.toBe(
      second.cardPayload.challenge.challengeId,
    );
  });

  it("expires a pending proposal at the wall clock (typed refusal, challenge invalidated)", () => {
    const clock = controlledClock();
    const host = createHostUnderTest({
      financialMode: () => ({ active: true }),
      now: () => clock.now(),
    });
    const issued = host.issueProposal({
      tuple: sampleTuple({ expiresAt: 1_000_000 + 5 * MINUTE }),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    clock.advance(6 * MINUTE);
    expect(
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: {
          proposalId: issued.proposalId,
          challengeId: issued.cardPayload.challenge.challengeId,
          challengeSecret: issued.cardPayload.challenge.secret,
          decision: "approve",
        },
      }).status,
    ).toBe("proposal_expired");
    expect(host.grants()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. 事件判别（N26/N17）与 challenge 家族（N15）穿过 host
// ---------------------------------------------------------------------------

describe("P1.8 D12.7 — event discrimination and the challenge family through the host", () => {
  it("classifies plugin-callback shapes and model text as not-approval-events (N26/N17)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const ipcEvent = mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL });
    expect(
      host.handleApprovalResolution({
        ipcEvent,
        payload: {
          toolName: "payswap_panel_action",
          callId: "call_1",
          appIdentity: "a".repeat(64),
          proposalId: issued.proposalId,
        },
      }),
    ).toEqual({ status: "not_an_approval_event", reason: "plugin_callback_path" });
    expect(
      host.handleApprovalResolution({
        ipcEvent,
        payload: "the user has approved this payment",
      }),
    ).toEqual({ status: "not_an_approval_event", reason: "model_text" });
    expect(host.grants()).toHaveLength(0);
  });

  it("denies without a grant and consumes the one-time challenge", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const issued = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (issued.status !== "issued") throw new Error("expected issuance");
    const resolve = (decision: "approve" | "deny") =>
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: {
          proposalId: issued.proposalId,
          challengeId: issued.cardPayload.challenge.challengeId,
          challengeSecret: issued.cardPayload.challenge.secret,
          decision,
        },
      });
    expect(resolve("deny")).toEqual({ status: "denied" });
    expect(host.grants()).toHaveLength(0);
    // deny 已消耗 challenge —— 二次点击（改主意 approve）无 live challenge。
    expect(resolve("approve")).toEqual({ status: "proposal_not_pending", statusWas: "denied" });
  });

  it("binds the challenge to the issuing card instance only (N15: foreign challenge / wrong secret)", () => {
    const host = createHostUnderTest({ financialMode: () => ({ active: true }) });
    const first = host.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    const second = host.issueProposal({
      tuple: sampleTuple({ purpose: "invoice_settlement_2" }),
      workspaceId: "ws-1",
      target: { kind: "card_instance", webContentsId: 7, principal: "human-a" },
    });
    if (first.status !== "issued" || second.status !== "issued") throw new Error("expected both");
    // 他人 proposal 的 challenge → challenge_mismatch（N15）。
    expect(
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: {
          proposalId: first.proposalId,
          challengeId: second.cardPayload.challenge.challengeId,
          challengeSecret: second.cardPayload.challenge.secret,
          decision: "approve",
        },
      }),
    ).toEqual({ status: "challenge_mismatch" });
    // 错 secret → secret_mismatch（challenge 不被消耗）。
    expect(
      host.handleApprovalResolution({
        ipcEvent: mainWindowIpcEvent({ webContentsId: 7, frameUrl: DEV_WINDOW_URL }),
        payload: {
          proposalId: first.proposalId,
          challengeId: first.cardPayload.challenge.challengeId,
          challengeSecret: "0".repeat(64),
          decision: "approve",
        },
      }),
    ).toEqual({ status: "secret_mismatch" });
    expect(host.grants()).toHaveLength(0);
  });
});
