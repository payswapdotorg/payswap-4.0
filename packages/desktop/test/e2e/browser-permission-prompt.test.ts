import { createServer, type Server } from "node:http";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_PROMPTS,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared/test-ids";
import { clickTestIdByWebDriver } from "./helpers/desktop-app.js";
import { openFirstBrowserTab } from "./helpers/browser-side-pane.js";
import { prepareConversationE2E } from "./helpers/conversation-session.js";

/**
 * CNVD「内置浏览器未授权访问」修复回归：
 * - 默认拒绝：无记录时 navigator.permissions.query 为 denied（不再被 Electron 自动授予）
 * - 确认条四态：阻止（持久）/ 访问此网站时允许（持久，二次请求不弹）/ 忽略（本次拒绝，再弹）
 * 三个独立 http origin 分别验证一种决策，互不污染。
 */

const PERMISSION_TEST_PAGE = `<!doctype html><html><head><title>permission-test</title></head><body>
<h1>permission test page</h1>
<script>
  window.__permissionState = async (name) => {
    const status = await navigator.permissions.query({ name });
    return status.state;
  };
  window.__getUserMediaResult = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
      return "ok";
    } catch (error) {
      return error && error.name ? error.name : "unknown";
    }
  };
</script>
</body></html>`;

async function startPermissionTestServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PERMISSION_TEST_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("permission test server did not bind a port");
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

describe("内置浏览器权限默认拒绝与确认条四态", () => {
  let blockServer: { server: Server; origin: string };
  let allowServer: { server: Server; origin: string };

  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    // 修复原因（run 43174278149 的诊断缺口）：pageResult undefined + 无确认条只能
    // 间接推断 guest 崩溃重建；补 webContents 清单（id/type/url/crashed）与当前
    // origin/确认条计数，让下一次失败能直接读到 guest 换代证据。
    const webContentsInventory = await browser.electron
      .execute(async (electron) => {
        return electron.webContents.getAllWebContents().map((contents) => ({
          id: contents.id,
          type: contents.getType(),
          url: contents.getURL().slice(0, 120),
          crashed:
            typeof (contents as unknown as { isCrashed?: () => boolean }).isCrashed ===
            "function"
              ? (contents as unknown as { isCrashed: () => boolean }).isCrashed()
              : null,
        }));
      })
      .catch((error: unknown) => `inventory unavailable: ${String(error)}`);
    console.info("[permission-e2e] camera diagnosis", {
      pageResult: await runInGuest("window.__mediaResult").catch(() => "<guest unavailable>"),
      state: await runInGuest("window.__permissionState('camera')").catch(
        () => "<guest unavailable>",
      ),
      currentOrigin: await runInGuest("location.origin").catch(() => "<guest unavailable>"),
      promptCount: await countPermissionPrompts().catch(() => -1),
      webContentsInventory,
    });
  });

  before(async () => {
    blockServer = await startPermissionTestServer();
    allowServer = await startPermissionTestServer();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await Promise.all(
      [blockServer, allowServer].map(
        ({ server }) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("未授权站点默认拒绝；不允许=本次拒绝且再弹；允许后持久且不再弹", async function () {
    this.timeout(300_000);
    await prepareConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();

    // ── 场景一：默认拒绝（CNVD 核心断言：不再被 Electron 自动授予）
    await navigateTo(blockServer.origin);
    // 两个测试 server 服务同一张页面（title 相同），导航断言无法区分实际 origin；
    // 显式断言当前 origin（guest 崩溃重建会恢复到 lastRestorableUrl，见 requestMediaAndAwait）。
    expect(await runInGuest("location.origin")).toBe(blockServer.origin);
    expect(await runInGuest("window.__permissionState('camera')")).toBe("denied");

    // ── 场景二：确认条 → 不允许（本次拒绝，不记忆：二次请求重新弹）
    // executeJavaScript 会等待 Promise；请求先以 void 返回，测试才能点击正在等待的权限确认条。
    await requestMediaAndAwait(
      "window.__mediaResult",
      countPermissionPrompts,
      (count) => count > 0,
      15_000,
      "权限确认条没有出现",
    );
    await clickTestIdByWebDriver(TID_BROWSER_PERMISSION_DENY);
    await browser.waitUntil(
      async () => (await runInGuest("window.__mediaResult")) === "NotAllowedError",
      { timeout: 15_000, timeoutMsg: "点「不允许」后 getUserMedia 应被拒绝" },
    );
    // 不记忆：二次请求确认条重新出现
    await requestMediaAndAwait(
      "window.__mediaResult2",
      countPermissionPrompts,
      (count) => count > 0,
      15_000,
      "权限确认条没有出现",
    );
    await clickTestIdByWebDriver(TID_BROWSER_PERMISSION_DENY);

    // ── 场景三：确认条 → 访问此网站时允许（持久）
    await navigateTo(allowServer.origin);
    expect(await runInGuest("location.origin")).toBe(allowServer.origin);
    expect(await runInGuest("window.__permissionState('camera')")).toBe("denied");
    await requestMediaAndAwait(
      "window.__mediaResult",
      countPermissionPrompts,
      (count) => count > 0,
      15_000,
      "权限确认条没有出现",
    );
    await clickTestIdByWebDriver(TID_BROWSER_PERMISSION_ALLOW_ALWAYS);
    // 允许后 permissions.query 变为 granted；无摄像头设备时 getUserMedia 是 NotFoundError（权限已过）
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('camera')")) === "granted",
      { timeout: 15_000, timeoutMsg: "「访问此网站时允许」后 permissions.query 应为 granted" },
    );
    // 二次请求不再弹确认条（完成即断言目标；guest 换代恢复见 requestMediaAndAwait）
    await requestMediaAndAwait(
      "window.__mediaResult2",
      async () => runInGuest("window.__mediaResult2"),
      (result) => result === "ok" || result === "NotFoundError",
      15_000,
      "允许后二次 getUserMedia 应完成（ok 或无设备）",
    );
    expect(await countPermissionPrompts()).toBe(0);
    // Electron 查询参数可能带尾部斜杠；授权后刷新仍应命中同一 origin 的持久记录。
    await clickTestIdByWebDriver(TID_BROWSER_REFRESH_BUTTON);
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('camera')")) === "granted",
      { timeout: 15_000, timeoutMsg: "刷新后没有保留 camera 允许记录" },
    );
  });
});

