/**
 * PaySwap P1.8 —— T1–T7/S 系列表面生命周期电池（工程层）（addendum §2/§2.2/§2.3；
 * playbook P1.8 work package「Surface lifecycle」—— roadmap 登记 outstanding 的首项：
 * the T1–T7/S-series surface lifecycle battery）。
 *
 * 法则（normative，addendum §2/§2.2/§2.3 原文）：
 * - **T3 卡臂**（§2.2 T3）：「no authorization card renders (the broker refuses to
 *   create proposals — no card can be pending)」—— 批准流的发卡面装配金融模式 live 读
 *   （`financialMode: () => { active }`，spawn-wiring per-request live read 纪律），
 *   非 S2 一律拒发（typed `financial_mode_inactive`）；缺省 reader = 无法证明 S2 →
 *   fail-closed 拒发（readPayswapFinancialModeFromConfig 的缺省姿态同款）。
 * - **T7 item 3**（§2.3 item 3）：「All pending grant proposals and their one-time
 *   challenges are host-owned state; opt-out invalidates them at the transition. An
 *   approval event arriving after opt-out finds no live challenge — rejected, no
 *   grant (the N15 invalid-challenge rule; T7 asserts it end-to-end).」——
 *   `revokePendingProposals()` 批量失效 pending proposal + 其一次性 challenge；
 *   事后 approve/deny 点击 → `proposal_not_pending`、零 grant；只扫 pending
 *   （approved/denied 审计历史不重写）。
 * - **T7 item 1 臂 (b) —— 表面内容注册表**（§2.3 item 1）：「every Class-A surface
 *   instance it renders is tracked by its captured sandbox lease (`sandboxId`/`initId`
 *   + the plugin `appIdentity` lease triple) together with a
 *   has-ever-received-protected-data mark. On opt-out, every marked instance is torn
 *   down by the host, on upstream's own teardown discipline: a bounded
 *   `ui/resource-teardown` cleanup window whose expiry proceeds without the page's
 *   cooperation, then bridge/port close and `disposeSandbox(sandboxId, initId)`.」
 *   锚点占位（金融工作区面板）→ dispose 后以**无数据能力的新租约**实例重占（新
 *   sandboxId/initId，S1 禁用态渲染）；已关闭实例无 dispose 但 renderer 键仍在清除集
 *   （feed 快照跨关闭存留 —— 重开不得恢复陈旧数据）；未标记实例 = best-effort 事件，
 *   无安全属性依赖它（§2.3 item 5）。注册面 fail-closed：外来插件的键/畸形键不得入册
 *   （恰自有键纪律 —— 「clears exactly its own surface keys (its pluginId/server),
 *   touching no other plugin's entries」）。
 * - **执行器**：串行（注册序）、每实例有界拆除窗（默认上游 MCP_APPS_TEARDOWN_TIMEOUT_MS
 *   纪律）；页面永不合作 → 窗到期推进；替换租约必须 sandboxId/initId 皆新（复用旧
 *   sandboxId = fail-closed 抛错 —— disposeSandbox 契约「new pages use new credentials
 *   and sandboxIds」）；retention 清除恰按计划键集、两 store 都清。
 * - **S 系投影**（§2）：S0b = installed-but-disabled 贡献**零运行时组件**（上游
 *   emptyComponents 纪律），metadata 保留供管理页展示连续性；S1 = 恰为标准启用增量
 *   （delta-equivalence：与同形状对照插件的增量种类完全一致，仅名字参数化 ——
 *   「the S1-vs-S0 delta must equal the delta upstream itself produces when any
 *   control plugin with the same component shape … is enabled … any delta kind
 *   beyond that set is a failure」）；S2 = 声明面零增长（Class-B 卡是 proposal 驱动，
 *   非声明面）；T6 = userConfig 恰为自有单选项 financialWorkspace（boolean 默认
 *   false，零设置页改造位）。
 *
 * 两级证明：
 * 1. 法则级（纯 shared 模块）—— 发卡门/批量撤销/注册表计划/执行器纪律。
 * 2. 发现边界（真实 discoverNodePluginsSync + 真实官方插件 seed + 对照插件 fixture）
 *   —— S 系投影与 delta 等价的工程测试形态。
 *
 * 范围（诚实声明，工程层 vs 桌面 E2E 层）：
 * - T1 的「tools registered and inert」与 S1 数据不可达臂已由 payswap-launch-path
 *   （真实 stdio spawn + not_opted_in/not_connected）覆盖；T2/T3 的 broker 拒绝码
 *   实时翻转臂已由 payswap-broker-chain（operations.ts 三码法则 live 读）覆盖；T4
 *   残留会话臂（financial_mode_disabled）已由 spawn-wiring/chain/replay 套件覆盖
 *   （ADR-5 D5.6）。本电池不重复这些行。
 * - §2 测试预言的字节级渲染面比较（S0a-vs-upstream / S0b-vs-upstream-disabled）与
 *   T7 的桌面 Electron E2E 端到端臂（真实 DOM/heap 销毁、真实 renderer store）是
 *   桌面 E2E 层的事 —— roadmap 登记的 outstanding「desktop Browser E2E battery
 *   run」+「desktop card wiring (D12.7)」；本电池落法则与接线缝（D12.7 以
 *   runPluginUiHostTeardown/clearPluginUiSurfaceFeed/clearPluginUiWidgetState 接线）。
 * - 表面键与 buildPluginUiSurfaceKey 同构（[sessionKey, pluginId, server, resourceUri,
 *   scopeId] 的 JSON 数组）；真实 builder 在 @zcode/ui（bootstrap 不可达 —— 依赖方向），
 *   法则按结构等价键测试，字节等价由 D12.7 接线时以真实 builder 复验。
 * - T5 uninstall 臂：config/userConfig 移除是上游既有 uninstall 流（plugins.ts/
 *   file-config.adapter.ts）不改不证；凭据删除走 deliverable 05 §5（P2 account
 *   service）；ledger 保留规则属 P4+ ledger 工作 —— 本电池无 T5 新行。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import {
  createPayswapApprovalFlow,
  createPayswapCardInstanceChallengeStore,
  createPayswapGrantLedger,
  createPayswapSurfaceContentRegistry,
  runPayswapSurfaceOptOutRevocation,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  type PayswapAuthorizationTuple,
  type PayswapSurfaceLease,
  type PayswapSurfaceRevocationDeps,
} from "@zcode/shared/payswap";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import { listPluginUiSurfacesFromPlugins } from "../src/zcode-protocol/plugin-ui-surfaces.js";
import { ensurePayswapPluginDist } from "./payswap-plugin-build.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 共享 fixture（law 级）
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

const FIXED_NOW = () => 1_000_000;

/**
 * 带金融模式 live 读的发卡流（law 级默认装置）。`mode` 是可变闭包 —— live 翻转行
 * 直接改它（每次 issueProposal 现读，非构造期快照）。
 */
