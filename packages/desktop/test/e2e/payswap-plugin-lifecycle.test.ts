import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_SIDE_PANE_TOGGLE } from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "./helpers/desktop-app.js";
import {
  clickPluginControl,
  getPluginList,
  hasPluginControl,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  uninstallPluginThroughUi,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginList,
  waitUntilPluginOverview,
} from "./helpers/plugin-management-lifecycle.js";

/**
 * P1.8 plugin-lifecycle browser-verified arms —— 官方 PaySwap 插件走既有
 * marketplace + 设置 + 生命周期 UI（roadmap P1 验收：「plugin installs/enables/
 * disables through the EXISTING plugin lifecycle end-to-end (browser-verified)」）。
 *
 * 前置（本分支已落）：official plugin seed 携带已构建的 dist/server.mjs
 * （24d9b777）—— 否则官方插件以残缺 runtime 被 seed/恢复，MCP 启动即失败。
 *
 * 官方插件的安装语义（与 PLM-LC-006 builtin 流同构）：seed 即随包安装（S0b
 * 基线 —— 已发现、未启用），uninstall → suppressed/restorable，恢复经商店
 * install 按钮走 marketplace 管线。本 spec 覆盖：
 * 1. S0b 基线：插件宇宙含 payswap 且 enabled=false；overview 既不在
 *    installedPlugins 也不在 restorableBuiltins；config 无任何 payswap 条目。
 * 2. T1 enable（S0b→S1）：商店卡真实开关；enabled 持久化进真实 config.json；
 *    mcp 组件目录可见。
 * 3. S1 表面：主导航设置详情的 open-ui（draft 入口，PLM-UI-001 同款）打开
 *    Class A workspace 面板 —— 真实 plugin-ui 沙箱 guest 渲染信息性内容
 *    （spawn server → uiCallTool → 沙箱）。修复原因（CI run 43415362076）：
 *    side-pane 市场的 onOpenUi 在无绑定会话时被 useMarketPluginUi 的 needsSession
 *    守卫以 toast 拒开（本 spec 不发首轮消息），沙箱永不 spawn。
 * 4. T6：设置详情高级区按声明渲染 financialWorkspace 布尔开关（既有
 *    PluginConfigControls Switch，零设置页改动）。
 * 5. T2 opt-in（S1→S2）：翻转开关；userConfig 经真实 config.json 持久化。
 * 6. T4 disable（→S0b）：enabled=false，仍在插件宇宙。
 * 7. T5 uninstall（→S0a 抑制态）：确认卸载 → suppressed（restorable 投影）；
 *    既有卸载流移除 enabledPlugins 与 options 条目（addendum §2.2 T5 行）。
 * 8. 恢复（marketplace install 管线）：restorable 卡的 install 点击 → 回到
 *    已安装（S0b），config 保持默认关。
 */

const PAYSWAP_PLUGIN_ID = "payswap@zcode-plugins-official";
const LIFECYCLE_TIMEOUT_MS = 300_000;
const WORKSPACE_PANEL_HEADING = "PaySwap Financial Workspace";

interface PayswapCliConfig {
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
    options?: Record<string, Record<string, unknown>>;
  };
}

/**
 * 修复原因（CI run 43174278149 —— 该 spec 历史上首次在 desktop-capable 环境真正
 * 跑过 enable 步）：插件的 enabled/options 持久化由 CLI 分层写入 workspace 层
 * （<home>/ZCodeProject/.zcode/config.json，见该 run 的候选倾倒证据；分层优先级
 * 见 apps/zcode-cli plugins-command 的 user/workspace 注释），旧 reader 只读用户层
 * <home>/.zcode/cli/config.json（workspace 会话下该文件 absent）→ T1 的落盘断言
 * 永远超时。改为读取两级真实 config.json 的并集（workspace 层后读、覆盖 user 层，
 * 与 CLI 的 effective 语义一致）；T5 清理断言因此要求两级都没有 payswap 条目
 * —— 比旧断言更强，不足削弱。
 */
