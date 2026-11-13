import { createServer, type Server } from "node:http";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, clickTestIdByDomPointer } from "#e2e/helpers/desktop-app";
import { openFirstBrowserTab } from "#e2e/helpers/browser-side-pane";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

/**
 * 站点权限设置标签页回归（spec：2026-10-08 governance「站点权限设置标签页」）：
 * - 地址栏滑杆入口 → 站点信息气泡 → 权限设置 → 独立设置标签页
 * - 逐项改为允许后 guest 内 permissions.query 立即变 granted；重置后回到 denied
 * 2026-10-19 用户已完成人工复核；正式入口保留同一权限交互与持久化断言。
 */

const PERMISSION_TEST_PAGE = `<!doctype html><html><head><title>permission-settings-test</title></head><body>
<h1>permission settings test page</h1>
<script>
  window.__permissionState = async (name) => {
    const status = await navigator.permissions.query({ name });
    return status.state;
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

describe("站点权限设置标签页：地址栏入口与逐项修改", () => {
  let testServer: { server: Server; origin: string };

  before(async () => {
    testServer = await startPermissionTestServer();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await new Promise<void>((resolve) => {
      testServer.server.close(() => resolve());
    });
  });

  it("滑杆入口打开设置标签页；允许后立即生效，重置后回到询问", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openFirstBrowserTab();
    await navigateTo(testServer.origin);
    // URL 输入仍聚焦时滑杆按设计隐藏（BrowserToolbar 的 group-has-[input:focus] 隐藏规则）。
    // 修复原因（CI run 43174278149，该 spec 首次在容器环境运行）：WebDriver 对
    // <webview> 的坐标点击在容器里没有把焦点转移给 guest —— 地址输入保持 focus，
    // 滑杆容器持续 display:none，click 永远等不到 interactable。改为先显式断言
    // 「聚焦编辑时隐藏」这一设计契约（比旧行为更强的正向覆盖），再用键盘 Tab
    // 结束地址编辑——与布局/焦点路由无关的真实用户手势。
    expect(
      await browser.execute(
        (triggerId: string) => {
          const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerId}"]`);
          return trigger !== null && trigger.checkVisibility() === false;
        },
        "browser-permission-trigger",
      ),
    ).toBe(true);
    await browser.keys("Tab");

    // 未授权默认 denied
    expect(await runInGuest("window.__permissionState('geolocation')")).toBe("denied");

    // 地址栏滑杆 → 站点信息气泡 → 权限设置
    // 修复原因（CI run 43456602866/43459195997）：滑杆（PopoverTrigger）与
    // Select 触发器/选项都是 Radix 指针手势控件；Xvfb 无 WM 2 核容器里 WebDriver
    // 坐标点击链间歇性「命令成功但未送达」（本轮触发器 45s 不可点击）。改
    // clickTestIdByDomPointer（pointerdown+pointerup+click 的 DOM 派发，
    // selectPluginSettingsScope 的既有 PointerEvent 纪律泛化）；断言不变。
    await clickTestIdByDomPointer("browser-permission-trigger");
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-permission-popover"]'),
        ),
      { timeout: 10_000, timeoutMsg: "站点信息气泡没有出现" },
    );
    await clickTestIdByDom("browser-permission-open-settings");

    // 独立设置标签页打开，展示站点 origin 与能力目录
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-site-permissions"]'),
        ),
      { timeout: 15_000, timeoutMsg: "站点权限设置标签页没有出现" },
    );
    const originText = await browser.execute(
      () => document.querySelector('[data-testid="browser-site-permissions"] h1')?.textContent,
    );
    expect(originText).toBe(testServer.origin);

    // geolocation 逐项改为「允许」→ guest 内 permissions.query 立即变 granted
    // 修复原因（CI run 43447139431/43454124420）：设置标签页里 Radix 控件的 WebDriver
    // 坐标点击偶发不落位——两种表现：触发器 10s 不可点击（run 43454124420），或点击
    // 无报错但 onSelect 未触发 → 保存提示不出现（run 43447139431）。同族坐标交互
    // 问题。真实用户的自然反应是重开重选 —— 有界重试 3 次（两次点击 + 保存提示为
    // 一个完整尝试），断言语义不变（保存提示必须出现、granted 必须兑现）。
    let settingsSaved = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await clickTestIdByDomPointer("site-permission-setting-geolocation", {
          timeout: 15_000,
        });
        await clickTestIdByDomPointer("site-permission-option-allow", { timeout: 10_000 });
      } catch (error) {
        if (attempt === 3) throw error;
        await browser.pause(750);
        continue;
      }
      settingsSaved = await browser
        .waitUntil(
          async () =>
            !!(await browser.execute(
              () => !!document.querySelector('[data-testid="browser-permission-saved"]'),
            )),
          { timeout: attempt === 1 ? 6_000 : 10_000, timeoutMsg: "保存提示没有出现" },
        )
        .then(
          () => true,
          () => false,
        );
      if (settingsSaved) break;
      if (attempt === 3) {
        throw new Error("保存提示没有出现（三次选择「允许」后仍未保存）");
      }
    }
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('geolocation')")) === "granted",
      { timeout: 15_000, timeoutMsg: "设置页允许后 permissions.query 应为 granted" },
    );

    // 整站重置 → 回到每次询问（query 为 denied）
    await clickTestIdByDom("browser-permission-reset");
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector('[data-testid="browser-permission-reset-done"]'),
        ),
      { timeout: 10_000, timeoutMsg: "重置完成提示没有出现" },
    );
    await browser.waitUntil(
      async () => (await runInGuest("window.__permissionState('geolocation')")) === "denied",
      { timeout: 15_000, timeoutMsg: "重置后 permissions.query 应回到 denied" },
    );
  });
});

async function navigateTo(origin: string): Promise<void> {
  // 修复原因（CI run 43442176637 同族预防，见 browser-permission-prompt 的修复记录）：
  // Xvfb 无 WM 容器里地址输入的 WebDriver 坐标交互链间歇性 "element not
  // interactable"（本 spec 在 run 43418377362 已命中过同族滑杆问题）。地址输入是
  // 普通 <input>，提交走真实键盘 Enter——用原生 value setter + input 事件 +
  // 显式 focus() 写入，再以 browser.keys 提交；断言不变。
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
  await browser.waitUntil(
    async () => (await runInGuest("document.title")) === "permission-settings-test",
    {
      timeout: 15_000,
      timeoutMsg: "测试页脚本未就绪",
    },
  );
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

async function runInGuest<T>(script: string): Promise<T> {
  const webContentsId = await readBrowserGuestWebContentsId();
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
