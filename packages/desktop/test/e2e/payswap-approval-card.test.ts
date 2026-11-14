import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  type PayswapAuthorizationTuple,
} from "@zcode/shared/payswap";
import { clearAppData, getE2EAppDataPaths, waitForDefaultWorkspaceReady } from "./helpers/desktop-app.js";

/**
 * P1.8 desktop Browser E2E —— D12.7 真实窗口臂（ADR-12：「the real IPC mapping, the
 * production trusted-origin value, and N18's full plugin-handle teardown arm arrive with
 * the surface work」；本次 run 同时携带 ipcMain 注册进 desktop main 入口、renderer
 * Class-B 授权卡组件与真实 financialMode reader 的接线证明）。
 *
 * 覆盖行（法则级行已在 bootstrap payswap-approval-desktop.test.ts；本套件是
 * 真实窗口/真实 ipcMain/真实 renderer 的运行时证明）：
 * 1. 通道注册 fail-closed：未知 proposal 的真实 renderer invoke → typed proposal_unknown；
 *    畸形 payload → not_an_approval_event。
 * 2. T3 live flip：config financialWorkspace=false → issueProposal 拒发
 *    financial_mode_inactive 且无卡；翻转 config（真实文件、无重启）→ 发卡成功
 *    —— fresh read 证明（live，非构造期快照）。
 * 3. 真实卡渲染：卡出现（host-derived summary/amount）→ approve 点击经真实 IPC →
 *    approved + grant 铸造（main 侧观察）+ 卡消失。
 * 4. N15 一次性 challenge：approve 后重放同一事件 → proposal_not_pending，grant 恰一枚。
 * 5. deny 臂：deny → denied、无 grant、卡消失。
 * 6. 错误 secret：secret_mismatch（challenge 不因错误尝试被消费 —— 卡仍在）。
 * 7. 伪造发送者（真实第二窗口 + 伪造 preload 暴露 invoke）：携带合法 payload 的
 *    跨 webContents 解析 → typed sender_rejected；真实窗口随后 approve 仍成功。
 * 8. T7 item 3 卡面：revokePendingProposals → pending 卡从 renderer 消失；
 *    事后 approve → proposal_not_pending。
 */

const FORGED_PRELOAD_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "payswap-forged-invoke.cjs",
);

const TID_CARD = "payswap-authorization-card";
const TID_CARD_SUMMARY = "payswap-card-summary";
const TID_CARD_AMOUNT = "payswap-card-amount";
const TID_CARD_APPROVE = "payswap-card-approve";
const TID_CARD_DENY = "payswap-card-deny";

interface IssueInput {
  tuple: PayswapAuthorizationTuple;
  workspaceId: string;
  target: { kind: "card_instance"; webContentsId: number; principal: string };
}

type IssueVerdict =
  | { status: "issued"; proposalId: string; cardPayload: { summary: string; challenge: { challengeId: string; secret: string }; authorization: { amount: { value: string; currency: string } } } }
  | { status: "issue_refused"; reason: string };

interface ResolutionVerdict {
  status: string;
  reason?: string;
  grant?: { authorizationId: string };
}

/**
 * webdriverio 9 断言收窄辅助：expect().toBe() 无法收窄 IssueVerdict 联合，
 * 集中一处 assertion 签名（asserts verdict is ...），调用点语句本身即完成
 * 收窄，使后续 proposalId/cardPayload 访问通过 typecheck。
 * 断言语义等价（refuse 即测试失败），零行为变化。
 */
function assertIssued(
  verdict: IssueVerdict,
): asserts verdict is Extract<IssueVerdict, { status: "issued" }> {
  if (verdict.status !== "issued") {
    throw new Error(
      `expected proposal to be issued, got refusal: ${verdict.reason}`,
    );
  }
}

function buildTuple(legId: string, value: string): PayswapAuthorizationTuple {
  const now = Date.now();
  return {
    principal: "e2e-operator",
    source: { connectionId: "conn_e2e", accountId: "acct_e2e" },
    recipient: { recipientId: "rcp_e2e", evidenceRef: "evd_e2e_1" },
    amount: { value, currency: "USD" },
    purpose: "payout",
    route: {
      legs: [
        {
          legId,
          provider: "stripe",
          recipientId: "rcp_e2e",
          amount: value,
          currency: "USD",
          idempotencyKey: `idem_${legId}`,
        },
      ],
    },
    fees: { maxTotalFees: "0.50" },
    expiresAt: now + 10 * 60_000,
  };
}

