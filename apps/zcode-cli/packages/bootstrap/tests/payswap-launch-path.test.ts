import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { listPluginUiSurfacesFromPlugins } from "../src/zcode-protocol/plugin-ui-surfaces.js";
import { ensurePayswapPluginDist } from "./payswap-plugin-build.js";

/**
 * PaySwap 官方插件启动路径验收（P1 PR #3 架构师评审第 3 项）。
 *
 * 在真实集成边界上证明完整链条，不造平行插件运行时：
 *   官方定义（OfficialPluginDefinition）
 *     → 构建（scripts/build.mjs 产出 requiredSeedPaths 钉住的 dist/server.mjs）
 *     → seed（resolveOfficialPluginRoots 的官方缓存管线，无 mock；含 runtime manifest
 *       重写为 host-launch 契约：command=execPath + __zcode-plugin-host 派发前缀）
 *     → manifest 解析（discoverNodePluginsSync 真实发现 + ${ZCODE_PLUGIN_ROOT} /
 *       ${user_config.financialWorkspace} 模板替换 + workspace isolation + 插件身份 env）
 *     → stdio 进程（office-runtime smoke 同款纪律：直接拉起 manifest 声明的 stdio 入口
 *       dist/server.mjs；__zcode-plugin-host 派发机制本身由 cli 包的
 *       plugin-host-entry.test.mjs 权威验收，此处断言 payswap 的缓存 manifest 指向该机制）
 *     → MCP 调用（listTools / callTool / readResource）。
 *
 * 同文件一并钉住评审第 2 项的验收区分：launcher 可见性（listPluginUiSurfacesFromPlugins
 * 只按 enabled 过滤）≠ 受保护金融数据可达性（面板静态骨架 + 未 opt-in 时工具全部 typed
 * refusal）。T7（opt-out 销毁已渲染数据）的数据臂在 Wave 2+ 面板承载真实数据后才存在，
 * 属认证 broker 里程碑的验收门（见 payswap-plugin CONTRACT.md）。
 */

