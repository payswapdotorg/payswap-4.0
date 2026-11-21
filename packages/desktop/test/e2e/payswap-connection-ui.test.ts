import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "./helpers/desktop-app.js";
import { sel } from "./helpers/selectors.js";
import { skipOccupationOnboardingIfPresent } from "./helpers/occupation-onboarding.js";
import { restartIntoWorkspacePreservingProfile } from "./helpers/model-provider-restart-runtime.js";

/** PSP 键文件名（desktop-payswap pspCredentialKeyStore 的路径 pin；单一事实源在
 *  desktop main —— E2E 侧按契约字面引用，改名时本臂 fail-loud）。 */
const PAYSWAP_PSP_KEY_STORE_FILE_NAME = "payswap-psp-safe-storage-key";

/**
 * P2.2 slice 8 —— 连接流 desktop Browser E2E 臂（ADR-P2-2 Decision 4 的入口接线
 * 证明；D12.7 纪律「入口接线随活的窗口证明」的 run 半；Gate E2 的 E2E 条款
 * 「connecting an account with only the fallback available refuses; typed error
 * surfaced in the connection UI」）。
 *
 * 覆盖行（法则级行已在 bootstrap/desktop 工程电池；本套件是真实窗口/真实
 * ipcMain/真实 renderer UI/真实 store 文件的运行时证明）：
 * 1. 分区可达 + 通道注册 fail-closed：真实 renderer 经 preload 面 invoke ——
 *    list 直达（ok:true 数组）；畸形载荷 → ok:false malformed_request（载荷
 *    不达服务）。
 * 2. validation_failed 呈现按 code：格式非法秘密 → notice data-notice-code =
 *    validation_failed；秘密单发清空；列表零行。
 * 3. 首次合法 connect 的闭集结局（环境自适应，双分支各自 lawful）：
 *    - 存储不可用环境（headless Linux safeStorage 缺席 = 「only the fallback
 *      available」）：typed PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE 呈现在连接
 *      UI（Gate E2 E2E 条款本体）；at-rest 无 PSP 密文、无连接记录（拒绝先于
 *      记录写）。后续 happy-path 行 this.skip()（环境事实，诚实跳过）。
 *    - 存储可用环境（真实 Libsecret 后端）：connected → 行 4-7。
 * 4. happy path：连接行（connected/test）+ at-rest 密文检查（记录无明文、
 *    凭据 store 含 connectionId 无明文）。
 * 5. refresh 闭集结局：read_back_unavailable（离线）/ expired（假密钥真 401）/
 *    verified —— 三者皆 lawful；断言 UI 呈现与状态一致性（refused → 状态
 *    不变；expired → 翻牌）。
 * 6. revoke：终态 revoked + at-rest 本地秘密删除（delete-local-only）。
 * 7. Gate E2 行（存储可用环境的确定性臂）：损坏键文件 + 真实重启 → app-ready
 *    预热 fail-safe（解包失败 → 空集 env）→ connect → typed 存储 refusal 呈现
 *    在 UI；at-rest 无新记录/新密文；既有记录仍可列表（readers 诚实，键故障
 *    不吞数据面）。
 *
 * 环境期望标记（P2 架构师评审 2026-11-14 第 4 项）：ZCODE_E2E_KEYRING 由 CI
 * 两腿分别置为 absent / gnome-libsecret（scripts/desktop-e2e-container-entrypoint.sh
 * 提供对应的真实环境）。标记的腿语义是**断言**：
 * - discover（缺省，本地开发）：闭集两支皆 lawful（历史自适应行为）。
 * - absent：行 3 必须命中 fallback-only 拒绝分支（connected = 测试失败 ——
 *   absent 腿里存储不该在场）。
 * - gnome-libsecret：行 3 必须命中 connected（typed 存储 refusal = 测试失败
 *   —— 存储可用腿里 Electron 后端选择/钥匙串损坏要暴露，不能静默退化成
 *   fallback-only）。
 */

const TID_SECTION = "payswap-connections-section";
const TID_SECRET_INPUT = "payswap-connect-secret";
const TID_DISPLAY_NAME_INPUT = "payswap-connect-display-name";
const TID_SUBMIT = "payswap-connect-submit";
const TID_NOTICE = "payswap-connection-notice";
const TID_ROW = "payswap-connection-row";
const TID_ROW_REFRESH = "payswap-connection-refresh";
const TID_ROW_REVOKE = "payswap-connection-revoke";
const TID_LIST_EMPTY = "payswap-connection-list-empty";

