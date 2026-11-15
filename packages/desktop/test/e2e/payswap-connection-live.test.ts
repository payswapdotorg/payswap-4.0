import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "./helpers/desktop-app.js";
import { sel } from "./helpers/selectors.js";
import { skipOccupationOnboardingIfPresent } from "./helpers/occupation-onboarding.js";

/**
 * P2 live E2E 验收臂 —— 真实 Stripe 受限只读键经真实连接 UI 的完整旅程
 * （roadmap P2 行「a real Stripe account connects via the platform shell」
 * 条款的 live 证明；PR #33 登记的 E2E live spec 的仓控重建）。
 *
 * 与 `payswap-connection-ui.test.ts`（CI 电池臂）的关系：
 * - CI 臂用合成假键 + 回放隔离网络（--network none），refresh 闭集三结局皆
 *   lawful —— 那是回归证明；本臂用**真实受限只读键 + 真实 api.stripe.com
 *   网络**，断言**收敛到必需结局**（stronger-than-CI）：connect 必须
 *   connected、refresh 必须 verified、revoke 必须 revoked。任何闭集其它
 *   结局（存储 typed 拒绝 / read_back_unavailable / expired）在本臂 = 失败
 *   （真实键 + 存储可用环境里它们不是 lawful 结局，是缺陷）。
 *
 * 环境门（env-gated；无键环境诚实跳过 —— 与存储腿同纪律）：
 * - `ZCODE_E2E_STRIPE_LIVE_KEY`：真实受限只读测试键（rk_test_*；Read on
 *   Account/Balance/Charges/Customers/Disputes —— 恰为 P2 读面）。缺席 →
 *   全部 it 诚实 skip（CI 电池不含本 spec，本地/VM live 跑才需要它）。
 * - `ZCODE_E2E_KEYRING`：本臂只在存储可用环境有意义（真实 OS 钥匙串后端）。
 *   显式 `absent` → skip（该腿的存储面由 CI 臂的 fallback-only 分支证明）。
 *   `gnome-libsecret`（或本地 discover 命中真实钥匙串）→ connect 落地
 *   typed 存储 refusal = **失败**（与 CI 臂 gnome-libsecret 腿同一断言方向：
 *   存储可用环境不得静默退化成 fallback-only）。
 *
 * 秘密纪律：真实键永不进断言消息/日志（断言失败也只报类别不报值）；本文件
 * 永不含键字面量；at-rest 检查按「含 connectionId、不含键明文」的法则执行。
 *
 * ⚠️ 不要把本 spec 加进 CI 电池的 E2E_SPEC 清单：它需要真实网络与真实键，
 * 与电池的回放隔离（--network none）不相容。它的执行环境是 live 验收 VM
 * （scripts/payswap/live/vm-run-live.sh —— E2B 配方与文档见
 * docs/payswap/p2/live-acceptance-evidence.md）。
 */

const TID_SECTION = "payswap-connections-section";
const TID_SECRET_INPUT = "payswap-connect-secret";
const TID_DISPLAY_NAME_INPUT = "payswap-connect-display-name";
const TID_SUBMIT = "payswap-connect-submit";
const TID_NOTICE = "payswap-connection-notice";
const TID_ROW = "payswap-connection-row";
const TID_ROW_REFRESH = "payswap-connection-refresh";
const TID_ROW_REVOKE = "payswap-connection-revoke";

const STORAGE_REFUSAL_CODE = "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE";
const LIVE_KEY = process.env.ZCODE_E2E_STRIPE_LIVE_KEY?.trim() || null;
const KEYRING_EXPECTATION = process.env.ZCODE_E2E_KEYRING ?? "discover";
const LIVE_DISPLAY_NAME = "P2 Live E2E";

const paths = getE2EAppDataPaths();
const CONNECTIONS_STORE_FILE = join(paths.appDataDir, "payswap-connections.json");
const CREDENTIALS_STORE_FILE = join(paths.appDataDir, "credentials.json");

interface RpcResponse {
  ok: boolean;
  code?: string;
  op?: string;
  result?: unknown;
}

interface NoticeState {
  key: string;
  code: string;
  tone: string;
}

async function invokeFromRenderer<T = RpcResponse>(payload: unknown): Promise<T> {
  return browser.execute(
    (bridgePayload: unknown) =>
      (
        window as {
          zcode?: {
            payswapConnectionRpc?: (input: unknown) => Promise<unknown>;
          };
        }
      ).zcode?.payswapConnectionRpc?.(bridgePayload),
    payload,
  ) as Promise<T>;
}