function createGatedFlow(input: { mode: () => boolean }) {
  const ledgerHandle = createPayswapGrantLedger({ now: FIXED_NOW });
  const challengeStore = createPayswapCardInstanceChallengeStore({ now: FIXED_NOW });
  const flow = createPayswapApprovalFlow({
    now: FIXED_NOW,
    challengePort: challengeStore,
    ledger: ledgerHandle.ledger,
    minter: ledgerHandle.minter,
    financialMode: () => ({ active: input.mode() }),
  });
  return { ledgerHandle, challengeStore, flow };
}

const CARD_TARGET = { kind: "card_instance", webContentsId: 7, principal: "human-a" } as const;

const TRUSTED_SENDER = {
  kind: "desktop_frame",
  webContentsId: 7,
  isMainFrame: true,
  frameUrl: "app://zcode-shell/index.html",
} as const;

/** 对一张已发卡的批准/拒绝事件（T7 item 3 行复用）。 */
function approvalEvent(
  issued: { proposal: { proposalId: string }; cardPayload: { challenge: { challengeId: string; secret: string } } },
  decision: "approve" | "deny",
) {
  return {
    event: {
      proposalId: issued.proposal.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision,
    },
    sender: TRUSTED_SENDER,
  };
}

// ---------------------------------------------------------------------------
// 法则级 A：T3 卡臂 —— 发卡面的金融模式门（§2.2 T3 / §2.1 live 读）
// ---------------------------------------------------------------------------