const STORAGE_REFUSAL_CODE = "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE";
/** ADR-P2-3 custodian fail-closed 拒绝码（win32 托管缺席的 lawful 闭集结局）。 */
const CUSTODIAN_REFUSAL_CODE = "custodian_unavailable";
/** ADR-P2-3 custodian 架构判定面：win32 + SYSTEM 托管服务端点在场 = 托管保管。 */
const CUSTODIAN_ENDPOINT_FILE = "C:\\ProgramData\\payswap\\custodian-endpoint.json";
const CUSTODIAN_KEY_BLOB_FILE = "C:\\ProgramData\\payswap\\custodian-key.bin";

function custodianBackedAtRest(): boolean {
  return process.platform === "win32" && existsSync(CUSTODIAN_ENDPOINT_FILE);
}
/** 格式合法的假 test 密钥（formatCheck 通过；最终权威是 provider read-back）。 */
const VALID_FORMAT_TEST_SECRET = `sk_test_${"e5f6a7b8".repeat(6)}`;
const INVALID_FORMAT_SECRET = "not-a-stripe-key";

/**
 * 环境期望标记（见文件头「环境期望标记」段）：CI 两腿把它变成断言；本地缺省
 * discover 保持历史自适应闭集。
 */
const KEYRING_EXPECTATION = process.env.ZCODE_E2E_KEYRING ?? "discover";

const paths = getE2EAppDataPaths();
const KEY_STORE_FILE = join(paths.appDataDir, PAYSWAP_PSP_KEY_STORE_FILE_NAME);
const CONNECTIONS_STORE_FILE = join(paths.appDataDir, "payswap-connections.json");
const CREDENTIALS_STORE_FILE = join(paths.appDataDir, "credentials.json");

/** 环境事实登记（行 3 的分支裁决；后续行按它诚实跳过）。 */
let storageUnavailableInEnv = false;