async function clickVisibleTestId(currentTestId: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const result = (await browser.execute(
        (targetTestId: string) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`);
          if (!element) return false;
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (element.getClientRects().length === 0) return false;
          element.click();
          return true;
        },
        currentTestId,
      )) as boolean;
      return result;
    },
    { timeout: 15_000, timeoutMsg },
  );
}

async function openPayswapSettingsSection(): Promise<void> {
  await browser.keys("Escape");
  await browser.pause(150);
  const settingsPage = $(sel(TID_SETTINGS_PAGE));
  if (!(await settingsPage.isDisplayed().catch(() => false))) {
    await clickVisibleTestId(TID_TASK_SETTINGS_BUTTON, "没有找到设置入口按钮");
    await settingsPage.waitForDisplayed({ timeout: 15_000 });
  }
  await clickVisibleTestId(
    testId(TID_SETTINGS_SECTION_NAV, "payswap"),
    "设置页没有支付连接分区入口",
  );
  await $(sel(TID_SECTION)).waitForDisplayed({ timeout: 15_000 });
}

async function submitLiveConnect(): Promise<void> {
  if (!LIVE_KEY) throw new Error("live 键缺席（before 钩子应已跳过）");
  await $(sel(TID_SECRET_INPUT)).waitForDisplayed({ timeout: 10_000 });
  await $(sel(TID_SECRET_INPUT)).setValue(LIVE_KEY);
  await $(sel(TID_DISPLAY_NAME_INPUT)).setValue(LIVE_DISPLAY_NAME);
  await clickVisibleTestId(TID_SUBMIT, "没有找到连接提交按钮");
}

async function waitForNotice(
  predicate: (notice: NoticeState) => boolean,
  timeoutMsg: string,
): Promise<NoticeState> {
  await browser.waitUntil(
    async () => {
      const notice = $(sel(TID_NOTICE));
      if (!(await notice.isExisting().catch(() => false))) return false;
      const candidate: NoticeState = {
        key: (await notice.getAttribute("data-notice-key")) ?? "",
        code: (await notice.getAttribute("data-notice-code")) ?? "",
        tone: (await notice.getAttribute("data-notice-tone")) ?? "",
      };
      return predicate(candidate);
    },
    { timeout: 30_000, timeoutMsg },
  );
  const notice = $(sel(TID_NOTICE));
  return {
    key: (await notice.getAttribute("data-notice-key")) ?? "",
    code: (await notice.getAttribute("data-notice-code")) ?? "",
    tone: (await notice.getAttribute("data-notice-tone")) ?? "",
  };
}

async function rowIds(): Promise<string[]> {
  const rows = await $$(`[data-testid="${TID_ROW}"]`);
  const ids: string[] = [];
  for (const row of rows) {
    ids.push((await row.getAttribute("data-connection-id")) ?? "");
  }
  return ids;
}

async function firstConnectionRowId(): Promise<string> {
  const ids = await rowIds();
  const first = ids[0];
  if (!first) throw new Error("连接列表应至少有一行");
  return first;
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * at-rest 秘密检查（失败消息零键材料 —— 真实键永不进日志/断言 diff）。
 * 返回 at-rest 材料以便调用方叠加结构性断言（含 connectionId 等）。
 */
function assertNoLiveSecret(material: string | null, label: string): void {
  if (material === null || !LIVE_KEY) return;
  if (material.includes(LIVE_KEY)) {
    throw new Error(
      `${label}: at-rest 材料含真实键明文（已扣留具体值 —— 法则：记录含 connectionId、凭据 store 为密文，永不落明文）`,
    );
  }
}

describe("P2 live E2E 验收臂（真实受限只读键 × 真实连接 UI × 真实 api.stripe.com）", () => {
  before(async function () {
    this.timeout(180_000);
    if (!LIVE_KEY) {
      // 诚实跳过：live 键缺席（CI 电池不含本 spec；本地默认跑 = 无 live 证明可做）。
      this.skip();
      return;
    }
    if (KEYRING_EXPECTATION === "absent") {
      // absent 腿无 OS 钥匙串后端 —— live 证明必须在存储可用环境执行。
      this.skip();
      return;
    }
    await waitForDefaultWorkspaceReady(120_000);
    await skipOccupationOnboardingIfPresent();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("live connect：真实键经真实连接 UI → connected + at-rest 双 store 无键明文", async () => {
    await openPayswapSettingsSection();

    // 通道在场性（与 CI 臂同款前置）：list 直达。
    const listed = await invokeFromRenderer({ op: "list" });
    expect(listed.ok).toBe(true);

    await submitLiveConnect();

    const notice = await waitForNotice(
      (candidate) =>
        candidate.key === "payswap.connections.result.connected" ||
        (candidate.key === "payswap.connections.refusal.secure_storage_unavailable" &&
          candidate.code === STORAGE_REFUSAL_CODE),
      "live connect 应呈现 connected（存储 typed 拒绝 = 存储可用环境的失败）",
    );

    if (notice.code === STORAGE_REFUSAL_CODE) {
      // stronger-than-CI：真实键 + 本臂的存储期望下，fallback-only 拒绝不是 lawful
      // 结局 —— 存储可用环境（gnome-libsecret 腿/本地真实钥匙串）不得静默退化。
      throw new Error(
        `live connect 呈现 ${STORAGE_REFUSAL_CODE} —— Electron 后端选择或 Secret Service 在该环境损坏（live 臂要求真实 OS 钥匙串后端；见 scripts/payswap/live/vm-run-live.sh 的腿环境）`,
      );
    }
    expect(notice.tone).toBe("positive");

    // 恰一行 connected/test；行内 mode 徽章（UI 契约：行级只有 id/status）。
    await browser.waitUntil(
      async () => (await rowIds()).length === 1,
      { timeout: 15_000, timeoutMsg: "live connected 后列表应恰有一行" },
    );
    const connectionId = await firstConnectionRowId();
    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    expect(await row.getAttribute("data-connection-status")).toBe("connected");
    const mode = await $(
      `[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"] [data-testid="payswap-connection-mode"]`,
    ).getAttribute("data-mode");
    expect(mode).toBe("test");

    // at-rest：连接记录含 connectionId、无键明文；凭据 store 密文含 connectionId、无键明文。
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connections).not.toBeNull();
    expect(connections).toContain(connectionId);
    assertNoLiveSecret(connections, "connections store");
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    expect(credentials).not.toBeNull();
    expect(credentials).toContain(connectionId);
    assertNoLiveSecret(credentials, "credentials store");
  });

  it("live refresh：真实 provider 读回（api.stripe.com）→ verified；状态保持 connected", async () => {
    const connectionId = await firstConnectionRowId();
    await clickVisibleTestId(TID_ROW_REFRESH, "没有找到刷新证据按钮");

    // stronger-than-CI：真实网络 + 真实受限键下，闭集收敛到 verified ——
    // read_back_unavailable（传输/键故障）与 expired（401）都是本臂的失败。
    const notice = await waitForNotice(
      (candidate) =>
        candidate.key === "payswap.connections.result.verified" ||
        candidate.key === "payswap.connections.refusal.read_back_unavailable" ||
        candidate.key === "payswap.connections.result.expired" ||
        candidate.key === "payswap.connections.refusal.secure_storage_unavailable",
      "live refresh 应呈现结局（verified 为唯一 lawful 结局，其余即刻失败）",
    );
    if (notice.key !== "payswap.connections.result.verified") {
      throw new Error(
        `live refresh 呈现 ${notice.key}（${notice.code || "无 code"}）—— 真实键 + 真实网络下唯一 lawful 结局是 verified；请检查键权限（Read on Account/Balance/Charges/Customers/Disputes）与 api.stripe.com 可达性`,
      );
    }

    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    expect(await row.getAttribute("data-connection-status")).toBe("connected");
  });

  it("live revoke：终态 revoked + at-rest 本地秘密删除（记录仍在）", async () => {
    const connectionId = await firstConnectionRowId();
    await clickVisibleTestId(TID_ROW_REVOKE, "没有找到撤销按钮");

    const notice = await waitForNotice(
      (candidate) => candidate.key === "payswap.connections.result.revoked",
      "live revoke 应呈现终态（muted）",
    );
    expect(notice.tone).toBe("muted");

    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-status")) === "revoked",
      { timeout: 15_000, timeoutMsg: "live revoke 后行状态应为 revoked" },
    );

    // at-rest：delete-local-only —— 凭据 store 中该连接的 PSP 键已删除；记录仍在（终态）。
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    if (credentials !== null) {
      expect(credentials).not.toContain(connectionId);
      assertNoLiveSecret(credentials, "credentials store (post-revoke)");
    }
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connections).toContain(connectionId);
    expect(connections).toContain('"revoked"');
    assertNoLiveSecret(connections, "connections store (post-revoke)");
  });
});