describe("payswap approval flow — T3 card arm: financial-mode gate at the proposal face (§2.2 T3)", () => {
  it("S1（enabled 未 opt-in）：issueProposal 一律拒绝 financial_mode_inactive —— 无卡可 pending；challenge/ledger 零副作用", () => {
    const { ledgerHandle, challengeStore, flow } = createGatedFlow({ mode: () => false });
    const verdict = flow.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-a",
      target: CARD_TARGET,
    });
    expect(verdict).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
    // 「no card can be pending」：零 proposal 记录、零 challenge 签发、零 grant。
    expect(flow.proposals()).toEqual([]);
    expect(challengeStore.pendingCount()).toBe(0);
    expect(ledgerHandle.ledger.grants()).toEqual([]);
  });

  it("门在最外层：未 opt-in 时过期 tuple 也报 financial_mode_inactive（模式拒绝先于一切发卡评估）", () => {
    const { flow } = createGatedFlow({ mode: () => false });
    const verdict = flow.issueProposal({
      tuple: sampleTuple({ expiresAt: 500_000 }), // 早已过期（now=1_000_000）。
      workspaceId: "ws-a",
      target: CARD_TARGET,
    });
    expect(verdict).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
  });

  it("live 读：同一 flow 上 S1→S2→S1 翻转即时生效（每次发卡现读，非构造期快照）", () => {
    let active = false;
    const { flow } = createGatedFlow({ mode: () => active });

    // S1：拒。
    expect(
      flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET }),
    ).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });

    // S2（opt-in，T2 正向臂）：同一 flow、同一 tuple —— 发卡成功。
    active = true;
    const issued = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    expect(issued.status).toBe("issued");

    // opt-out（T3）：翻转即时回拒 —— 新发卡不再可能。
    active = false;
    expect(
      flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET }),
    ).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
  });

  it("fail-closed 缺省：未装配 financialMode reader = 无法证明 S2 → 拒发（默认拒，非默认放行）", () => {
    // P1.7 的既有装配在 GREEN 后都显式供给 reader；缺省本身必须 fail-closed。
    const ledgerHandle = createPayswapGrantLedger({ now: FIXED_NOW });
    const flow = createPayswapApprovalFlow({
      now: FIXED_NOW,
      challengePort: createPayswapCardInstanceChallengeStore({ now: FIXED_NOW }),
      ledger: ledgerHandle.ledger,
      minter: ledgerHandle.minter,
    });
    expect(
      flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET }),
    ).toEqual({ status: "issue_refused", reason: "financial_mode_inactive" });
  });

  it("S2（opt-in）：发卡照常 —— 门不改变 S2 行为（P1.7 正向路径不变，保真臂）", () => {
    const { flow } = createGatedFlow({ mode: () => true });
    const verdict = flow.issueProposal({
      tuple: sampleTuple(),
      workspaceId: "ws-a",
      target: CARD_TARGET,
    });
    expect(verdict.status).toBe("issued");
    if (verdict.status !== "issued") return;
    expect(verdict.proposal.status).toBe("pending");
    expect(verdict.cardPayload.challenge.challengeId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 法则级 B：T7 item 3 —— pending proposal 批量撤销（§2.3 item 3 / N15）
// ---------------------------------------------------------------------------

describe("payswap approval flow — T7 item 3: batch revocation of pending proposals (§2.3 item 3)", () => {
  it("批量撤销：所有 pending → invalidated + challenge 全灭；返回被撤销记录（卡面消除接线的输入）", () => {
    const { challengeStore, flow } = createGatedFlow({ mode: () => true });
    const issued = [1, 2, 3].map(() =>
      flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET }),
    );
    for (const verdict of issued) expect(verdict.status).toBe("issued");
    expect(challengeStore.pendingCount()).toBe(3);

    const revoked = flow.revokePendingProposals();
    expect(revoked).toHaveLength(3);
    for (const record of revoked) expect(record.status).toBe("invalidated");
    // challenge 存储：一次性 challenge 全灭。
    expect(challengeStore.pendingCount()).toBe(0);
    for (const record of flow.proposals()) expect(record.status).toBe("invalidated");
  });

  it("事后批准（opt-out 后的 approve 点击）：proposal_not_pending、零 grant —— N15 无 live challenge 臂", () => {
    const { ledgerHandle, flow } = createGatedFlow({ mode: () => true });
    const issued = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;

    flow.revokePendingProposals();

    // opt-out 后到达的批准事件（旧 proposalId + 旧一次性 challenge）。
    const verdict = flow.resolveApproval(approvalEvent(issued, "approve"));
    expect(verdict).toEqual({ status: "proposal_not_pending", statusWas: "invalidated" });
    expect(ledgerHandle.ledger.grants()).toEqual([]);
  });

  it("事后 deny 点击同样拒绝：状态检查先于决定（deny 也不是撤销后的合法事件）", () => {
    const { flow } = createGatedFlow({ mode: () => true });
    const issued = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;

    flow.revokePendingProposals();

    const verdict = flow.resolveApproval(approvalEvent(issued, "deny"));
    expect(verdict).toEqual({ status: "proposal_not_pending", statusWas: "invalidated" });
  });

  it("只扫 pending：approved/denied 原状保留（审计历史不因 opt-out 重写；已铸 grant 不回收）", () => {
    const { ledgerHandle, challengeStore, flow } = createGatedFlow({ mode: () => true });
    const approveMe = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    const denyMe = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    const stayPending = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    expect(approveMe.status).toBe("issued");
    expect(denyMe.status).toBe("issued");
    expect(stayPending.status).toBe("issued");
    if (approveMe.status !== "issued" || denyMe.status !== "issued" || stayPending.status !== "issued") {
      return;
    }

    expect(flow.resolveApproval(approvalEvent(approveMe, "approve")).status).toBe("approved");
    expect(flow.resolveApproval(approvalEvent(denyMe, "deny")).status).toBe("denied");
    const grantsBefore = ledgerHandle.ledger.grants().length;

    const revoked = flow.revokePendingProposals();
    expect(revoked.map((record) => record.proposalId)).toEqual([stayPending.proposal.proposalId]);
    // approved/denied 原状、已铸 grant 不回收。
    const statuses = new Map(flow.proposals().map((record) => [record.proposalId, record.status]));
    expect(statuses.get(approveMe.proposal.proposalId)).toBe("approved");
    expect(statuses.get(denyMe.proposal.proposalId)).toBe("denied");
    expect(statuses.get(stayPending.proposal.proposalId)).toBe("invalidated");
    expect(ledgerHandle.ledger.grants()).toHaveLength(grantsBefore);
    expect(challengeStore.pendingCount()).toBe(0);
  });

  it("撤销后重新 opt-in：新发卡成功，新 challenge ≠ 旧 challenge（旧一次性 challenge 永不复活）", () => {
    const { flow } = createGatedFlow({ mode: () => true });
    const first = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    expect(first.status).toBe("issued");
    if (first.status !== "issued") return;

    flow.revokePendingProposals();

    // 重新 opt-in：门重开、新卡新 challenge。
    const second = flow.issueProposal({ tuple: sampleTuple(), workspaceId: "ws-a", target: CARD_TARGET });
    expect(second.status).toBe("issued");
    if (second.status !== "issued") return;
    expect(second.cardPayload.challenge.challengeId).not.toBe(first.cardPayload.challenge.challengeId);

    // 旧 challenge 解析（对旧 proposal）仍拒绝。
    const staleVerdict = flow.resolveApproval(approvalEvent(first, "approve"));
    expect(staleVerdict).toEqual({ status: "proposal_not_pending", statusWas: "invalidated" });
  });

  it("空集幂等：无 pending 时撤销 = no-op、返回空", () => {
    const { flow } = createGatedFlow({ mode: () => true });
    expect(flow.revokePendingProposals()).toEqual([]);
    // 再撤一次仍空。
    expect(flow.revokePendingProposals()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 法则级 C：T7 item 1 臂 (b) —— 表面内容注册表与撤销计划（§2.3 item 1）
// ---------------------------------------------------------------------------

/** 结构等价表面键（与 buildPluginUiSurfaceKey 同构；真实 builder 在 @zcode/ui 不可达）。 */
function surfaceKeyOf(input: {
  pluginId?: string;
  serverName?: string;
  surfaceId?: string;
  resourceUri?: string;
  sessionId?: string;
  workspace?: string;
} = {}): string {
  const surfaceId = input.surfaceId ?? "workspace";
  return JSON.stringify([
    JSON.stringify([input.workspace ?? "/ws/alpha", input.sessionId ?? "session-1"]),
    input.pluginId ?? PAYSWAP_OFFICIAL_PLUGIN_ID,
    input.serverName ?? "gateway",
    input.resourceUri ?? `ui://payswap/${surfaceId}.html`,
    `surface:${surfaceId}`,
  ]);
}

/** 捕获租约 fixture（PluginSandboxHandle.sandboxId/initId + McpAppInstance 三元组的结构等价投影）。 */
function leaseOf(n: number): PayswapSurfaceLease {
  return {
    sandboxId: `sbx-${n}`,
    initId: 100 + n,
    runtimeId: `rt-${n}`,
    generation: 1,
    appIdentity: "a".repeat(64),
  };
}

describe("payswap surface content registry — T7 item 1 arm (b): host-side revocation plan (§2.3 item 1)", () => {
  it("标记实例 → dispose（释放锚点策略）；自有键进清除集", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "evidence" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(key);

    const plan = registry.planOptOutRevocation();
    expect(plan.actions).toEqual([
      { kind: "dispose", surfaceKey: key, lease: leaseOf(1) },
    ]);
    expect(plan.retentionKeysToClear).toEqual([key]);
  });

  it("标记 + 锚点占位（金融工作区面板）→ dispose_and_replace（dispose 后以无数据新租约实例重占）", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "workspace" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "replace" });
    registry.markProtectedDataDelivered(key);

    const plan = registry.planOptOutRevocation();
    expect(plan.actions).toEqual([
      { kind: "dispose_and_replace", surfaceKey: key, lease: leaseOf(1) },
    ]);
    expect(plan.retentionKeysToClear).toEqual([key]);
  });

  it("未标记实例 → best_effort_event（不强制拆除；§2.3 item 5：无安全属性依赖 best-effort UX）", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "route-plan" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });

    const plan = registry.planOptOutRevocation();
    expect(plan.actions).toEqual([
      { kind: "best_effort_event", surfaceKey: key, lease: leaseOf(1) },
    ]);
    // 未标记表面也清 renderer 保留（「reopening a PaySwap surface starts from empty」）。
    expect(plan.retentionKeysToClear).toEqual([key]);
  });

  it("无可见性维度：标记的背景/隐藏实例与前台实例同待遇（a background page is a live page）", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const foreground = surfaceKeyOf({ surfaceId: "workspace" });
    const background = surfaceKeyOf({ surfaceId: "workspace", sessionId: "session-2" });
    registry.registerInstance({ surfaceKey: foreground, lease: leaseOf(1), anchor: "release" });
    registry.registerInstance({ surfaceKey: background, lease: leaseOf(2), anchor: "release" });
    registry.markProtectedDataDelivered(foreground);
    registry.markProtectedDataDelivered(background);

    const plan = registry.planOptOutRevocation();
    expect(plan.actions.map((action) => action.kind)).toEqual(["dispose", "dispose"]);
    expect(plan.retentionKeysToClear).toEqual([foreground, background]);
  });

  it("已关闭（retired）实例：无 dispose（无 live 租约），但键仍在清除集（feed 快照跨关闭存留 —— 重开不得恢复陈旧数据）", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "evidence" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(key);
    registry.retireInstance(key); // 正常关闭（upstream 生命周期）—— 租约离场、键保留。

    const plan = registry.planOptOutRevocation();
    expect(plan.actions).toEqual([]); // 无 live 实例 → 无拆除动作。
    expect(plan.retentionKeysToClear).toEqual([key]); // renderer 保留仍清。
  });

  it("恰自有键（注册面 fail-closed）：外来插件键/畸形键注册 → 抛错、注册表不受污染", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const ownKey = surfaceKeyOf({ surfaceId: "workspace" });
    registry.registerInstance({ surfaceKey: ownKey, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(ownKey);

    // 外来插件的键（pluginId 位是三方插件）：不得入册。
    const foreignKey = surfaceKeyOf({ pluginId: "evil@evil-market", surfaceId: "workspace" });
    expect(() =>
      registry.registerInstance({ surfaceKey: foreignKey, lease: leaseOf(2), anchor: "release" }),
    ).toThrow();
    // 畸形键（非 buildPluginUiSurfaceKey 形状）：不得入册。
    expect(() =>
      registry.registerInstance({ surfaceKey: "not-a-surface-key", lease: leaseOf(3), anchor: "release" }),
    ).toThrow();
    // 标记面同样 fail-closed：未注册键的标记是 wiring bug，显性化。
    expect(() => registry.markProtectedDataDelivered(foreignKey)).toThrow();

    // 注册表未被污染：计划仍只含自有实例/自有键。
    const plan = registry.planOptOutRevocation();
    expect(plan.actions).toEqual([{ kind: "dispose", surfaceKey: ownKey, lease: leaseOf(1) }]);
    expect(plan.retentionKeysToClear).toEqual([ownKey]);
  });

  it("同键换租约（正常替换路径的注册面）：计划只针对当前租约；旧租约的标记不转移到新租约", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "workspace" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "replace" });
    registry.markProtectedDataDelivered(key); // 标记落在当前租约（leaseOf(1)）。
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(2), anchor: "replace" }); // 替换入册。

    const plan = registry.planOptOutRevocation();
    // 新租约未收到过受保护数据 → best-effort；旧租约不再是 live 实例（替换路径已处置）。
    expect(plan.actions).toEqual([
      { kind: "best_effort_event", surfaceKey: key, lease: leaseOf(2) },
    ]);
    expect(plan.retentionKeysToClear).toEqual([key]);
  });

  it("多会话多表面：计划覆盖全部标记 live 实例（注册序）与全部自有键", () => {
    const registry = createPayswapSurfaceContentRegistry();
    const ws1Panel = surfaceKeyOf({ surfaceId: "workspace" });
    const ws1Evidence = surfaceKeyOf({ surfaceId: "evidence" });
    const ws2Panel = surfaceKeyOf({ surfaceId: "workspace", sessionId: "session-2" });
    const closedRoute = surfaceKeyOf({ surfaceId: "route-plan", sessionId: "session-2" });

    registry.registerInstance({ surfaceKey: ws1Panel, lease: leaseOf(1), anchor: "replace" });
    registry.registerInstance({ surfaceKey: ws1Evidence, lease: leaseOf(2), anchor: "release" });
    registry.registerInstance({ surfaceKey: ws2Panel, lease: leaseOf(3), anchor: "release" });
    registry.registerInstance({ surfaceKey: closedRoute, lease: leaseOf(4), anchor: "release" });
    registry.markProtectedDataDelivered(ws1Panel);
    registry.markProtectedDataDelivered(ws2Panel);
    registry.retireInstance(closedRoute);

    const plan = registry.planOptOutRevocation();
    expect(plan.actions).toEqual([
      { kind: "dispose_and_replace", surfaceKey: ws1Panel, lease: leaseOf(1) },
      { kind: "best_effort_event", surfaceKey: ws1Evidence, lease: leaseOf(2) },
      { kind: "dispose", surfaceKey: ws2Panel, lease: leaseOf(3) },
    ]);
    expect(plan.retentionKeysToClear).toEqual([ws1Panel, ws1Evidence, ws2Panel, closedRoute]);
  });
});