interface RpcResponse {
  ok: boolean;
  code?: string;
  op?: string;
  result?: unknown;
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

async function submitConnect(secret: string, displayName?: string): Promise<void> {
  await $(sel(TID_SECRET_INPUT)).waitForDisplayed({ timeout: 10_000 });
  await $(sel(TID_SECRET_INPUT)).setValue(secret);
  if (displayName !== undefined) {
    await $(sel(TID_DISPLAY_NAME_INPUT)).setValue(displayName);
  }
  await clickVisibleTestId(TID_SUBMIT, "没有找到连接提交按钮");
}

interface NoticeState {
  key: string;
  code: string;
  tone: string;
}

async function waitForNotice(predicate: (notice: NoticeState) => boolean, timeoutMsg: string): Promise<NoticeState> {
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
    { timeout: 20_000, timeoutMsg },
  );
  // waitUntil 成功后重读（闭集判据已满足，此处取最终呈现态）。
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

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function firstConnectionRowId(): Promise<string> {
  const ids = await rowIds();
  const first = ids[0];
  if (!first) throw new Error("连接列表应至少有一行");
  return first;
}

describe("P2.2 连接流 desktop Browser E2E 臂（ADR-P2-2 Decision 4 + Gate E2 UI 条款）", () => {
  before(async function () {
    // 冷启动 + 延迟静态服务下工作区就绪可超过 60s（批准卡臂同款宽限）。
    this.timeout(180_000);
    await waitForDefaultWorkspaceReady(120_000);
    await skipOccupationOnboardingIfPresent();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("分区可达 + 通道注册 fail-closed：list 直达；畸形 → malformed_request", async () => {
    await openPayswapSettingsSection();

    const listed = await invokeFromRenderer({ op: "list" });
    expect(listed.ok).toBe(true);
    expect(Array.isArray(listed.result)).toBe(true);

    const malformed = await invokeFromRenderer({ totally: "not-a-connection-request" });
    expect(malformed.ok).toBe(false);
    expect(malformed.code).toBe("malformed_request");
  });

  it("validation_failed 按 code 呈现；秘密单发清空；列表零行", async () => {
    await submitConnect(INVALID_FORMAT_SECRET);

    const notice = await waitForNotice(
      (candidate) => candidate.code === "validation_failed",
      "格式非法秘密应呈现 validation_failed typed 拒绝",
    );
    expect(notice.code).toBe("validation_failed");

    // 秘密单发（法则 3）：提交后输入清空，永不复显。
    const secretValue = await $(sel(TID_SECRET_INPUT)).getValue();
    expect(String(secretValue)).toBe("");

    // 拒绝先于记录：列表保持零行（空态可见）。
    await $(sel(TID_LIST_EMPTY)).waitForDisplayed({ timeout: 10_000 });
  });

  it("首次合法 connect：闭集结局按 law 呈现（Gate E2 fallback-only 行或 connected）", async () => {
    await submitConnect(VALID_FORMAT_TEST_SECRET, "E2E Stripe");

    const notice = await waitForNotice(
      (candidate) =>
        candidate.key === "payswap.connections.result.connected" ||
        (candidate.key === "payswap.connections.refusal.secure_storage_unavailable" &&
          candidate.code === STORAGE_REFUSAL_CODE) ||
        (candidate.key === "payswap.connections.refusal.custodian_unavailable" &&
          candidate.code === CUSTODIAN_REFUSAL_CODE),
      "首次合法 connect 应呈现闭集结局（存储 typed 拒绝 / custodian typed 拒绝 / connected）",
    );

    if (notice.code === CUSTODIAN_REFUSAL_CODE) {
      // ADR-P2-3 fail-closed 的 E2E 形态：win32 custodian-required 且托管缺席
      //（无服务/注册门拒）= typed 拒绝 —— 绝不静默回退 legacy 存储（拒绝先于
      // 记录）。托管在场时该拒绝不可达（在 = 装配/门缺陷，测试失败）。
      if (custodianBackedAtRest()) {
        throw new Error(
          "custodian 服务在场却呈现 custodian_unavailable —— provisionDesktopCustodianBridge 装配或服务门缺陷",
        );
      }
      storageUnavailableInEnv = true;
      // at-rest：拒绝先于记录写 —— 无 PSP 密文、无连接记录。
      const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
      if (credentials !== null) {
        expect(credentials).not.toContain("payswap:psp:");
        expect(credentials).not.toContain(VALID_FORMAT_TEST_SECRET);
      }
      const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
      if (connections !== null) {
        expect(connections).not.toContain("stripe");
      }
      return;
    }

    if (notice.code === STORAGE_REFUSAL_CODE) {
      if (KEYRING_EXPECTATION === "gnome-libsecret") {
        throw new Error(
          "ZCODE_E2E_KEYRING=gnome-libsecret 腿期望存储可用（connected），但 connect 呈现 " +
            STORAGE_REFUSAL_CODE +
            " —— Electron 后端选择或 Secret Service 在该环境损坏（见 scripts/desktop-e2e-container-entrypoint.sh 的自证探针）；存储可用腿不得静默退化成 fallback-only",
        );
      }
      // 「only the fallback available refuses」—— Gate E2 的 E2E 条款本体：
      // typed error surfaced in the connection UI。
      storageUnavailableInEnv = true;
      // at-rest：拒绝先于记录写 —— 无 PSP 密文、无连接记录。
      const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
      if (credentials !== null) {
        expect(credentials).not.toContain("payswap:psp:");
        expect(credentials).not.toContain(VALID_FORMAT_TEST_SECRET);
      }
      const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
      if (connections !== null) {
        expect(connections).not.toContain("stripe");
      }
      return;
    }

    if (KEYRING_EXPECTATION === "absent") {
      // ADR-P2-3 架构分支：win32 custodian 路径不触 OS 钥匙串 —— absent 腿里
      // 托管在场时 connected 是 lawful 结局（托管保管，不是存储回退）。
      if (!custodianBackedAtRest()) {
        throw new Error(
          "ZCODE_E2E_KEYRING=absent 腿期望 fallback-only 拒绝（Gate E2 条款本体），但 connect 成功 —— absent 腿里存储不该在场（后端政策缺口或环境漂移）",
        );
      }
    }

    expect(notice.tone).toBe("positive");
    // connected：列表出现 connected/test 行（行 4 深检）。
    await browser.waitUntil(
      async () => (await rowIds()).length === 1,
      { timeout: 15_000, timeoutMsg: "connected 后列表应恰有一行" },
    );
  });

  it("happy path：connected 行 + at-rest 密文（记录无明文；凭据 store 含 id 无明文）", async function () {
    if (storageUnavailableInEnv) {
      this.skip();
      return;
    }
    const connectionId = await firstConnectionRowId();
    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    await row.waitForDisplayed({ timeout: 10_000 });
    expect(await row.getAttribute("data-connection-status")).toBe("connected");
    // mode 徽章是行内的子元素（payswap-connection-mode 的 data-mode —— UI 契约：
    // 行级只有 id/status 两属性；首跑即捕：本臂在存储可用腿首次真实执行，
    // 行级 data-mode 查询是 slice 8 未曾运行的错误选择器，非 UI 契约）。
    const mode = await $(
      `[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"] [data-testid="payswap-connection-mode"]`,
    ).getAttribute("data-mode");
    expect(mode).toBe("test");
    const name = await $('[data-testid="payswap-connection-name"]').getText();
    expect(name).toContain("E2E Stripe");

    // at-rest（架构感知）：连接记录无秘密；凭据面按架构分支 —— win32 custodian
    // 路径 = 本地凭据 store 恰无本连接槽位（托管保管，blob 在场）；legacy 路径 =
    // 凭据 store 密文（含 connectionId、不含明文）。
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connections).not.toBeNull();
    expect(connections).toContain(connectionId);
    expect(connections).not.toContain(VALID_FORMAT_TEST_SECRET);
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    if (custodianBackedAtRest()) {
      if (credentials !== null) {
        expect(credentials).not.toContain(connectionId);
        expect(credentials).not.toContain(VALID_FORMAT_TEST_SECRET);
      }
      expect(existsSync(CUSTODIAN_KEY_BLOB_FILE)).toBe(true);
    } else {
      expect(credentials).not.toBeNull();
      expect(credentials).toContain(connectionId);
      expect(credentials).not.toContain(VALID_FORMAT_TEST_SECRET);
    }
  });

  it("refresh：闭集结局呈现 + 状态一致（read_back_unavailable 不变 / expired 翻牌 / verified）", async function () {
    if (storageUnavailableInEnv) {
      this.skip();
      return;
    }
    const connectionId = await firstConnectionRowId();
    await clickVisibleTestId(TID_ROW_REFRESH, "没有找到刷新证据按钮");

    const notice = await waitForNotice(
      (candidate) =>
        (candidate.key === "payswap.connections.refusal.read_back_unavailable" &&
          candidate.code === "read_back_unavailable") ||
        candidate.key === "payswap.connections.result.expired" ||
        candidate.key === "payswap.connections.result.verified",
      "refresh 应呈现闭集结局（refused 读回不可用 / expired / verified）",
    );
    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    if (notice.key === "payswap.connections.refusal.read_back_unavailable") {
      // unknown ≠ expired：状态不变（fail-closed 不猜）。
      expect(await row.getAttribute("data-connection-status")).toBe("connected");
    } else if (notice.key === "payswap.connections.result.expired") {
      // expired：provider 拒绝凭据（真 401）—— 状态翻牌。
      await browser.waitUntil(
        async () => (await row.getAttribute("data-connection-status")) === "expired",
        { timeout: 15_000, timeoutMsg: "expired 结局后行状态应翻为 expired" },
      );
    } else {
      // verified：读回认证（离线 mock 之外的合法结局）。
      expect(await row.getAttribute("data-connection-status")).toBe("connected");
    }
  });

  it("revoke：终态 revoked + at-rest 本地秘密删除", async function () {
    if (storageUnavailableInEnv) {
      this.skip();
      return;
    }
    const connectionId = await firstConnectionRowId();
    await clickVisibleTestId(TID_ROW_REVOKE, "没有找到撤销按钮");

    const notice = await waitForNotice(
      (candidate) => candidate.key === "payswap.connections.result.revoked",
      "revoke 应呈现终态（muted）",
    );
    expect(notice.tone).toBe("muted");

    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-status")) === "revoked",
      { timeout: 15_000, timeoutMsg: "revoke 后行状态应为 revoked" },
    );

    // at-rest：delete-local-only —— 凭据 store 中该连接的 PSP 键已删除；记录仍在（终态）。
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    if (credentials !== null) {
      expect(credentials).not.toContain(connectionId);
    }
    if (custodianBackedAtRest()) {
      // ADR-P2-3：托管清除走 drop —— SYSTEM blob 必须证实不在（撤销必证实清除）。
      expect(existsSync(CUSTODIAN_KEY_BLOB_FILE)).toBe(false);
    }
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connections).toContain(connectionId);
    expect(connections).toContain('"revoked"');
  });

  it("Gate E2 行（存储可用环境）：损坏键 + 真实重启 → typed 存储 refusal 呈现；既有记录仍可列表", async function () {
    if (storageUnavailableInEnv) {
      // 该环境的 Gate E2 行已在「首次合法 connect」行本体证明（环境只有 fallback）。
      this.skip();
      return;
    }
    const idsBeforeRestart = await rowIds();
    expect(idsBeforeRestart.length).toBeGreaterThan(0);

    // 损坏键文件（safeStorage 包裹产物之外的任意字节）→ 重启后 app-ready 预热
    // 解包失败（typed unwrap 错误）→ fail-safe 空集 env（accountWarmup 法则 2）。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await writeFile(KEY_STORE_FILE, "corrupted-key-material-not-a-safestorage-blob", {
          mode: 0o600,
        });
      },
    });

    await openPayswapSettingsSection();
    // 键故障不吞数据面：既有记录仍可列表（readers 诚实）。
    await browser.waitUntil(
      async () => (await rowIds()).length === idsBeforeRestart.length,
      { timeout: 15_000, timeoutMsg: "键故障后既有连接记录仍应可列表" },
    );

    await submitConnect(VALID_FORMAT_TEST_SECRET, "E2 Stripe Fallback");
    // 架构分支：ADR-P2-3 custodian-required 路径不触 legacy 键仓（F5 —— 预热跳过
    //，解包永远不会为保管路径运行）—— 损坏的 legacy 包裹键与 connect 无关，
    // 托管在场的 lawful 结局是 connected（走托管）；托管缺席时 lawful 结局是
    // typed custodian_unavailable。legacy 路径保留原 Gate E2 存储 refusal 断言。
    if (custodianBackedAtRest()) {
      const custodianNotice = await waitForNotice(
        (candidate) =>
          candidate.key === "payswap.connections.result.connected" ||
          (candidate.key === "payswap.connections.refusal.custodian_unavailable" &&
            candidate.code === CUSTODIAN_REFUSAL_CODE),
        "托管在场时损坏 legacy 键不影响 connect —— lawful 结局为 connected（托管）/ custodian_unavailable（托管缺席）",
      );
      // at-rest：connected 分支 = 托管保管（本地 store 无本连接槽位；blob 在场）。
      if (custodianNotice.key === "payswap.connections.result.connected") {
        const connectionsCustodian = await readTextIfExists(CONNECTIONS_STORE_FILE);
        expect(connectionsCustodian).toContain("E2 Stripe Fallback");
        const credentialsCustodian = await readTextIfExists(CREDENTIALS_STORE_FILE);
        if (credentialsCustodian !== null) {
          expect(credentialsCustodian).not.toContain(VALID_FORMAT_TEST_SECRET);
        }
        expect(existsSync(CUSTODIAN_KEY_BLOB_FILE)).toBe(true);
      }
      return;
    }
    const notice = await waitForNotice(
      (candidate) =>
        candidate.key === "payswap.connections.refusal.secure_storage_unavailable" &&
        candidate.code === STORAGE_REFUSAL_CODE,
      "损坏键下 connect 应呈现 Gate E2 typed 存储 refusal（E2E 条款）",
    );
    expect(notice.code).toBe(STORAGE_REFUSAL_CODE);
    expect(notice.tone).toBe("danger");

    // at-rest：拒绝先于记录写 —— 无新连接记录、无新 PSP 密文。
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connections).not.toContain("E2E Stripe Fallback");
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    if (credentials !== null) {
      expect(credentials).not.toContain("payswap:psp:");
    }
  });
});

