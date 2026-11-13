import { createServer, type Server } from "node:http";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_PROMPTS,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "./helpers/desktop-app.js";
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
    // 修复原因（CI run 43456602866/43459195997）：确认条按钮是普通 Button（onClick），
    // WebDriver 坐标点击间歇性「命令成功但未送达」（allow-always 点击后零 decision
    // 落盘）——改 DOM click（clickTestIdByDom 的既有纪律）；断言（决策落盘 +
    // NotAllowedError 结算 + 不记忆再弹）不变。
    await clickTestIdByDom(TID_BROWSER_PERMISSION_DENY);
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
    await clickTestIdByDom(TID_BROWSER_PERMISSION_DENY);
    // 修复原因（CI run 43415362076 场景三挂起，两轮同因）：第二次 deny 的拒绝结算
    // 未被等待就立即导航 —— 新文档上的 getUserMedia 在 media 管线 teardown 中途发出，
    // Chromium 层不再调用 request handler（证据：场景二两次 user-prompt dismiss 决策
    // 正常落盘，场景三零 permission 活动、promise 永久 pending、guest 未换代未崩溃）。
    // 与第一次 deny 后的断言一致地等待结算 —— 同时补上第二个 deny 的语义断言（不记
    // 忆拒绝同样必须兑现 NotAllowedError），管线结算完成后再导航。
    await browser.waitUntil(
      async () => (await runInGuest("window.__mediaResult2")) === "NotAllowedError",
      { timeout: 15_000, timeoutMsg: "点第二次「不允许」后 getUserMedia 应被拒绝" },
    );

    // ── 场景三：确认条 → 访问此网站时允许（持久）
    // 修复原因（runs 43509583729/43511500562/43513067991 场景三同因复燃，43415362076
    // 已登记族的残余窗口）：上面等待的是 deny 决策的 promise 结算，但 guest 的 media
    // 管线 teardown 在结算之后仍在进行 —— 场景三导航后的首个 getUserMedia 若落在
    // teardown 中途，Chromium 层不再调用 request handler（promise 永久 pending、
    // 零 permission 活动 —— 与历次失败诊断一致）。决策结算后有界静默窗，让管线
    // teardown 完成；断言语义不变。
    await browser.pause(600);
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
    await clickTestIdByDom(TID_BROWSER_PERMISSION_ALLOW_ALWAYS);
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
    // 修复原因（CI run 43447139431）：刷新按钮的 WebDriver 坐标点击间歇性不落位
    // （同族坐标交互问题，见上方 navigateTo 修复记录）——刷新是普通 Button，
    // DOM click 同样触发 React onClick；断言（granted 保持）不变。
    await clickTestIdByDom(TID_BROWSER_REFRESH_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "刷新按钮不可用",
    });
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('camera')")) === "granted",
      { timeout: 15_000, timeoutMsg: "刷新后没有保留 camera 允许记录" },
    );
  });
});

async function navigateTo(origin: string): Promise<void> {
  // 修复原因（CI run 43442176637 场景三导航）：Xvfb 无 WM 容器里地址输入的
  // WebDriver 坐标交互链（setValue 的 clear/focus）间歇性 "element not
  // interactable"——场景一/二全部通过后，场景三的地址输入 5 秒内不可交互导致
  // spec 失败（同族问题曾命中 site-settings 滑杆，run 43418377362；本仓库对同类
  // 坐标异常的既有解法即 DOM 写入，见 setInputValueByTestIdDom 的修复原因）。
  // 地址输入是普通 <input>，提交走真实键盘 Enter——用原生 value setter + input
  // 事件 + 显式 focus() 写入，再以 browser.keys 提交；加载完成/origin/脚本就绪
  // 断言保持不变。
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (testIdValue: string, nextOrigin: string) => {
          const input = document.querySelector<HTMLInputElement>(
            `[data-testid="${testIdValue}"]`,
          );
          if (!input) return false;
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(input, nextOrigin);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        },
        TID_BROWSER_ADDRESS_INPUT,
        origin,
      )) === true,
    { timeout: 15_000, timeoutMsg: "内置浏览器地址输入不可用" },
  );
  // 修复原因（run 43514818284 场景三导航断言失败：Expected allowServer / Received
  // denyServer —— 宿主池退化窗口内 browser.keys("Enter") 间歇不送达，地址栏
  // 停留旧 origin）：提交改走 form.requestSubmit() —— 与 Enter 隐式提交同一表单
  // 管线，不经真实键盘事件投递；断言（加载完成/origin/脚本就绪）不变。
  await browser.execute((testIdValue: string) => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${testIdValue}"]`);
    const form = input?.form;
    if (!(form instanceof HTMLFormElement)) return false;
    form.requestSubmit();
    return true;
  }, TID_BROWSER_ADDRESS_INPUT);
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
 *
 * 修复原因（CI run 43456602866 场景二）：另一同族表现 —— 请求发出后 Chromium 层
 * 偶发不再调用 request handler（media 管线 teardown 竞态；desktop 日志零
 * permission 活动、promise 永久 pending、guest 未换代未崩溃）。补有界重发：
 * 结果键仍未结算且 4s 无进展时重发同一 getUserMedia（用户「没弹窗再点一次」的
 * 自然手势；策略层同 origin+permission 的 inflight 去重让并发请求共享同一弹条，
 * 不会双弹）。最多 3 次发射，全部断言不变。
 */
async function requestMediaAndAwait<T>(
  resultKey: "window.__mediaResult" | "window.__mediaResult2",
  observe: () => Promise<T>,
  isSettled: (observed: T) => boolean,
  timeoutMs: number,
  timeoutMsg: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const refireIntervalMs = 4_000;
  const maxFires = 3;
  let firedGuestId = await readBrowserGuestWebContentsId();
  const fireRequest = async (guestId: number): Promise<void> => {
    await runInGuestWithId(
      guestId,
      `void window.__getUserMediaResult().then((value) => { ${resultKey} = value; })`,
    );
  };
  await fireRequest(firedGuestId);
  let lastFireAt = Date.now();
  let fires = 1;
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
      await fireRequest(currentGuestId);
      lastFireAt = Date.now();
      fires += 1;
    } else if (
      fires < maxFires &&
      Date.now() - lastFireAt >= refireIntervalMs &&
      (await runInGuest(`${resultKey} === undefined`).catch(() => false)) === true
    ) {
      console.info(
        "[permission-e2e] request still pending with no progress; re-firing (media pipeline teardown race)",
        { resultKey, fires },
      );
      await fireRequest(firedGuestId);
      lastFireAt = Date.now();
      fires += 1;
    }
    await browser.pause(150);
    lastObserved = await observe();
  }
  return lastObserved;
}