// ---------------------------------------------------------------------------
// 法则级 D：撤销执行器 —— 有界拆除 / 新鲜替换 / 恰自有键清除（§2.3 item 1 执行纪律）
// ---------------------------------------------------------------------------

/**
 * 可观测 deps：调用序、清除记录、手动守护计时器。fake setTimer 把回调存进 timers ——
 * fireNextTimer 触发最早一个未触发/未取消的守护窗（窗口到期语义）。
 */
function createRevocationDeps(input: {
  teardown?: (surfaceKey: string) => Promise<void>;
  replacementLease?: (surfaceKey: string, previous: PayswapSurfaceLease) => PayswapSurfaceLease;
} = {}) {
  const calls: string[] = [];
  const clearedFeeds: string[] = [];
  const clearedWidgetStates: string[] = [];
  const bestEffortNotified: string[] = [];
  const timers: Array<{ fired: boolean; fire: () => void }> = [];
  let replacementCounter = 0;

  const deps: PayswapSurfaceRevocationDeps = {
    teardownInstance: ({ surfaceKey }) => {
      calls.push(`teardown:${surfaceKey}`);
      return input.teardown ? input.teardown(surfaceKey) : Promise.resolve();
    },
    createReplacementInstance: ({ surfaceKey }) => {
      calls.push(`replace:${surfaceKey}`);
      replacementCounter += 1;
      return Promise.resolve(
        input.replacementLease
          ? input.replacementLease(surfaceKey, leaseOf(1))
          : {
              sandboxId: `sbx-fresh-${replacementCounter}`,
              initId: 10_000 + replacementCounter,
              runtimeId: `rt-fresh-${replacementCounter}`,
              generation: 1,
              appIdentity: "b".repeat(64),
            },
      );
    },
    clearSurfaceFeed: (surfaceKey) => {
      calls.push(`clearFeed:${surfaceKey}`);
      clearedFeeds.push(surfaceKey);
    },
    clearWidgetState: (surfaceKey) => {
      calls.push(`clearWidgetState:${surfaceKey}`);
      clearedWidgetStates.push(surfaceKey);
    },
    setTimer: (callback) => {
      const timer = { fired: false, fire: () => void callback() };
      timers.push(timer);
      return () => {
        timer.fired = true; // 取消 = 不再可触发。
      };
    },
    teardownGuardMs: 50,
    notifyBestEffortRevocation: (surfaceKey) => {
      bestEffortNotified.push(surfaceKey);
    },
  };

  return {
    deps,
    calls,
    clearedFeeds,
    clearedWidgetStates,
    bestEffortNotified,
    timers,
    /** 触发最早一个未触发的守护计时器（窗口到期）。 */
    fireNextTimer: () => {
      const timer = timers.find((entry) => !entry.fired);
      if (!timer) throw new Error("no pending guard timer");
      timer.fired = true;
      timer.fire();
    },
  };
}