async function navigateTo(origin: string): Promise<void> {
  const addressInput = await $(`[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`);
  await addressInput.setValue(origin);
  await browser.keys("Enter");
  await browser.waitUntil(
    () =>
      browser.execute((refreshTestId: string) => {
        const refresh = document.querySelector<HTMLButtonElement>(
          `[data-testid="${refreshTestId}"]`,
        );
        return !!refresh && !refresh.disabled;
      }, TID_BROWSER_REFRESH_BUTTON),
    { timeout: 30_000, timeoutMsg: `内置浏览器没有加载完 ${origin}` },
  );
  // 导航后 guest webContents id 可能变化，等 title 就绪保证新文档已执行脚本
  await browser.waitUntil(async () => (await runInGuest("document.title")) === "permission-test", {
    timeout: 15_000,
    timeoutMsg: "测试页脚本未就绪",
  });
}

async function readBrowserGuestWebContentsId(): Promise<number> {
  const webContentsId = await browser.execute((testIdValue: string) => {
    const webviews = Array.from(
      document.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>(
        `[data-testid="${testIdValue}"]`,
      ),
    );
    const visible = webviews.findLast(
      (element) =>
        element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
    );
    const webview = visible ?? webviews.at(-1);
    return webview?.getWebContentsId?.() ?? null;
  }, TID_BROWSER_WEBVIEW);
  if (typeof webContentsId !== "number") {
    throw new Error("browser guest webview is not mounted yet");
  }
  return webContentsId;
}

async function runInGuestWithId<T>(webContentsId: number, script: string): Promise<T> {
  return browser.electron.execute(
    async (electron, guestId: number, code: string) => {
      const guest = electron.webContents.fromId(guestId);
      if (!guest || guest.isDestroyed()) {
        throw new Error("browser guest webContents is not available");
      }
      return guest.executeJavaScript(code) as Promise<unknown>;
    },
    webContentsId,
    script,
  ) as Promise<T>;
}

async function runInGuest<T>(script: string): Promise<T> {
  return runInGuestWithId<T>(await readBrowserGuestWebContentsId(), script);
}

async function countPermissionPrompts(): Promise<number> {
  return browser.execute((testIdValue: string) => {
    return document.querySelectorAll(`[data-testid="${testIdValue}"]`).length;
  }, TID_BROWSER_PERMISSION_PROMPTS);
}

/**
 * 修复原因（CI run 43174278149 场景三）：容器里 guest renderer 崩溃会触发 app 的
 * render-process-gone 原位重建（UnifiedBrowserView generation 换代，新 guest
 * webContents id）——已发出的 getUserMedia 随旧 guest 消失（__mediaResult 永远
 * pending），权限确认条也因弹层的 guest 归属过滤（请求携带旧 id）不再渲染。
 * 等待期间检测 guest 换代，并在新 guest（同 origin 的恢复页）上重新发起同一
 * 请求；全部断言保持不变，崩溃见证写日志供 register 记录。环境无崩溃（id
 * 不变）时行为与旧实现完全一致。
 */
async function requestMediaAndAwait<T>(
  resultKey: "window.__mediaResult" | "window.__mediaResult2",
  observe: () => Promise<T>,
  isSettled: (observed: T) => boolean,
  timeoutMs: number,
  timeoutMsg: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let firedGuestId = await readBrowserGuestWebContentsId();
  await runInGuestWithId(
    firedGuestId,
    `void window.__getUserMediaResult().then((value) => { ${resultKey} = value; })`,
  );
  let lastObserved = await observe();
  while (!isSettled(lastObserved)) {
    if (Date.now() >= deadline) {
      throw new Error(timeoutMsg);
    }
    const currentGuestId = await readBrowserGuestWebContentsId().catch(() => null);
    if (currentGuestId !== null && currentGuestId !== firedGuestId) {
      console.info(
        "[permission-e2e] guest rebuilt during media wait; re-firing on the new guest",
        { firedGuestId, currentGuestId, resultKey },
      );
      firedGuestId = currentGuestId;
      await runInGuestWithId(
        currentGuestId,
        `void window.__getUserMediaResult().then((value) => { ${resultKey} = value; })`,
      );
    }
    await browser.pause(150);
    lastObserved = await observe();
  }
  return lastObserved;
}
