import { createServer, type Server } from "node:http";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_WEBVIEW,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  clickTestIdByDomPointer,
  waitForTestIdByDom,
} from "#e2e/helpers/desktop-app";
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

    // 真实用户前置条件（run 43467865171 根因修复）：本 spec 到此为止的检查全部是 DOM
    // 存在性检查 + DOM 派发事件，而 TabsContent forceMount 的 keep-alive 会把「非激活」
    // 的设置页连全部控件一起留在 DOM（display:none）；Radix 下拉又以 body 门户渲染，
    // 不受页面 display:none 影响 —— 所以隐藏页上 focus/高亮/键盘全部照常工作。但
    // useBrowserSitePermissions 的 enabled（isVisible）守卫会静默吞掉全部写入：main
    // 无写入 IPC 日志、renderer 无错误日志、保存提示永不出现 —— 正是 43467865171 三次
    // 尝试「保存提示没有出现」的完整证据链。真实用户必须先「看到」设置标签页才能逐项
    // 修改。两项激活证据：(1) 标签 trigger data-state="active"（与 side-pane-scope 同一
    // 契约）；(2) 重置按钮已解锁 —— 它只在 states 首读完成后解锁（refresh 仅在
    // enabled=true 时运行），是写路径已打开的直接证据。
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const activeSettingsTab = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-side-pane-tab-id^="browser-permissions:"]',
            ),
          ).some((tab) => tab.getAttribute("data-state") === "active");
          if (!activeSettingsTab) return false;
          const reset = document.querySelector<HTMLButtonElement>(
            '[data-testid="browser-permission-reset"]',
          );
          return !!reset && !reset.disabled;
        }),
      {
        timeout: 15_000,
        timeoutMsg:
          "站点权限设置标签页没有成为激活标签且完成首次读取（keep-alive 下非激活页会吞掉全部写入）",
      },
    );

    // geolocation 逐项改为「允许」→ guest 内 permissions.query 立即变 granted
    // 修复原因（CI run 43456602866/43459195997/43464558855/43467865171 多轮同点）：Xvfb
    // 无 WM 2 核容器里 WebDriver 坐标点击链间歇性「命令成功但未送达」；而 Radix Select
    // 项不经 click 激活（pointerdown 开触发器后，完整 pointer+click 序列还会把已开的
    // 下拉当作 outside 点击关掉）。selectPluginSettingsScope 的既有纪律：pointerdown 开
    // 触发器 + 键盘走列表。真实键盘事件（browser.keys）在本容器已被证明可靠
    // （Enter/Tab/Escape）。有界重试 3 次；断言语义不变（保存提示必须出现、granted
    // 必须兑现、重置回 denied 必须兑现）。run 43467865171 起在 Enter 后先分离验证
    // Select 值提交（data-permission-setting 只在写入+重读后翻转），把「提交未送达」
    // 与「写入被吞」两类故障精确定位；失败路径倾倒诊断快照。
    let settingsSaved = false;
    let lastCommitState = "unknown";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (attempt > 1) {
          // 上一次尝试可能残留打开的下拉（Enter 未送达时）：先 Escape 归一化。
          await browser.keys("Escape");
          await browser.pause(150);
        }
        // pointerdown-only 开 Select（完整序列的 click 会当作 outside 关闭下拉）；
        // 等待与派发分离 —— waitUntil 谓词必须纯检查，逐次派发会把下拉来回切换。
        await waitForTestIdByDom("site-permission-setting-geolocation", {
          timeout: 15_000,
          timeoutMsg: "geolocation 设置控件没有渲染",
        });
        await browser.execute(() => {
          const trigger = document.querySelector<HTMLElement>(
            '[data-testid="site-permission-setting-geolocation"]',
          );
          if (!(trigger instanceof HTMLElement)) return false;
          trigger.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              button: 0,
              ctrlKey: false,
              pointerType: "mouse",
            }),
          );
          return true;
        });
        // 先等任一项获得高亮（Radix 定位后 focusSelectedItem 落焦），再走键盘 ——
        // 否则 ArrowDown 会与落焦竞态（run 43467865171：43–53ms 落焦窗口内 keydown
        // 落到触发器上被 OPEN_KEYS 吞掉，高亮不动）。
        await browser.waitUntil(
          async () =>
            await browser.execute(
              () =>
                !!document.querySelector(
                  '[data-testid^="site-permission-option-"][data-highlighted]',
                ),
            ),
          { timeout: 10_000, timeoutMsg: "下拉打开后没有高亮项" },
        );
        // 键盘走到「允许」项：按 data-highlighted 校验高亮位，最多 4 次 ArrowDown。
        for (let step = 0; step < 4; step += 1) {
          const allowHighlighted = await browser.execute(
            () =>
              !!document.querySelector(
                '[data-testid="site-permission-option-allow"][data-highlighted]',
              ),
          );
          if (allowHighlighted) break;
          await browser.keys("ArrowDown");
          await browser.pause(150);
        }
        await browser.pause(150);
        await browser.keys("Enter");
        // 值提交证据：data-permission-setting 只随 states（写入+重读）翻转。提交与
        // 保存提示分离等待，失败可精确归因。
        const valueCommitted = await browser
          .waitUntil(
            async () =>
              (await browser.execute(
                () =>
                  document
                    .querySelector('[data-testid="site-permission-setting-geolocation"]')
                    ?.getAttribute("data-permission-setting"),
              )) === "allow",
            { timeout: 5_000, timeoutMsg: "选择「允许」后 Select 值没有提交" },
          )
          .then(
            () => true,
            () => false,
          );
        lastCommitState = valueCommitted ? "committed" : "not-committed";
        if (!valueCommitted) {
          if (attempt === 3) break;
          await browser.pause(750);
          continue;
        }
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
        await dumpSiteSettingsDiagnostics("三次尝试后仍未保存");
        throw new Error(
          `保存提示没有出现（三次选择「允许」后仍未保存；值提交状态：${lastCommitState}）`,
        );
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