/** 微任务冲刷（串行推进的中间态断言用）。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("payswap surface revocation executor — bounded teardown, fresh replacement, exactly-own-key clearing (§2.3)", () => {
  it("有界拆除：页面永不合作（teardown promise 永不 settle）→ 守护窗到期推进，撤销完成（不依赖页面合作）", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "workspace" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(key);

    const harness = createRevocationDeps({
      teardown: () => new Promise<void>(() => {}), // 永不 settle —— 页面不合作。
    });
    const runPromise = runPayswapSurfaceOptOutRevocation(registry, harness.deps);
    await flushAsync();

    // 守护窗已武装；窗未到期前撤销未完成。
    expect(harness.timers.length).toBe(1);
    harness.fireNextTimer(); // 窗口到期 —— 无页面合作也推进。

    const report = await runPromise;
    expect(report.disposed).toEqual([key]);
    expect(report.retentionCleared).toEqual([key]);
    expect(harness.clearedFeeds).toEqual([key]);
    expect(harness.clearedWidgetStates).toEqual([key]);
  });

  it("页面配合：teardown 即时回包 → 撤销完成（无需等窗耗尽）", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "evidence" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(key);

    const harness = createRevocationDeps(); // 默认 teardown 立即 resolve。
    const report = await runPayswapSurfaceOptOutRevocation(registry, harness.deps);

    expect(report.disposed).toEqual([key]);
    expect(harness.clearedFeeds).toEqual([key]);
    expect(harness.clearedWidgetStates).toEqual([key]);
  });

  it("teardown 拒绝（host 侧异常）→ 撤销照常完成（单实例错误不中止整批）", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "evidence" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(key);

    const harness = createRevocationDeps({
      teardown: () => Promise.reject(new Error("bridge close hung")),
    });
    const report = await runPayswapSurfaceOptOutRevocation(registry, harness.deps);
    expect(report.disposed).toEqual([key]);
    expect(harness.clearedFeeds).toEqual([key]);
  });

  it("替换新鲜性：createReplacementInstance 返回旧 sandboxId → fail-closed 抛错（新页面必须新凭证/新 sandboxId）", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "workspace" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "replace" });
    registry.markProtectedDataDelivered(key);

    const harness = createRevocationDeps({
      // 复用旧租约（同 sandboxId）—— 违反 disposeSandbox 契约的新鲜性要求。
      replacementLease: (_key, previous) => ({ ...previous, initId: previous.initId + 1 }),
    });
    await expect(runPayswapSurfaceOptOutRevocation(registry, harness.deps)).rejects.toThrow();
  });

  it("先 dispose 后替换（顺序）；替换实例入册（后续 opt-out 周期的计划对它有效）", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "workspace" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "replace" });
    registry.markProtectedDataDelivered(key);

    const harness = createRevocationDeps();
    const report = await runPayswapSurfaceOptOutRevocation(registry, harness.deps);

    expect(report.disposed).toEqual([key]);
    expect(report.replaced).toEqual([key]);
    // 顺序：teardown 先于 replace。
    const teardownIndex = harness.calls.indexOf(`teardown:${key}`);
    const replaceIndex = harness.calls.indexOf(`replace:${key}`);
    expect(teardownIndex).toBeGreaterThanOrEqual(0);
    expect(replaceIndex).toBeGreaterThan(teardownIndex);
    // 替换实例已入册：后续计划对它生效（未标记 → best-effort）。
    const nextPlan = registry.planOptOutRevocation();
    expect(nextPlan.actions).toHaveLength(1);
    expect(nextPlan.actions[0]!.kind).toBe("best_effort_event");
    expect(nextPlan.actions[0]!.lease.sandboxId).not.toBe(leaseOf(1).sandboxId);
    expect(nextPlan.retentionKeysToClear).toEqual([key]);
  });

  it("retention 清除恰按计划键集：两 store 都清、恰等于 retentionKeysToClear", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const live = surfaceKeyOf({ surfaceId: "workspace" });
    const closed = surfaceKeyOf({ surfaceId: "evidence" });
    registry.registerInstance({ surfaceKey: live, lease: leaseOf(1), anchor: "release" });
    registry.markProtectedDataDelivered(live);
    registry.registerInstance({ surfaceKey: closed, lease: leaseOf(2), anchor: "release" });
    registry.retireInstance(closed);

    const harness = createRevocationDeps();
    const report = await runPayswapSurfaceOptOutRevocation(registry, harness.deps);

    expect(report.retentionCleared).toEqual([live, closed]);
    expect(harness.clearedFeeds).toEqual([live, closed]);
    expect(harness.clearedWidgetStates).toEqual([live, closed]);
    // 恰自有键：清除集 = 计划键集，无重复、无任何其它键（外来键在注册面已被拒）。
    expect(new Set(harness.clearedFeeds).size).toBe(harness.clearedFeeds.length);
  });

  it("未标记实例：teardown 不被调用；best-effort 通知发出（§2.3 item 5）", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const key = surfaceKeyOf({ surfaceId: "route-plan" });
    registry.registerInstance({ surfaceKey: key, lease: leaseOf(1), anchor: "release" });

    const harness = createRevocationDeps();
    const report = await runPayswapSurfaceOptOutRevocation(registry, harness.deps);

    expect(report.disposed).toEqual([]);
    expect(harness.calls.filter((call) => call.startsWith("teardown:"))).toEqual([]);
    expect(harness.bestEffortNotified).toEqual([key]);
    // best-effort 面：renderer 保留照清（重开从空开始）。
    expect(harness.clearedFeeds).toEqual([key]);
  });

  it("串行有界（多标记实例）：逐实例推进 —— 每个守护窗到期才前进到下一实例", async () => {
    const registry = createPayswapSurfaceContentRegistry();
    const keyA = surfaceKeyOf({ surfaceId: "workspace" });
    const keyB = surfaceKeyOf({ surfaceId: "evidence" });
    registry.registerInstance({ surfaceKey: keyA, lease: leaseOf(1), anchor: "release" });
    registry.registerInstance({ surfaceKey: keyB, lease: leaseOf(2), anchor: "release" });
    registry.markProtectedDataDelivered(keyA);
    registry.markProtectedDataDelivered(keyB);

    const harness = createRevocationDeps({
      teardown: () => new Promise<void>(() => {}), // 全部不合作。
    });
    const runPromise = runPayswapSurfaceOptOutRevocation(registry, harness.deps);
    await flushAsync();

    // 串行：第一个实例的守护窗武装时，第二个还未开始。
    expect(harness.timers.length).toBe(1);
    expect(harness.calls).toEqual([`teardown:${keyA}`]);
    harness.fireNextTimer();
    await flushAsync();

    // 第一实例推进后，第二实例的拆除才开始、其守护窗武装。
    expect(harness.calls).toEqual([`teardown:${keyA}`, `teardown:${keyB}`]);
    expect(harness.timers.length).toBe(2);
    harness.fireNextTimer();

    const report = await runPromise;
    expect(report.disposed).toEqual([keyA, keyB]);
    expect(report.retentionCleared).toEqual([keyA, keyB]);
  });
});

// ---------------------------------------------------------------------------
// 发现边界：S 系投影 —— S0b 零运行时组件 / S1 delta 等价 / S2 声明面零增长 / T6（§2）
// ---------------------------------------------------------------------------

const PAYSWAP_PLUGIN_ID = `payswap@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const GATEWAY_SERVER_KEY = "plugin:payswap:gateway";
const CONTROL_PLUGIN_ID = "e2e-control-mcp@inline";
const CONTROL_SERVER_KEY = "plugin:e2e-control-mcp:control-server";

/** 两份发现产物之间的「启用增量」（按种类分列 —— delta 等价断言的输入）。 */
function discoveryDelta(before: PluginLoadOutcome, after: PluginLoadOutcome) {
  const surfacesOf = (outcome: PluginLoadOutcome) =>
    listPluginUiSurfacesFromPlugins(outcome.plugins).map((surface) => `${surface.pluginId}#${surface.id}`);
  return {
    addedMcpServerKeys: Object.keys(after.mcpServers).filter((key) => !(key in before.mcpServers)),
    addedHookEvents: Object.keys(after.hooks).filter(
      (event) => before.hooks[event as keyof typeof before.hooks] === undefined,
    ),
    addedCommandRoots: after.commandRoots.filter(
      (root) => !before.commandRoots.some((other) => other.path === root.path),
    ),
    addedSkillRoots: after.skillRoots.filter(
      (root) => !before.skillRoots.some((other) => other.path === root.path),
    ),
    addedSurfaces: surfacesOf(after).filter((surface) => !surfacesOf(before).includes(surface)),
    addedDiagnostics: after.diagnostics.length - before.diagnostics.length,
  };
}