async function payswapBridge<T>(command: string, arg?: unknown): Promise<T> {
  return browser.electron.execute(
    async (
      electron,
      cmd: string,
      cmdArg: unknown,
      channelName: string,
    ): Promise<unknown> => {
      const registration = (
        globalThis as {
          __zcodePayswapDesktopApprovalE2E?: {
            host: {
              issueProposal(input: unknown): unknown;
              revokePendingProposals(): unknown;
              proposals(): unknown;
              grants(): unknown;
              trustedAppOrigins(): { has(value: string): boolean };
            };
          };
        }
      ).__zcodePayswapDesktopApprovalE2E;
      if (!registration) {
        throw new Error("payswap desktop approval E2E bridge not installed");
      }
      const mainWindow = electron.BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes("/renderer/index.html"),
      );
      switch (cmd) {
        case "status":
          return {
            installed: true,
            mainWebContentsId: mainWindow?.webContents.id ?? null,
            channelRegistered: electron.ipcMain
              .eventNames()
              .some((name) => String(name) === channelName),
          };
        case "issue":
          return registration.host.issueProposal(cmdArg);
        case "revoke":
          return registration.host.revokePendingProposals();
        case "proposals":
          return registration.host.proposals();
        case "grants":
          return registration.host.grants();
        default:
          throw new Error(`unknown payswap bridge command: ${cmd}`);
      }
    },
    command,
    arg,
    PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
  ) as Promise<T>;
}

async function invokeFromRenderer<T>(payload: unknown): Promise<T> {
  return browser.execute(
    (bridgePayload: unknown) =>
      (
        window as {
          zcode?: {
            payswapResolveApproval?: (input: unknown) => Promise<unknown>;
          };
        }
      ).zcode?.payswapResolveApproval?.(bridgePayload),
    payload,
  ) as Promise<T>;
}