const PAYSWAP_PLUGIN_ID = `payswap@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
const GATEWAY_SERVER_KEY = "plugin:payswap:gateway";

// 预期的外部契约（与 payswap-plugin/contract.ts 的单一事实源机械一致；此处内联，
// 让断言独立于被测插件包——ios-simulator 内联 fixture 的同款纪律）。
const SIX_TOOLS = [
  "payswap_check_eligibility",
  "payswap_compile_intent",
  "payswap_discover_routes",
  "payswap_get_account_overview",
  "payswap_get_execution_status",
  "payswap_request_authorization",
];
const THREE_SURFACE_URIS = [
  "ui://payswap/evidence.html",
  "ui://payswap/route-plan.html",
  "ui://payswap/workspace.html",
];

describe("payswap official-plugin launch path (definition → build → seed → resolution → stdio → MCP)", () => {
  let storageRoot: string;
  let workspace: string;
  let payswapCacheRoot: string;
  let payswapVersion: string;

  beforeAll(async () => {
    // 仓库内的插件包目录（bootstrap/tests → ../../payswap-plugin）。
    // 启动路径证据必须来自真实打包产物：并行安全地确保官方构建脚本产出存在
    // （CI 由 workspace build 预先产出；缺失/过期时在跨进程锁内构建，见 helper）。
    ensurePayswapPluginDist();

    storageRoot = await mkdtemp(join(tmpdir(), "payswap-launch-storage-"));
    workspace = await mkdtemp(join(tmpdir(), "payswap-launch-workspace-"));

    // 真实 seed：官方插件缓存管线（filesystem 源 → 不可变 cache + bundled marketplace 分片
    // + runtime manifest 重写为 __zcode-plugin-host 派发契约）。
    resolveOfficialPluginRoots({ storageRoot });

    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === "payswap");
    expect(definition).toBeDefined();
    payswapVersion = definition!.version;
    payswapCacheRoot = join(
      storageRoot,
      "cache",
      ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      "payswap",
      payswapVersion,
    );

    // seed 完整性：官方定义 requiredSeedPaths 钉住的两个产物都在缓存里。
    expect(existsSync(join(payswapCacheRoot, ".zcode-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(payswapCacheRoot, "dist", "server.mjs"))).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await rm(storageRoot, { force: true, recursive: true });
    await rm(workspace, { force: true, recursive: true });
  });

  function discoverPayswap(financialWorkspace: boolean) {
    return discoverNodePluginsSync({
      config: {
        dirs: [],
        enabled: true,
        enabledPlugins: { [PAYSWAP_PLUGIN_ID]: true },
        extraKnownMarketplaces: {},
        options: { [PAYSWAP_PLUGIN_ID]: { financialWorkspace } },
        suppressedBuiltins: [],
      },
      env: {},
      storageRoot,
      workingDirectory: workspace,
    });
  }

  function discoverAllDisabled() {
    return discoverNodePluginsSync({
      config: {
        dirs: [],
        enabled: true,
        enabledPlugins: {},
        extraKnownMarketplaces: {},
        options: {},
        suppressedBuiltins: [],
      },
      env: {},
      storageRoot,
      workingDirectory: workspace,
    });
  }

  // office-runtime smoke 的同款启动纪律：manifest 声明的 stdio 入口是 dist/server.mjs，
  // 拉起它验证 MCP 行为（__zcode-plugin-host 派发由 cli 包的 plugin-host-entry.test.mjs
  // 权威验收；本套件在解析断言里证明 payswap 的缓存 manifest 指向该机制）。
  async function connectGateway(financialWorkspace: boolean, name: string): Promise<Client> {
    const mcp = discoverPayswap(financialWorkspace).mcpServers[GATEWAY_SERVER_KEY]!;
    const client = new Client({ name, version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        // host-launch 契约：command=execPath，args=[…prefix, __zcode-plugin-host, <server>]。
        // 直接拉起最后一段（server.mjs 本体）——与生产同一模块、同一 stdio 协议。
        args: [mcp.args![mcp.args!.length - 1]!],
        command: mcp.command,
        cwd: mcp.cwd,
        env: { ...mcp.env, PATH: process.env.PATH ?? "" },
        stderr: "pipe",
      }),
    );
    return client;
  }

  it("resolves the seeded manifest through the real discovery pipeline with opt-in substitution", () => {
    const outcome = discoverPayswap(false);
    const plugin = outcome.plugins.find((entry) => entry.id === PAYSWAP_PLUGIN_ID);
    expect(plugin).toBeDefined();
    // 从 seed 缓存加载（而非仓库目录），marketplace 为官方源。
    expect(plugin).toMatchObject({
      enabled: true,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      name: "payswap",
      rootPath: payswapCacheRoot,
      version: payswapVersion,
    });

    const mcp = outcome.mcpServers[GATEWAY_SERVER_KEY];
    expect(mcp).toBeDefined();
    // seed 阶段的 runtime manifest 重写（official-plugin-runtime.ts）把官方插件 MCP 改写为
    // host-launch 契约：command=process.execPath，args 以 __zcode-plugin-host 派发标记 +
    // 缓存内 server 入口结尾。
    expect(mcp).toMatchObject({
      command: process.execPath,
      cwd: workspace,
      isolation: "workspace",
      type: "stdio",
    });
    expect(mcp.args).toBeDefined();
    expect(mcp.args!.length).toBeGreaterThanOrEqual(2);
    expect(mcp.args!.at(-1)).toBe(join(payswapCacheRoot, "dist", "server.mjs"));
    const hostMarkerIndex = mcp.args!.indexOf(ZCODE_PLUGIN_HOST_COMMAND);
    expect(hostMarkerIndex).toBeGreaterThanOrEqual(0);
    // 派发标记之后就是 server 入口（无多余参数）。
    expect(mcp.args!.slice(hostMarkerIndex)).toEqual([
      ZCODE_PLUGIN_HOST_COMMAND,
      join(payswapCacheRoot, "dist", "server.mjs"),
    ]);
    // ${user_config.financialWorkspace} → manifest env 注入（默认 false 的 opt-in 臂）。
    expect(mcp.env.PAYSWAP_FINANCIAL_WORKSPACE).toBe("false");
    // 插件身份由 resolver 权威写入，manifest 无法伪造。
    expect(mcp.env.ZCODE_PLUGIN_ID).toBe(PAYSWAP_PLUGIN_ID);
    expect(mcp.env.ELECTRON_RUN_AS_NODE).toBe("1");

    // 打开 financialWorkspace 后，同一个解析管线给出另一臂。
    const optedIn = discoverPayswap(true).mcpServers[GATEWAY_SERVER_KEY];
    expect(optedIn.env.PAYSWAP_FINANCIAL_WORKSPACE).toBe("true");
  });

  it("keeps a disabled (installed-but-not-enabled) payswap plugin out of the launcher listing", () => {
    const outcome = discoverAllDisabled();
    const plugin = outcome.plugins.find((entry) => entry.id === PAYSWAP_PLUGIN_ID);
    expect(plugin).toBeDefined();
    expect(plugin?.enabled).toBe(false);
    // S0b：未显式启用 → 无 launcher 入口、无 MCP server 解析。
    const surfaces = listPluginUiSurfacesFromPlugins(outcome.plugins);
    expect(surfaces.map((surface) => surface.pluginId)).not.toContain(PAYSWAP_PLUGIN_ID);
    expect(outcome.mcpServers[GATEWAY_SERVER_KEY]).toBeUndefined();
  });

  it("S1 launcher visibility is not data access: opted-out surfaces are listed yet carry no account data", { timeout: 90_000 }, async () => {
    const outcome = discoverPayswap(false);
    // 评审第 2 项确认的机制：listUiSurfaces 只按 enabled 过滤，不读 userConfig——
    // S1（enabled + 未 opt-in）下三个入口照常列出（P0 S1 行预期），这只是可见性。
    const surfaces = listPluginUiSurfacesFromPlugins(outcome.plugins).filter(
      (surface) => surface.pluginId === PAYSWAP_PLUGIN_ID,
    );
    expect(surfaces.map((surface) => surface.id).sort()).toEqual([
      "evidence",
      "route-plan",
      "workspace",
    ]);
    for (const surface of surfaces) {
      expect(surface.server).toBe(GATEWAY_SERVER_KEY);
      expect(surface.resourceUri).toMatch(/^ui:\/\/payswap\//);
      expect(surface.availability).toBe("session");
    }

    // 数据可达性必须在真实 stdio 进程上证明：面板是静态骨架，数据工具全部 typed refusal。
    const client = await connectGateway(false, "payswap-launch-s1");
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(SIX_TOOLS);

      // 未 opt-in（S1）：数据读取与意图编译都拒绝，信封永不携带账户信息。
      const refusals = await Promise.all([
        client.callTool({ arguments: {}, name: "payswap_get_account_overview" }),
        client.callTool({
          arguments: { description: "pay invoice INV-1" },
          name: "payswap_compile_intent",
        }),
      ]);
      for (const result of refusals) {
        const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(envelope).toEqual({
          kind: "refused",
          refusal: { code: "not_opted_in", message: expect.any(String) },
        });
      }

      // 三个面板资源：mcp-app mime + 静态骨架（明确声明未显示金融数据，且无占位数据）。
      for (const uri of THREE_SURFACE_URIS) {
        const resource = await client.readResource({ uri });
        expect(resource.contents).toHaveLength(1);
        const entry = resource.contents[0]!;
        expect(entry.mimeType).toBe("text/html;profile=mcp-app");
        const html = String(entry.text).toLowerCase();
        expect(html).toContain("no financial data is shown on this surface yet");
        expect(html).not.toMatch(/balance: \$|amount: \$|usd 0\.00/);
      }
    } finally {
      await client.close();
    }
  });

  it("spawns the packaged stdio server end-to-end and refuses with not_connected when opted in (S2)", { timeout: 90_000 }, async () => {
    const client = await connectGateway(true, "payswap-launch-s2");
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(SIX_TOOLS);
      // 已 opt-in、尚无已连接账户（Wave 1 无 broker）：not_connected（S2），仍无任何数据。
      const result = await client.callTool({
        arguments: {},
        name: "payswap_get_account_overview",
      });
      const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(envelope).toEqual({
        kind: "refused",
        refusal: { code: "not_connected", message: expect.any(String) },
      });
    } finally {
      await client.close();
    }
  });
});