describe("payswap S-series projections — discovery boundary (§2 / §2.2 T1/T4/T6)", () => {
  let storageRoot: string;
  let workspace: string;
  let controlRoot: string;

  beforeAll(async () => {
    // 真实官方插件 seed（launch-path 同款纪律：真实构建产物 + 官方缓存管线）。
    ensurePayswapPluginDist();
    storageRoot = await mkdtemp(join(tmpdir(), "payswap-surface-storage-"));
    workspace = await mkdtemp(join(tmpdir(), "payswap-surface-workspace-"));
    resolveOfficialPluginRoots({ storageRoot });

    // 对照插件（§2 测试预言的 control plugin）：单 stdio MCP server + 单 surface 声明
    // —— 与 payswap 同组件形状（E1 发现边界 fixture 的同款布局纪律）。
    controlRoot = join(storageRoot, "e2e-control-mcp");
    await mkdir(join(controlRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(controlRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: "e2e-control-mcp",
        version: "0.0.0",
        mcpServers: {
          "control-server": {
            type: "stdio",
            command: "node",
            args: ["${ZCODE_PLUGIN_ROOT}/dist/server.mjs"],
          },
        },
        ui: {
          surfaces: [
            {
              id: "control-panel",
              title: "Control Panel",
              server: "control-server",
              resourceUri: "ui://control/panel.html",
              availability: "session",
            },
          ],
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  });

  function discover(input: { payswap: "disabled" | "s1" | "s2"; control: boolean }): PluginLoadOutcome {
    // 显式布尔（dirs 插件缺省即启用 —— 对照增量必须显式关掉基线态；官方缓存插件缺省
    // 即禁用，payswap 同样显式化）。
    const enabledPlugins: Record<string, boolean> = {
      [CONTROL_PLUGIN_ID]: input.control,
      [PAYSWAP_PLUGIN_ID]: input.payswap !== "disabled",
    };
    const options: Record<string, Record<string, unknown>> = {};
    if (input.payswap !== "disabled") {
      options[PAYSWAP_PLUGIN_ID] = { financialWorkspace: input.payswap === "s2" };
    }
    return discoverNodePluginsSync({
      config: {
        dirs: [controlRoot],
        enabled: true,
        enabledPlugins,
        extraKnownMarketplaces: {},
        options,
        suppressedBuiltins: [],
      },
      env: {},
      storageRoot,
      workingDirectory: workspace,
    });
  }

  it("S0b：installed-but-disabled → 零运行时组件（mcpServers/hooks/commandRoots/skillRoots/launcher 全无）；metadata 保留（管理页展示连续性）", () => {
    const outcome = discover({ payswap: "disabled", control: false });
    const plugin = outcome.plugins.find((entry) => entry.id === PAYSWAP_PLUGIN_ID);
    expect(plugin).toBeDefined();
    expect(plugin?.enabled).toBe(false);

    // 零运行时组件（emptyComponents 纪律）：无 MCP server、无 hook、无 command、无 skill。
    expect(outcome.mcpServers[GATEWAY_SERVER_KEY]).toBeUndefined();
    expect(outcome.hooks).toEqual({});
    expect(outcome.commandRoots).toEqual([]);
    expect(outcome.skillRoots).toEqual([]);

    // launcher 面不含 payswap（listUiSurfaces 只按 enabled 过滤）。
    const surfaces = listPluginUiSurfacesFromPlugins(outcome.plugins);
    expect(surfaces.map((surface) => surface.pluginId)).not.toContain(PAYSWAP_PLUGIN_ID);

    // metadata 保留（管理页展示连续性：声明解析仍在 metadata 里 —— 上游
    // plugin-ui-surfaces 的源注释纪律）。
    expect(plugin?.uiSurfaces).toHaveLength(3);
    expect(plugin?.userConfig?.financialWorkspace).toMatchObject({ type: "boolean", default: false });
  });

  it("S1 delta 恰为标准启用增量：ΔmcpServers=+1(gateway)、Δsurfaces=+3(自有)；hooks/commands/skills/diagnostics 零增量", () => {
    const before = discover({ payswap: "disabled", control: false });
    const after = discover({ payswap: "s1", control: false });

    const delta = discoveryDelta(before, after);
    expect(delta.addedMcpServerKeys).toEqual([GATEWAY_SERVER_KEY]);
    expect(delta.addedSurfaces).toHaveLength(3);
    for (const surface of delta.addedSurfaces) {
      expect(surface.startsWith(`${PAYSWAP_PLUGIN_ID}#`)).toBe(true);
    }
    // 超出标准增量集的任何种类 = 失败（§2 测试预言）。
    expect(delta.addedHookEvents).toEqual([]);
    expect(delta.addedCommandRoots).toEqual([]);
    expect(delta.addedSkillRoots).toEqual([]);
    expect(delta.addedDiagnostics).toBe(0);

    // 启用位翻转（metadata 面的增量）。
    const plugin = after.plugins.find((entry) => entry.id === PAYSWAP_PLUGIN_ID);
    expect(plugin?.enabled).toBe(true);
  });

  it("delta 等价（对照插件）：同形状 control 的增量种类与 payswap 完全一致（仅名字参数化）", () => {
    const base = discover({ payswap: "disabled", control: false });
    const payswapDelta = discoveryDelta(base, discover({ payswap: "s1", control: false }));
    const controlDelta = discoveryDelta(base, discover({ payswap: "disabled", control: true }));

    // 增量种类逐一等价：server +1、surface +N（声明数参数化）、其余零。
    expect(controlDelta.addedMcpServerKeys).toEqual([CONTROL_SERVER_KEY]);
    expect(payswapDelta.addedMcpServerKeys).toHaveLength(controlDelta.addedMcpServerKeys.length);
    expect(payswapDelta.addedSurfaces).toHaveLength(3);
    expect(controlDelta.addedSurfaces).toHaveLength(1);
    expect(payswapDelta.addedHookEvents).toEqual(controlDelta.addedHookEvents);
    expect(payswapDelta.addedCommandRoots).toEqual(controlDelta.addedCommandRoots);
    expect(payswapDelta.addedSkillRoots).toEqual(controlDelta.addedSkillRoots);
    expect(payswapDelta.addedDiagnostics).toBe(controlDelta.addedDiagnostics);
  });

  it("S2 声明面零增长：S1→S2 的 surface 声明集不变（opt-in 不新增 chrome；Class-B 卡是 proposal 驱动，非声明）", () => {
    const s1 = discover({ payswap: "s1", control: false });
    const s2 = discover({ payswap: "s2", control: false });
    const delta = discoveryDelta(s1, s2);
    expect(delta.addedMcpServerKeys).toEqual([]);
    expect(delta.addedSurfaces).toEqual([]);
    expect(delta.addedHookEvents).toEqual([]);
    expect(delta.addedCommandRoots).toEqual([]);
    expect(delta.addedSkillRoots).toEqual([]);
    // MCP settings 行不变（同一 server 声明）。
    expect(Object.keys(s2.mcpServers)).toEqual(Object.keys(s1.mcpServers));
  });

  it("T6：userConfig 恰为自有单选项 financialWorkspace（boolean 默认 false）—— 零设置页改造位", () => {
    const outcome = discover({ payswap: "s1", control: false });
    const plugin = outcome.plugins.find((entry) => entry.id === PAYSWAP_PLUGIN_ID);
    expect(plugin).toBeDefined();
    expect(Object.keys(plugin?.userConfig ?? {})).toEqual(["financialWorkspace"]);
    expect(plugin?.userConfig?.financialWorkspace).toMatchObject({ type: "boolean", default: false });
  });

  it("T2/T3 会话生命周期（解析边界）：enabled 翻转即时反映在后续解析的 launcher 面（config 变更 → 新解析新状态）", () => {
    // 「Changes apply to new sessions」—— 每次解析是一份会话快照；翻转后新解析即新状态。
    const surfacesOf = (outcome: PluginLoadOutcome) =>
      listPluginUiSurfacesFromPlugins(outcome.plugins)
        .filter((surface) => surface.pluginId === PAYSWAP_PLUGIN_ID)
        .map((surface) => surface.id)
        .sort();

    expect(surfacesOf(discover({ payswap: "s2", control: false }))).toEqual([
      "evidence",
      "route-plan",
      "workspace",
    ]);
    // 禁用（S2→S0b / T4）：后续解析（新会话）不再列出。
    expect(surfacesOf(discover({ payswap: "disabled", control: false }))).toEqual([]);
    // 重新启用未 opt-in（S1 / T1）：后续解析照常列出（标准启用增量）。
    expect(surfacesOf(discover({ payswap: "s1", control: false }))).toEqual([
      "evidence",
      "route-plan",
      "workspace",
    ]);
  });
});