async function readCliConfigs(): Promise<PayswapCliConfig[]> {
  const { homeDir } = getE2EAppDataPaths();
  const candidates = [
    join(homeDir, ".zcode", "cli", "config.json"),
    join(DEFAULT_WORKSPACE, ".zcode", "config.json"),
    join(homeDir, ".zcode", "config.json"),
  ];
  const configs: PayswapCliConfig[] = [];
  for (const configPath of candidates) {
    try {
      configs.push(JSON.parse(await readFile(configPath, "utf8")) as PayswapCliConfig);
    } catch {
      /* 该层 absent 是合法状态：分层落盘只写实际发生变更的层。 */
    }
  }
  return configs;
}

async function readPayswapConfigEntry(): Promise<{
  enabled: boolean | undefined;
  financialWorkspace: unknown;
}> {
  let enabled: boolean | undefined;
  let financialWorkspace: unknown;
  // 候选顺序即优先级：后面的层（workspace）覆盖前面的层（user），与 CLI 的
  // effective 读取语义一致；两级都无条目时保持 undefined（T5 清理断言的事实）。
  for (const config of await readCliConfigs()) {
    const layerEnabled = config.plugins?.enabledPlugins?.[PAYSWAP_PLUGIN_ID];
    if (layerEnabled !== undefined) enabled = layerEnabled;
    const layerFinancialWorkspace =
      config.plugins?.options?.[PAYSWAP_PLUGIN_ID]?.financialWorkspace;
    if (layerFinancialWorkspace !== undefined) financialWorkspace = layerFinancialWorkspace;
  }
  return { enabled, financialWorkspace };
}

/** 插件宇宙（listPlugins）里的 payswap enabled 态 —— S 状态的运行时事实。 */
async function payswapUniverseEnabled(): Promise<boolean | undefined> {
  return (await getPluginList()).plugins.find((plugin) => plugin.id === PAYSWAP_PLUGIN_ID)?.enabled;
}

/**
 * 有界等待 config.json 中 payswap 条目达到预期 —— 持久化事实，而非 universe 内存镜像。
 * 修复原因（CI run 43161767622，该 spec 历史上首次跑过 enable 步）：universe 翻转后
 * 立即读盘与配置落盘存在竞态；改为有界等待。超时时倾倒候选配置路径的存在性与内容，
 * 供 CI 日志定位真实写入位置（用户配置 / workspace 配置 / data-base 变体）。
 */
async function waitForPayswapConfigEntry(
  predicate: (entry: {
    enabled: boolean | undefined;
    financialWorkspace: unknown;
  }) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  try {
    await browser.waitUntil(async () => predicate(await readPayswapConfigEntry()), {
      timeout: timeoutMs,
      timeoutMsg: message,
    });
  } catch (error) {
    await dumpPayswapConfigCandidates();
    throw error;
  }
}

async function dumpPayswapConfigCandidates(): Promise<void> {
  const homeDir = getE2EAppDataPaths().homeDir;
  const candidates = [
    join(homeDir, ".zcode", "cli", "config.json"),
    join(homeDir, "ZCodeProject", ".zcode", "config.json"),
    join(homeDir, ".zcode", "config.json"),
  ];
  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf8");
      console.log(`[lifecycle-e2e] config candidate ${path}:
${content}`);
    } catch {
      console.log(`[lifecycle-e2e] config candidate ${path}: <absent>`);
    }
  }
}

/**
 * 在真实 plugin-ui 沙箱 guest 中寻找 PaySwap Class A 面板内容。
 * 与 PLM-UI-001 的 waitForSandboxReady 同款遍历：zcode-sandbox:// guest 的
 * main frame 与子 frame 里查询 h1 文本（面板是静态骨架，heading 即就绪标记）。
 */
async function findPayswapPanelGuestHeading(): Promise<string | null> {
  return browser.electron.execute(async (electron) => {
    for (const guest of electron.webContents.getAllWebContents()) {
      if (!guest.getURL().startsWith("zcode-sandbox://")) continue;
      const frames = [guest.mainFrame, ...guest.mainFrame.frames];
      for (const frame of frames) {
        const text = await frame
          .executeJavaScript('document.querySelector("h1")?.textContent ?? null')
          .catch(() => null);
        if (typeof text === "string" && text.length > 0) return text;
      }
    }
    return null;
  });
}