// ---------------------------------------------------------------------------
// P3 连接流 PayPal 臂（client-credentials 形态经真实窗口 IPC 链）—— provider
// picker 切换出 clientId/mode 输入面，凭据对经真实 renderer UI → 真实 ipcMain
// 通道 → 真实 PSP 键 store / 托管的闭集结局。通道级法则行（validation/refusals/
// verified{app_id}/revoke 双槽清除）已在 payswap-paypal-connection-ipc 电池；
// 本臂是运行时呈现与 at-rest 的真实窗口证明。
// ---------------------------------------------------------------------------

const PAYPAL_CLIENT_ID = "AXe2payswapRealWindowClientId";
const PAYPAL_CLIENT_SECRET = `EXe2payswapRealWindowSecret${"4".repeat(52)}`;

describe("P3 连接流 PayPal 臂（client-credentials 形态经真实窗口 IPC 链）", () => {
  before(async function () {
    this.timeout(60_000);
    await openPayswapSettingsSection();
    // provider picker 切到 PayPal：clientId + mode 输入面出现（client-credentials
    // 形态的法定一半的 UI 面）。
    const providerSelect = $(sel("payswap-connect-provider"));
    await providerSelect.waitForDisplayed({ timeout: 10_000 });
    await providerSelect.selectByAttribute("value", "paypal");
    await $(sel("payswap-connect-client-id")).waitForDisplayed({ timeout: 10_000 });
    await $(sel("payswap-connect-mode")).waitForDisplayed({ timeout: 10_000 });
  });

  it("本地守卫行：缺 clientId 提交是 no-op（UI 法则 —— 不发起、秘密不清空、无结局呈现）", async () => {
    const rowsBefore = await rowIds();
    await $(sel(TID_SECRET_INPUT)).setValue(PAYPAL_CLIENT_SECRET);
    await clickVisibleTestId(TID_SUBMIT, "没有找到连接提交按钮");
    await browser.pause(400);
    // 本地守卫：clientId 空 → handleConnect 直接 return —— 秘密不清空（单发
    // 清空只发生在真正提交时）、无 notice、列表不变。
    const secretValue = await $(sel(TID_SECRET_INPUT)).getValue();
    expect(String(secretValue)).toBe(PAYPAL_CLIENT_SECRET);
    const noticeExisting = await $(sel(TID_NOTICE)).isExisting().catch(() => false);
    expect(noticeExisting).toBe(false);
    const rowsAfter = await rowIds();
    expect(rowsAfter.length).toBe(rowsBefore.length);
    // 复位：清掉未消耗的秘密（后续行重新填）。
    await $(sel(TID_SECRET_INPUT)).setValue("");
  });

  it("connect 凭据对：闭集结局按 law 呈现（存储拒绝 / custodian 拒绝 / connected 行 + at-rest 密文）", async function () {
    const rowsBefore = await rowIds();
    await $(sel("payswap-connect-client-id")).setValue(PAYPAL_CLIENT_ID);
    await $(sel(TID_SECRET_INPUT)).setValue(PAYPAL_CLIENT_SECRET);
    await $(sel(TID_DISPLAY_NAME_INPUT)).setValue("E2E PayPal");
    await clickVisibleTestId(TID_SUBMIT, "没有找到连接提交按钮");

    const notice = await waitForNotice(
      (candidate) =>
        candidate.key === "payswap.connections.result.connected" ||
        (candidate.key === "payswap.connections.refusal.secure_storage_unavailable" &&
          candidate.code === STORAGE_REFUSAL_CODE) ||
        (candidate.key === "payswap.connections.refusal.custodian_unavailable" &&
          candidate.code === CUSTODIAN_REFUSAL_CODE),
      "PayPal connect 应呈现闭集结局（存储 typed 拒绝 / custodian typed 拒绝 / connected）",
    );

    // 秘密单发（法则 3）：真正提交后输入清空。
    const secretValue = await $(sel(TID_SECRET_INPUT)).getValue();
    expect(String(secretValue)).toBe("");

    if (notice.code === STORAGE_REFUSAL_CODE || notice.code === CUSTODIAN_REFUSAL_CODE) {
      // 拒绝先于记录写 —— 无 PayPal 记录、无 PayPal 明文（与 Stripe 臂同款纪律）。
      const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
      if (credentials !== null) {
        expect(credentials).not.toContain(PAYPAL_CLIENT_SECRET);
        expect(credentials).not.toContain(PAYPAL_CLIENT_ID);
      }
      const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
      if (connections !== null) {
        expect(connections).not.toContain("E2E PayPal");
      }
      return;
    }

    expect(notice.tone).toBe("positive");
    // connected：列表恰多一行；行状态 connected；display name 呈现。
    await browser.waitUntil(
      async () => (await rowIds()).length === rowsBefore.length + 1,
      { timeout: 15_000, timeoutMsg: "connected 后列表应恰多一行" },
    );
    const connectionId = (await rowIds()).find((id) => !rowsBefore.includes(id));
    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    expect(await row.getAttribute("data-connection-status")).toBe("connected");
    const name = await $('[data-testid="payswap-connection-name"]').getText();
    expect(name).toContain("E2E PayPal");

    // at-rest（架构感知）：记录无明文；凭据面按架构分支 —— custodian 路径 =
    // 本地 store 无本连接槽位（托管保管）；legacy 路径 = 密文（含 id 与两个槽
    // 名，不含明文）。
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connections).toContain('"providerId":"paypal"');
    expect(connections).not.toContain(PAYPAL_CLIENT_SECRET);
    expect(connections).not.toContain(PAYPAL_CLIENT_ID);
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    if (custodianBackedAtRest()) {
      if (credentials !== null) {
        expect(credentials).not.toContain(connectionId);
        expect(credentials).not.toContain(PAYPAL_CLIENT_SECRET);
        expect(credentials).not.toContain(PAYPAL_CLIENT_ID);
      }
    } else {
      expect(credentials).not.toBeNull();
      expect(credentials).toContain(connectionId);
      expect(credentials).toContain("client-id");
      expect(credentials).toContain("client-secret");
      expect(credentials).not.toContain(PAYPAL_CLIENT_SECRET);
      expect(credentials).not.toContain(PAYPAL_CLIENT_ID);
    }
  });

  it("revoke：终态 revoked + at-rest 双槽清除（custodian 路径 = 托管 blob 证实不在）", async function () {
    const connections = await readTextIfExists(CONNECTIONS_STORE_FILE);
    if (connections === null || !connections.includes("E2E PayPal")) {
      this.skip();
      return;
    }
    const storeJson = JSON.parse(connections) as Array<{
      connectionId?: string;
      displayName?: string;
      status?: string;
    }>;
    const paypalRecord = (Array.isArray(storeJson) ? storeJson : [storeJson]).find(
      (record) => record.displayName === "E2E PayPal",
    );
    if (paypalRecord?.connectionId === undefined) {
      this.skip();
      return;
    }
    const connectionId = paypalRecord.connectionId;
    const row = $(`[data-testid="${TID_ROW}"][data-connection-id="${connectionId}"]`);
    if (!(await row.isExisting().catch(() => false))) {
      this.skip();
      return;
    }
    await clickVisibleTestId(TID_ROW_REVOKE, "没有找到撤销按钮");
    const notice = await waitForNotice(
      (candidate) => candidate.key === "payswap.connections.result.revoked",
      "revoke 应呈现终态（muted）",
    );
    expect(notice.tone).toBe("muted");
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-status")) === "revoked",
      { timeout: 15_000, timeoutMsg: "revoke 后行状态应为 revoked" },
    );

    // at-rest：双槽清除 —— legacy 路径凭据 store 无本连接槽位；custodian 路径
    // 托管 blob 证实不在（撤销必证实清除，与 Stripe 臂同款法则）。
    const credentials = await readTextIfExists(CREDENTIALS_STORE_FILE);
    if (credentials !== null) {
      expect(credentials).not.toContain(connectionId);
      expect(credentials).not.toContain(PAYPAL_CLIENT_SECRET);
      expect(credentials).not.toContain(PAYPAL_CLIENT_ID);
    }
    if (custodianBackedAtRest()) {
      expect(existsSync(CUSTODIAN_KEY_BLOB_FILE)).toBe(false);
    }
    const connectionsAfter = await readTextIfExists(CONNECTIONS_STORE_FILE);
    expect(connectionsAfter).toContain(connectionId);
    expect(connectionsAfter).toContain('"revoked"');
  });
});