async function readCliConfig(): Promise<Record<string, unknown>> {
  const { storageRoot } = getE2EAppDataPaths();
  const configPath = join(storageRoot, "cli", "config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeCliConfig(config: Record<string, unknown>): Promise<void> {
  const { storageRoot } = getE2EAppDataPaths();
  const configPath = join(storageRoot, "cli", "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function setFinancialWorkspace(active: boolean): Promise<void> {
  const config = await readCliConfig();
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const enabledPlugins = (plugins.enabledPlugins ?? {}) as Record<string, boolean>;
  const options = (plugins.options ?? {}) as Record<string, Record<string, unknown>>;
  enabledPlugins[PAYSWAP_OFFICIAL_PLUGIN_ID] = true;
  options[PAYSWAP_OFFICIAL_PLUGIN_ID] = {
    ...(options[PAYSWAP_OFFICIAL_PLUGIN_ID] ?? {}),
    financialWorkspace: active,
  };
  await writeCliConfig({
    ...config,
    plugins: { ...plugins, enabledPlugins, options },
  });
}

async function waitForCardCount(count: number): Promise<void> {
  await browser.waitUntil(
    async () => {
      const cards = await $$(`[data-testid="${TID_CARD}"]`);
      // webdriverio 9：ElementArray.length 的类型是 Promise<number>。
      return (await cards.length) === count;
    },
    { timeout: 15_000, timeoutMsg: `授权卡数量应变为 ${count}` },
  );
}

async function grantCount(): Promise<number> {
  return (await payswapBridge<unknown[]>("grants")).length;
}

describe("P1.8 D12.7：PaySwap 桌面批准通道真实窗口臂", () => {
  before(async function () {
    // 冷启动 + 延迟静态服务（沙箱 wide-module-tree 缓解）下工作区就绪可超过 60s。
    this.timeout(180_000);
    await waitForDefaultWorkspaceReady(120_000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("通道已注册且 fail-closed：未知 proposal → proposal_unknown；畸形 → not_an_approval_event", async () => {
    const status = await payswapBridge<{
      installed: boolean;
      mainWebContentsId: number | null;
    }>("status");
    expect(status.installed).toBe(true);
    expect(typeof status.mainWebContentsId).toBe("number");

    // 通道注册的证明是解析本身：真实 renderer invoke 能拿到法则的 typed 拒绝。
    const unknown = await invokeFromRenderer<ResolutionVerdict>({
      proposalId: "does-not-exist",
      challengeId: "nope",
      challengeSecret: "nope",
      decision: "approve",
    });
    expect(unknown).toMatchObject({ status: "proposal_unknown" });

    const malformed = await invokeFromRenderer<ResolutionVerdict>({
      totally: "not-an-approval-event",
    });
    expect(malformed).toMatchObject({ status: "not_an_approval_event" });
  });

  it("T3 live flip：非 S2 拒发 financial_mode_inactive；翻转真实 config 后发卡（fresh read）", async () => {
    await setFinancialWorkspace(false);
    const { mainWebContentsId } = await payswapBridge<{ mainWebContentsId: number }>("status");
    const issueInput: IssueInput = {
      tuple: buildTuple("leg-t3", "10.00"),
      workspaceId: "e2e-workspace",
      target: { kind: "card_instance", webContentsId: mainWebContentsId, principal: "e2e-operator" },
    };
    const refused = await payswapBridge<IssueVerdict>("issue", issueInput);
    expect(refused).toMatchObject({ status: "issue_refused", reason: "financial_mode_inactive" });
    await waitForCardCount(0);

    await setFinancialWorkspace(true);
    const issued = await payswapBridge<IssueVerdict>("issue", issueInput);
    assertIssued(issued);
    await waitForCardCount(1);

    // host-derived 内容（§1.6.0：展示值来自 host 的 proposal 记录）。
    const summary = await $(`[data-testid="${TID_CARD_SUMMARY}"]`).getText();
    expect(summary).toContain("10.00");
    expect(summary).toContain("USD");
    const amount = await $(`[data-testid="${TID_CARD_AMOUNT}"]`).getText();
    expect(amount).toContain("10.00");

    // 未批准前无 grant。
    const grantsBefore = await payswapBridge<unknown[]>("grants");
    expect(grantsBefore).toHaveLength(0);

    // approve：真实卡组件 → 真实 IPC → 三检通过 → grant。
    await $(`[data-testid="${TID_CARD_APPROVE}"]`).click();
    await browser.waitUntil(
      async () => (await grantCount()) === 1,
      { timeout: 15_000, timeoutMsg: "approve 后应铸造恰一枚 grant" },
    );
    await waitForCardCount(0);
  });

  it("N15：approve 后重放同一事件 → proposal_not_pending 且 grant 仍恰一枚", async () => {
    const { mainWebContentsId } = await payswapBridge<{ mainWebContentsId: number }>("status");
    const issued = await payswapBridge<IssueVerdict>("issue", {
      tuple: buildTuple("leg-n15", "11.00"),
      workspaceId: "e2e-workspace",
      target: { kind: "card_instance", webContentsId: mainWebContentsId, principal: "e2e-operator" },
    });
    assertIssued(issued);
    await waitForCardCount(1);

    const event = {
      proposalId: issued.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision: "approve" as const,
    };
    const grantsBeforeClick = await grantCount();
    await $(`[data-testid="${TID_CARD_APPROVE}"]`).click();
    await browser.waitUntil(
      async () => (await grantCount()) === grantsBeforeClick + 1,
      { timeout: 15_000, timeoutMsg: "approve 后 grant 应已铸造" },
    );

    const replay = await invokeFromRenderer<ResolutionVerdict>(event);
    expect(replay).toMatchObject({ status: "proposal_not_pending" });
    expect(await grantCount()).toBe(grantsBeforeClick + 1);
  });

  it("deny 臂：denied、无 grant、卡消失；错误 secret → secret_mismatch 且卡保留", async () => {
    const { mainWebContentsId } = await payswapBridge<{ mainWebContentsId: number }>("status");
    const issued = await payswapBridge<IssueVerdict>("issue", {
      tuple: buildTuple("leg-deny", "12.00"),
      workspaceId: "e2e-workspace",
      target: { kind: "card_instance", webContentsId: mainWebContentsId, principal: "e2e-operator" },
    });
    assertIssued(issued);
    await waitForCardCount(1);

    // 错误 secret：typed 拒绝；卡仍在（challenge 未被错误尝试消费）。
    const wrongSecret = await invokeFromRenderer<ResolutionVerdict>({
      proposalId: issued.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: "0".repeat(64),
      decision: "deny",
    });
    expect(wrongSecret).toMatchObject({ status: "secret_mismatch" });
    await waitForCardCount(1);

    await $(`[data-testid="${TID_CARD_DENY}"]`).click();
    const grantsBeforeDeny = await grantCount();
    await browser.waitUntil(
      async () => {
        const proposals = await payswapBridge<{ status: string; proposalId: string }[]>("proposals");
        return proposals.some((p) => p.proposalId === issued.proposalId && p.status === "denied");
      },
      { timeout: 15_000, timeoutMsg: "deny 后 proposal 应为 denied" },
    );
    await waitForCardCount(0);
    expect(await grantCount()).toBe(grantsBeforeDeny);
  });

  it("伪造发送者：真实第二窗口携带合法 payload → sender_rejected；真窗口随后 approve 成功", async () => {
    const { mainWebContentsId } = await payswapBridge<{ mainWebContentsId: number }>("status");
    const issued = await payswapBridge<IssueVerdict>("issue", {
      tuple: buildTuple("leg-forge", "13.00"),
      workspaceId: "e2e-workspace",
      target: { kind: "card_instance", webContentsId: mainWebContentsId, principal: "e2e-operator" },
    });
    assertIssued(issued);
    await waitForCardCount(1);

    const event = {
      proposalId: issued.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision: "approve" as const,
    };
    const forged = await browser.electron.execute(
      async (electron, preloadPath: string, channelName: string, eventJson: string) => {
        const win = new electron.BrowserWindow({
          show: false,
          webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false },
        });
        try {
          await win.loadURL("data:text/html,<title>forged-origin</title>");
          const verdict = await win.webContents.executeJavaScript(
            `window.__payswapForgedInvoke(${JSON.stringify(
              JSON.stringify({ channel: channelName, payload: JSON.parse(eventJson) }),
            )})`,
          );
          return verdict;
        } finally {
          win.destroy();
        }
      },
      FORGED_PRELOAD_PATH,
      PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
      JSON.stringify(event),
    );
    expect(forged).toMatchObject({ status: "sender_rejected" });

    // 伪造解析没有消费 challenge —— 真窗口（期望 webContents + 受信 origin）仍可批准。
    const grantsBeforeApprove = await grantCount();
    await $(`[data-testid="${TID_CARD_APPROVE}"]`).click();
    await browser.waitUntil(
      async () => (await grantCount()) === grantsBeforeApprove + 1,
      { timeout: 15_000, timeoutMsg: "真实窗口 approve 应铸造 grant" },
    );
    await waitForCardCount(0);
  });

  it("T7 item 3 卡面：revokePendingProposals → pending 卡消失；事后 approve → proposal_not_pending", async () => {
    const { mainWebContentsId } = await payswapBridge<{ mainWebContentsId: number }>("status");
    const issued = await payswapBridge<IssueVerdict>("issue", {
      tuple: buildTuple("leg-revoke", "14.00"),
      workspaceId: "e2e-workspace",
      target: { kind: "card_instance", webContentsId: mainWebContentsId, principal: "e2e-operator" },
    });
    assertIssued(issued);
    await waitForCardCount(1);

    const revoked = await payswapBridge<{ proposalId: string }[]>("revoke");
    expect(revokeListContains(revoked, issued.proposalId)).toBe(true);
    await waitForCardCount(0);

    const postRevoke = await invokeFromRenderer<ResolutionVerdict>({
      proposalId: issued.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision: "approve",
    });
    expect(postRevoke).toMatchObject({ status: "proposal_not_pending" });
    const grantsBeforeRevokeArm = await grantCount();
    expect(grantsBeforeRevokeArm).toBeGreaterThan(0);
    expect(await grantCount()).toBe(grantsBeforeRevokeArm);
  });
});

function revokeListContains(
  revoked: { proposalId: string }[] | undefined,
  proposalId: string,
): boolean {
  return Array.isArray(revoked) && revoked.some((record) => record.proposalId === proposalId);
}