/** 从工作区侧栏打开插件市场（side-pane 市场 —— onOpenUi 只在此上下文提供）。 */
async function openSidePaneMarket(): Promise<void> {
  const addTab = browser.$("[data-side-pane-add-tab-trigger]");
  if (await addTab.isDisplayed().catch(() => false)) {
    await addTab.click();
    await browser.$('[data-state="active"] [data-testid="side-pane-plugin-market"]').click();
  } else {
    const toggle = await browser.$(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`);
    await toggle.click();
    await waitForPluginControl("side-pane-ui-recommendations", {}, 30_000);
    await clickPluginControl("side-pane-plugin-market");
  }
  await waitForPluginControl("plugin-store-root", {}, 30_000);
}

/** 商店详情 → 商店列表（不在详情时为幂等 no-op）。 */
async function backToStoreList(): Promise<void> {
  if (await hasPluginControl("plugin-store-detail-back")) {
    await clickPluginControl("plugin-store-detail-back");
  }
}

/**
 * 经真实开关翻转启用态（不使用 setPluginEnabledThroughUi —— 其内部 30s 轮窗
 * 在本沙盒不够：enable 触发 session/agent 重建（含官方插件 MCP 冷启），恢复
 * 可超 30s；这里自己读开关、点击、并用宽裕窗口等运行时事实）。
 */
async function setPayswapEnabledThroughSwitch(enabled: boolean): Promise<void> {
  const current = await browser.execute(
    (pluginId) => {
      const element = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="plugin-store-enabled-switch"]'),
      ).find((candidate) => candidate.dataset.pluginId === pluginId);
      return element?.getAttribute("data-state") === "checked";
    },
    PAYSWAP_PLUGIN_ID,
  );
  if (current !== enabled) {
    await clickPluginControl("plugin-store-enabled-switch", { pluginId: PAYSWAP_PLUGIN_ID });
  }
  await browser.waitUntil(async () => (await payswapUniverseEnabled()) === enabled, {
    timeout: 120_000,
    timeoutMsg: `PaySwap enabled state did not become ${enabled} through the real switch`,
  });
}

describe("P1.8：官方 PaySwap 插件既有生命周期 browser-verified 臂", () => {
  before(async function () {
    // 冷启动 + 延迟静态服务下工作区就绪可超过 60s（与 D12.7 真实窗口臂同因）。
    this.timeout(180_000);
    await waitForDefaultWorkspaceReady(120_000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("S0b 基线→enable→S1（表面打开）→opt-in→S2→disable→S0b→卸载（抑制）→恢复（marketplace install）", async function () {
    this.timeout(LIFECYCLE_TIMEOUT_MS);

    // --- S0b 基线：官方 seed 随包安装（已发现、未启用） ---
    await waitUntilPluginOverview(
      (overview) =>
        !overview.installedPlugins.some((plugin) => plugin.id === PAYSWAP_PLUGIN_ID) &&
        !overview.restorableBuiltins.some((plugin) => plugin.id === PAYSWAP_PLUGIN_ID),
      "PaySwap was not in the S0b seed baseline (installed-registry or suppressed)",
    );
    await waitUntilPluginList(
      (list) =>
        list.plugins.some(
          (plugin) => plugin.id === PAYSWAP_PLUGIN_ID && plugin.enabled === false,
        ),
      "PaySwap was not discovered by the official seed (S0b universe baseline)",
    );
    expect(await payswapUniverseEnabled()).toBe(false);
    expect((await readPayswapConfigEntry()).financialWorkspace).toBeUndefined();

    // --- T1 enable（S0b→S1）：side-pane 市场卡上的真实开关 ---
    await openSidePaneMarket();
    await waitForPluginCard(PAYSWAP_PLUGIN_ID, 60_000);
    await openPluginCard(PAYSWAP_PLUGIN_ID);
    await waitForPluginControl("plugin-store-component-section", { componentKind: "mcp" }, 30_000);
    await backToStoreList();
    await setPayswapEnabledThroughSwitch(true);
    // 修复原因：见 waitForPayswapConfigEntry —— T1 的持久化事实用有界等待观察，
    // 不再依赖 universe 翻转后的立即读盘（首次 CI 全量运行 line-193 的证据缺口）。
    await waitForPayswapConfigEntry(
      (entry) => entry.enabled === true,
      "T1 enable 后 enabledPlugins[payswap] 未在 30s 内落盘",
    );

    // --- S1：Class A 表面经真实 plugin-ui 沙箱打开（主导航设置详情的 open-ui，draft 入口） ---
    // 修复原因（CI run 43415362076，S1 之后为该 spec 首次真实执行）：side-pane 市场详情
    // 的 open-ui 依赖目标会话（useMarketPluginUi 的 needsSession 守卫），本 spec 不发
    // 首轮消息、无绑定会话 → toast 拒开，沙箱永不 spawn（agent/desktop 日志零
    // pluginSandbox/payswap MCP 活动即为证据）。改走 PLM-UI-001 的被验证路径：
    // 主导航设置详情的 open-ui（onOpenDraftUi —— 根草稿上下文），同为真实 plugin-ui
    // 沙箱（spawn server → uiCallTool → 沙箱 guest）。
    await openPluginSettings();
    await openPluginCard(PAYSWAP_PLUGIN_ID);
    await waitForPluginControl("plugin-store-open-ui", { pluginId: PAYSWAP_PLUGIN_ID }, 30_000);
    await clickPluginControl("plugin-store-open-ui", { pluginId: PAYSWAP_PLUGIN_ID });
    await browser.waitUntil(
      async () => (await findPayswapPanelGuestHeading()) === WORKSPACE_PANEL_HEADING,
      {
        timeout: 60_000,
        timeoutMsg: "PaySwap workspace 面板未在真实插件沙箱 guest 中渲染",
      },
    );

    // --- T6 + T2：主导航设置详情高级区的声明式布尔开关（既有 PluginConfigControls） ---
    await openPluginSettings();
    await openPluginCard(PAYSWAP_PLUGIN_ID);
    await clickPluginControl("plugin-store-advanced");
    await waitForPluginControl(
      "plugin-store-config-input",
      { configKey: "financialWorkspace" },
      30_000,
    );
    await clickPluginControl("plugin-store-config-input", { configKey: "financialWorkspace" });
    await browser.waitUntil(
      async () => (await readPayswapConfigEntry()).financialWorkspace === true,
      {
        timeout: 30_000,
        timeoutMsg: "financialWorkspace opt-in 未写入真实 config.json（S2）",
      },
    );

    // --- T4 disable（→S0b）：enabled=false，仍在插件宇宙 ---
    await backToStoreList();
    await setPayswapEnabledThroughSwitch(false);

    // --- T5 uninstall（→S0a 抑制态）：确认卸载 → suppressed（restorable 投影）；
    //     既有卸载流移除 enabledPlugins 与 options 条目 ---
    await openPluginCard(PAYSWAP_PLUGIN_ID);
    await uninstallPluginThroughUi(PAYSWAP_PLUGIN_ID, true);
    await waitUntilPluginOverview(
      (overview) =>
        !overview.installedPlugins.some((plugin) => plugin.id === PAYSWAP_PLUGIN_ID) &&
        overview.restorableBuiltins.some((plugin) => plugin.id === PAYSWAP_PLUGIN_ID),
      "PaySwap did not reach the suppressed/restorable state after uninstall",
      120_000,
    );
    await browser.waitUntil(
      async () => {
        const entry = await readPayswapConfigEntry();
        return entry.enabled === undefined && entry.financialWorkspace === undefined;
      },
      {
        timeout: 30_000,
        timeoutMsg: "卸载后 enabledPlugins/options 未被既有卸载流清理（T5）",
      },
    );

    // --- 恢复（marketplace install 管线）：restorable 卡 install 点击 → S0b ---
    await waitForPluginCard(PAYSWAP_PLUGIN_ID, 60_000);
    await openPluginCard(PAYSWAP_PLUGIN_ID);
    await installPluginThroughUi(PAYSWAP_PLUGIN_ID);
    await waitUntilPluginOverview(
      (overview) => !overview.restorableBuiltins.some((plugin) => plugin.id === PAYSWAP_PLUGIN_ID),
      "PaySwap did not restore cleanly through the marketplace pipeline",
      120_000,
    );
    await waitUntilPluginList(
      (list) =>
        list.plugins.some(
          (plugin) => plugin.id === PAYSWAP_PLUGIN_ID && plugin.enabled === false,
        ),
      "PaySwap did not return to the S0b universe baseline after restore",
    );
    expect((await readPayswapConfigEntry()).financialWorkspace).toBeUndefined();
  });
});