/**
 * run 43467865171 起的失败路径诊断快照：一次性回答「标签是否激活 / 值是否提交 /
 * 下拉是否残留 / 写路径是否 busy」四类问题，避免下一轮 CI 只拿到同一个不可归因的
 * 「保存提示没有出现」。倾倒进 wdio 控制台（side-pane-scope 的 afterEach 同款通道）。
 */
async function dumpSiteSettingsDiagnostics(label: string): Promise<void> {
  const dump = await browser.execute(() => {
    const describe = (element: Element | null) => {
      if (!element) return null;
      const html = element as HTMLElement;
      return {
        tag: html.tagName.toLowerCase(),
        testid: html.getAttribute("data-testid"),
        dataState: html.getAttribute("data-state"),
        dataHighlighted: html.hasAttribute("data-highlighted"),
        permissionSetting: html.getAttribute("data-permission-setting"),
        ariaExpanded: html.getAttribute("aria-expanded"),
        disabled: html instanceof HTMLButtonElement ? html.disabled : null,
        visible: html.checkVisibility(),
        text: html.textContent?.trim().slice(0, 40) ?? "",
      };
    };
    const page = document.querySelector('[data-testid="browser-site-permissions"]');
    return {
      tabTriggers: Array.from(
        document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).map((tab) => ({
        tabId: tab.getAttribute("data-side-pane-tab-id"),
        state: tab.getAttribute("data-state"),
      })),
      // TabsContent 宿主的激活态 —— keep-alive 僵尸页的直接证据。
      pageContentHostState: page?.closest("[data-state]")?.getAttribute("data-state") ?? null,
      pageVisible: page instanceof HTMLElement ? page.checkVisibility() : null,
      geolocationTrigger: describe(
        document.querySelector('[data-testid="site-permission-setting-geolocation"]'),
      ),
      listbox: describe(document.querySelector('[role="listbox"]')),
      activeElement: describe(document.activeElement),
      resetButton: describe(
        document.querySelector('[data-testid="browser-permission-reset"]'),
      ),
      savedNotice: !!document.querySelector('[data-testid="browser-permission-saved"]'),
      resetDoneNotice: !!document.querySelector(
        '[data-testid="browser-permission-reset-done"]',
      ),
      alertText: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
      windowFocused: document.hasFocus(),
    };
  });
  console.error(`[site-settings 诊断] ${label}`, JSON.stringify(dump, null, 2));
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
