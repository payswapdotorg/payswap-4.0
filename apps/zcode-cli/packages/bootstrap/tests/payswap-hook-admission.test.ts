/**
 * PaySwap P1.8 —— Gate E1：金融模式下的逐插件 hook 准入（addendum §5.1；playbook
 * P1.8 work package「hook admission」）。
 *
 * 法则（normative，addendum §5.1 原文）：
 * - **金融模式关（默认）**：与上游完全一致 —— 所有插件 hook 照跑，零 ZCode 回归
 *   （§5.1「Financial mode off (default): behavior identical to upstream — all
 *   plugin hooks run. Zero ZCode regression.」；S0a/S0b/S1 全部落在此臂）。
 * - **金融模式开**（会话中存在激活的 PaySwap financial workspace —— S2：官方插件
 *   启用 && `userConfig.financialWorkspace=true`）：仅 builtin/official 插件与显式
 *   用户信任白名单（`plugins.financialHookTrust`）上的插件可跑 hook；其它三方插件
 *   （inline/cache）的 hook 不注册执行。
 * - **升级路径**：adapters 源注释命名的「把判断收回 canRunPluginHooks」
 *   （plugins/index.ts：「需要逐插件 trust（如 user config 白名单）时，把判断收回
 *   这里」）—— 判断的单一实现住 `@zcode/shared/payswap` 的 hook-admission 法则，
 *   adapters 只接线。
 * - **金融模式投影与 broker live reader 同源**（§5.1「a PaySwap financial workspace
 *   active in the session」= §2.1 状态机的 S2）：本套件钉住投影的单一实现
 *   （readPayswapFinancialModeFromConfig —— spawn-wiring 的 live reader 自本 PR 起
 *   委托它，两处投影永不漂移）。
 * - **范围（hook-only）**：E1 只门 hook —— 被拒插件的 skills/commands/MCP servers
 *   照常解析（插件不被禁用；§5.1 是 hook 准入，不是插件生命周期变更，T4/T5 的上游
 *   语义不受影响）。货币路径的新鲜度由 broker 的 per-request live 读独立保证（§7.3
 *   三码法则），本门是 hook 面上的纵深防御。
 * - **白名单语义**：`<name>@<marketplace>` 权威 id 精确匹配，无通配、无前缀、无
 *   跨市场匹配（同 bare name 不同市场 = 不同插件 = 不匹配）。
 *
 * 两级证明：
 * 1. 法则级（纯 shared 模块）——准入矩阵 + S 状态轴投影。
 * 2. 发现边界（真实 discoverNodePluginsSync + 真实插件目录/fixtures）——E1 验收行的
 *   工程测试形态（§5.1「Acceptance (P1): engineering test — a third-party plugin
 *   hook does not execute during an active financial flow unless admitted; with
 *   financial mode off, the same hook runs (upstream behavior preserved)」）。
 *   「不执行」在发现边界的形态 = hook 不进入 outcome.hooks 的运行面（hookEvents
 *   空集 → 运行时无该插件的 matcher 可触发）；hookDetails 仍列出（runnable: false，
 *   管理页展示连续性 —— 上游 disabled 插件同款展示路径）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import {
  isPayswapFinancialModeActive,
  isPayswapPluginHookAdmitted,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  readPayswapFinancialModeFromConfig,
  type PayswapHookPluginSource,
} from "@zcode/shared/payswap";
import type { PluginLoadOutcome } from "@zcode/contracts";
import type { HookEventName } from "@zcode/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 法则级：准入矩阵（§5.1 决策表的全行覆盖）
// ---------------------------------------------------------------------------

describe("payswap hook admission (Gate E1) — law", () => {
  it("金融模式关：所有来源一律准入（上游行为不变，零回归）", () => {
    for (const source of ["official", "inline", "cache"] as const) {
      expect(
        isPayswapPluginHookAdmitted({
          financialModeActive: false,
          pluginId: `any@${source}-market`,
          source,
          trustedPluginIds: [],
        }),
      ).toBe(true);
    }
  });

  it("金融模式开：official 准入；inline/cache 未列白名单一律拒绝（fail-closed）", () => {
    expect(
      isPayswapPluginHookAdmitted({
        financialModeActive: true,
        pluginId: "hooker@zcode-plugins-official",
        source: "official",
        trustedPluginIds: [],
      }),
    ).toBe(true);
    for (const source of ["inline", "cache"] as const) {
      expect(
        isPayswapPluginHookAdmitted({
          financialModeActive: true,
          pluginId: `hooker@${source === "inline" ? "inline" : "evil-market"}`,
          source,
          trustedPluginIds: [],
        }),
      ).toBe(false);
    }
  });

  it("金融模式开：白名单精确 id 匹配准入（inline 与 cache 同权）", () => {
    for (const source of ["inline", "cache"] as const) {
      expect(
        isPayswapPluginHookAdmitted({
          financialModeActive: true,
          pluginId: "hooker@evil-market",
          source,
          trustedPluginIds: ["other@evil-market", "hooker@evil-market"],
        }),
      ).toBe(true);
    }
  });

  it("白名单是权威 id 精确匹配：bare name 相同而市场不同 = 不同插件，拒绝", () => {
    expect(
      isPayswapPluginHookAdmitted({
        financialModeActive: true,
        pluginId: "evil@evil-market",
        source: "cache",
        // 白名单上是另一市场的 evil（official 市场），不得跨市场放行。
        trustedPluginIds: ["evil@zcode-plugins-official"],
      }),
    ).toBe(false);
    expect(
      isPayswapPluginHookAdmitted({
        financialModeActive: true,
        pluginId: "payswap@zcode-plugins-official",
        source: "cache",
        // 同 bare name 冒充不得命中白名单（前缀/子串永不匹配）。
        trustedPluginIds: ["payswap-x@zcode-plugins-official"],
      }),
    ).toBe(false);
  });

  it("金融模式开的判定与来源种类解耦：非 official 的任何来源值都只走白名单", () => {
    const sources: PayswapHookPluginSource[] = ["inline", "cache"];
    for (const source of sources) {
      expect(
        isPayswapPluginHookAdmitted({
          financialModeActive: true,
          pluginId: "hooker@evil-market",
          source,
          trustedPluginIds: [],
        }),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 法则级：金融模式投影（S 状态轴；与 broker live reader 同一实现的钉住）
// ---------------------------------------------------------------------------

describe("payswap hook admission (Gate E1) — financial-mode projection", () => {
  it("S0a/S0b：插件未启用（或未配置）→ 金融模式关", () => {
    expect(isPayswapFinancialModeActive({})).toBe(false);
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: false },
        options: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: true } },
      }),
    ).toBe(false);
  });

  it("S1：启用但未 opt-in → 金融模式关（hook 门不激活 —— 与上游一致）", () => {
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: {},
      }),
    ).toBe(false);
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: false } },
      }),
    ).toBe(false);
  });

  it("S2：启用且 opt-in → 金融模式开", () => {
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: true } },
      }),
    ).toBe(true);
  });

  it("financialWorkspace 必须是严格 boolean true（字符串/数字真值不放行）", () => {
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: "true" } },
      }),
    ).toBe(false);
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: 1 } },
      }),
    ).toBe(false);
  });

  it("其它插件的配置永不串扰（同名选项挂在别的插件 id 下不激活）", () => {
    expect(
      isPayswapFinancialModeActive({
        enabledPlugins: { "evil@evil-market": true },
        options: {
          "evil@evil-market": { financialWorkspace: true },
          [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: true },
        },
      }),
    ).toBe(false);
  });

  it("readPayswapFinancialModeFromConfig：pair 投影（三码法则与 hook 门共用的单一实现）", () => {
    expect(readPayswapFinancialModeFromConfig({})).toEqual({
      financialWorkspace: false,
      pluginEnabled: false,
    });
    expect(
      readPayswapFinancialModeFromConfig({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: {},
      }),
    ).toEqual({ financialWorkspace: false, pluginEnabled: true });
    expect(
      readPayswapFinancialModeFromConfig({
        enabledPlugins: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: true },
        options: { [PAYSWAP_OFFICIAL_PLUGIN_ID]: { financialWorkspace: true } },
      }),
    ).toEqual({ financialWorkspace: true, pluginEnabled: true });
  });
});

// ---------------------------------------------------------------------------
// 发现边界：真实 discoverNodePluginsSync（E1 验收行的工程测试形态）
// ---------------------------------------------------------------------------

const OFFICIAL_HOOKER_ID = `e2e-official-hooker@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const THIRD_PARTY_HOOKER_ID = "e2e-third-party-hooker@inline";
const SESSION_START_EVENT: HookEventName = "SessionStart";

describe("payswap hook admission (Gate E1) — discovery boundary", () => {
  let storageRoot: string;
  let workspace: string;
  let thirdPartyRoot: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "payswap-e1-storage-"));
    workspace = await mkdtemp(join(tmpdir(), "payswap-e1-workspace-"));

    // 官方插件（带 hook）：直接落官方缓存分区 —— 上游 suppressed-builtins 套件的
    // 同款 fixture 纪律（plugins.test.ts「suppresses official plugins …」）。
    const officialHookerRoot = join(
      storageRoot,
      "cache",
      ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      "e2e-official-hooker",
      "0.0.0",
    );
    await mkdir(join(officialHookerRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(officialHookerRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "echo official-hooked" }],
            },
          ],
        },
        name: "e2e-official-hooker",
        version: "0.0.0",
      }),
    );

    // 三方插件（inline）：manifest 声明 hooks 文件 + skills 目录（hook-only 范围行
    // 需要 skill 仍在 —— 上游 ios-dev fixture 的同款布局）。
    thirdPartyRoot = join(storageRoot, "e2e-third-party-hooker");
    await mkdir(join(thirdPartyRoot, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(thirdPartyRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        hooks: "hooks/hooks.json",
        name: "e2e-third-party-hooker",
        skills: "skills",
        version: "0.0.0",
      }),
    );
    await mkdir(join(thirdPartyRoot, "hooks"), { recursive: true });
    await writeFile(
      join(thirdPartyRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: "echo third-party-hooked" }],
            },
          ],
        },
      }),
    );
    await mkdir(join(thirdPartyRoot, "skills", "e2e-skill"), { recursive: true });
    await writeFile(join(thirdPartyRoot, "skills", "e2e-skill", "SKILL.md"), "# skill");
  });

  afterAll(async () => {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  });

  /**
   * E1 的门输入是合并 config 的金融模式投影（readPayswapFinancialModeFromConfig），
   * 与 PaySwap 插件是否在本 fixture 中物理存在无关（生产中 S2 配置蕴含插件已装已启；
   * 投影读 config，不读发现产物）。
   */
  function discover(input: {
    financialMode: "off" | "s1" | "s2";
    financialHookTrust?: string[];
  }): PluginLoadOutcome {
    const enabledPlugins: Record<string, boolean> = {
      [OFFICIAL_HOOKER_ID]: true,
      [THIRD_PARTY_HOOKER_ID]: true,
    };
    const options: Record<string, Record<string, unknown>> = {};
    if (input.financialMode !== "off") {
      enabledPlugins[PAYSWAP_OFFICIAL_PLUGIN_ID] = true;
      options[PAYSWAP_OFFICIAL_PLUGIN_ID] = {
        financialWorkspace: input.financialMode === "s2",
      };
    }
    return discoverNodePluginsSync({
      config: {
        dirs: [thirdPartyRoot],
        enabled: true,
        enabledPlugins,
        extraKnownMarketplaces: {},
        options,
        suppressedBuiltins: [],
        ...(input.financialHookTrust !== undefined
          ? { financialHookTrust: input.financialHookTrust }
          : {}),
      },
      env: {},
      storageRoot,
      workingDirectory: workspace,
    });
  }

  /** 运行面 hook 的归属插件 id 全集（某事件下）。 */
  function hookOwnerIds(outcome: PluginLoadOutcome, event: HookEventName): string[] {
    return (outcome.hooks[event] ?? []).flatMap((matcher) =>
      matcher.hooks.map((hook) => hook.plugin?.id ?? "<no-plugin>"),
    );
  }

  it("E1 保存行：金融模式关（S0b —— payswap 未启用）→ 三方 hook 照常注册（上游行为保留）", () => {
    const outcome = discover({ financialMode: "off" });
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).toContain(THIRD_PARTY_HOOKER_ID);
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).toContain(OFFICIAL_HOOKER_ID);
  });

  it("E1 保存行：S1（启用但未 opt-in）→ 门不激活，三方 hook 照常注册", () => {
    const outcome = discover({ financialMode: "s1" });
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).toContain(THIRD_PARTY_HOOKER_ID);
  });

  it("E1 拒绝行：S2（金融模式开）→ 三方插件 hook 不进运行面；official 插件 hook 照常", () => {
    const outcome = discover({ financialMode: "s2" });
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).not.toContain(THIRD_PARTY_HOOKER_ID);
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).toContain(OFFICIAL_HOOKER_ID);
  });

  it("E1 拒绝行的范围（hook-only）：被拒插件的 skill 仍解析、插件仍启用、hookDetails 仍列出（runnable: false）", () => {
    const outcome = discover({ financialMode: "s2" });
    const plugin = outcome.plugins.find((entry) => entry.id === THIRD_PARTY_HOOKER_ID);
    expect(plugin).toMatchObject({ enabled: true });
    expect(
      outcome.skillRoots.map((root) => root.path),
    ).toContain(join(thirdPartyRoot, "skills"));
    expect(plugin?.hookDetails).toEqual([
      expect.objectContaining({
        event: "SessionStart",
        runnable: false,
      }),
    ]);
  });

  it("E1 白名单行：S2 + financialHookTrust 精确 id → 三方 hook 恢复注册", () => {
    const outcome = discover({
      financialMode: "s2",
      financialHookTrust: [THIRD_PARTY_HOOKER_ID],
    });
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).toContain(THIRD_PARTY_HOOKER_ID);
  });

  it("E1 白名单精确性行：S2 + 白名单只有其它 id → 三方 hook 仍拒绝", () => {
    const outcome = discover({
      financialMode: "s2",
      financialHookTrust: [`e2e-third-party-hooker@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`],
    });
    expect(hookOwnerIds(outcome, SESSION_START_EVENT)).not.toContain(THIRD_PARTY_HOOKER_ID);
  });
});
