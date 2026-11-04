import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { ensurePayswapPluginDist } from "./payswap-plugin-build.js";

/**
 * PaySwap 生产宿主启动集成测试（P1 PR #3 架构师评审第 2 轮，第 3 项最终收口）。
 *
 * payswap-launch-path.test.ts 证明了各段机制（定义 → 构建 → seed → 解析 → 直连 dist/server.mjs
 * 的 stdio MCP），cli 包的 plugin-host-entry.test.mjs 证明了 `__zcode-plugin-host` 派发机制
 * （用测试 server）。两者都是真实机制，但没有拼在一起：上一版测试在 connectGateway 里把
 * 解析出的生产命令截断成最后一段（直接拉 server.mjs），没有执行 CLI 入口的派发链。
 *
 * 本文件补上缺的那一环——把解析器产出的**完整生产命令**逐字执行：
 *
 *   真实 CLI 入口（apps/zcode-cli/packages/cli/dist/zcode.cjs，workspace 生产构建产物）
 *     + 完整解析 args（<zcode.cjs> __zcode-plugin-host <缓存内 dist/server.mjs>）
 *     + 解析器生成的 env（PAYSWAP_FINANCIAL_WORKSPACE / ZCODE_PLUGIN_ID / ZCODE_PLUGIN_ROOT /
 *       ELECTRON_RUN_AS_NODE 等，生产 spawn 契约里 config.env 覆盖在 sanitized 基座之上）
 *     → node 子进程 → CLI main.ts 的 isPluginHostInvocation 早分流
 *     → runPluginHostCommand import 真实 PaySwap server → module.main()
 *     → stdio MCP（listTools / callTool / readResource）。
 *
 * seed 上下文纪律（诚实边界）：生产里 seed 发生在 CLI 启动进程内，manifest 重写
 * （official-plugin-runtime.ts 的 officialPluginHostPrefixArgs）读取的是该进程的
 * process.argv[1]/process.execArgv，烤入的正是 CLI 自己的入口。本测试在调用同一个
 * resolveOfficialPluginRoots 管线前，把进程上下文设成与 CLI 启动一致
 * （argv[1] = 真实构建的 zcode.cjs、execArgv = 空表），使缓存 manifest 里烤入的
 * 就是生产 host-launch 契约；随后 discovery 原样解析、测试逐字执行，不再截断、
 * 不造第二个 launcher、不复制派发机制。CLI 入口产物优先使用 CI workspace build
 * （pnpm -r build 产出 dist/zcode.cjs）；本地定向运行缺失时用**同一生产构建脚本**
 * （cli/scripts/build.mjs）补齐，测试代码不含任何手搓的 bundle 配置。
 */
describe("payswap production host launch (real zcode.cjs entrypoint + __zcode-plugin-host dispatch + resolver env)", () => {
  const PAYSWAP_PLUGIN_ID = `payswap@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
  const GATEWAY_SERVER_KEY = "plugin:payswap:gateway";

  // 与 payswap-plugin/contract.ts 单一事实源机械一致的内联契约（独立于被测插件包，
  // ios-simulator 内联 fixture 同款纪律；payswap-launch-path.test.ts 同款清单）。
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
  const STATIC_SURFACE_MARKER = "no financial data is shown on this surface yet";

  let storageRoot: string;
  let workspace: string;
  let cliEntry: string;
  let payswapCacheRoot: string;
  let payswapVersion: string;

  beforeAll(async () => {
    // ── 真实构建产物（两段）──────────────────────────────────────────────────
    // 1) PaySwap 插件：并行安全地确保官方构建脚本产出 requiredSeedPaths 钉住的
    //    dist/server.mjs（新鲜则零写入 —— 并行套件的 seeding 正在读同一目录）。
    ensurePayswapPluginDist();

    // 2) 真实 ZCode CLI 入口：优先用 workspace 生产构建产物（CI 的
    // "Build workspace" 步骤 = pnpm -r build 已产出）；本地定向运行缺失时用同一个
    // 生产构建脚本补齐。绝不手搓第二个入口/launcher。
    const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli");
    cliEntry = join(cliRoot, "dist", "zcode.cjs");
    if (!existsSync(cliEntry)) {
      execFileSync(process.execPath, [join(cliRoot, "scripts", "build.mjs")], {
        cwd: cliRoot,
        stdio: "pipe",
      });
    }
    expect(existsSync(cliEntry)).toBe(true);

    storageRoot = await mkdtemp(join(tmpdir(), "payswap-host-launch-storage-"));
    workspace = await mkdtemp(join(tmpdir(), "payswap-host-launch-workspace-"));

    // ── 生产上下文 seed ───────────────────────────────────────────────────────
    // officialPluginHostPrefixArgs() 读 seeding 进程的 argv[1]/execArgv；生产里那是
    // CLI 入口本身。把上下文设成一致后走真实 seed 管线，缓存 manifest 烤入的即生产
    // host-launch 契约（command=execPath、args=[<zcode.cjs>, __zcode-plugin-host, server]）。
    const originalArgv = process.argv;
    const originalExecArgv = process.execArgv;
    process.argv = [process.execPath, cliEntry];
    process.execArgv = [];
    try {
      resolveOfficialPluginRoots({ storageRoot });
    } finally {
      process.argv = originalArgv;
      process.execArgv = originalExecArgv;
    }

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
  }, 180_000);

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

  // 逐字执行解析器产出的完整生产命令。spawn 契约对齐 adapters/src/mcp/index.ts 的
  // createTransport：command/args 原样、cwd 来自 resolver、env = 基座 + config.env 覆盖
  // （基座只需 PATH；mcp.env 不含 PATH，与生产合并序等价）。
  async function connectProductionHost(financialWorkspace: boolean, name: string): Promise<Client> {
    const mcp = discoverPayswap(financialWorkspace).mcpServers[GATEWAY_SERVER_KEY]!;
    const client = new Client({ name, version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        // 完整 args：CLI 入口 + __zcode-plugin-host 派发标记 + 缓存内 server 入口。
        // 上一版测试在这里截断成 [server.mjs] —— 本文件存在的意义就是不再截断。
        args: mcp.args!,
        command: mcp.command,
        cwd: mcp.cwd,
        env: { PATH: process.env.PATH ?? "", ...mcp.env },
        stderr: "pipe",
      }),
    );
    return client;
  }

  it("resolves the complete production host command (real zcode.cjs entrypoint, no truncation)", () => {
    const mcp = discoverPayswap(false).mcpServers[GATEWAY_SERVER_KEY]!;
    expect(mcp).toMatchObject({
      command: process.execPath,
      cwd: workspace,
      isolation: "workspace",
      type: "stdio",
    });
    // 生产命令逐字钉死：node <workspace 构建的 zcode.cjs> __zcode-plugin-host <缓存 server.mjs>。
    // 前缀必须就是真实 CLI 入口（不是 vitest 入口），派发标记必须来自 contracts 常量。
    expect(mcp.args).toEqual([
      cliEntry,
      ZCODE_PLUGIN_HOST_COMMAND,
      join(payswapCacheRoot, "dist", "server.mjs"),
    ]);
    // 解析器权威 env：opt-in 臂（默认 false）、插件身份、缓存根、Electron Node 模式。
    expect(mcp.env.PAYSWAP_FINANCIAL_WORKSPACE).toBe("false");
    expect(mcp.env.ZCODE_PLUGIN_ID).toBe(PAYSWAP_PLUGIN_ID);
    expect(mcp.env.ZCODE_PLUGIN_ROOT).toBe(payswapCacheRoot);
    expect(mcp.env.ELECTRON_RUN_AS_NODE).toBe("1");

    // opt-in 臂给出另一条完整命令（仅 PAYSWAP_FINANCIAL_WORKSPACE 不同）。
    const optedIn = discoverPayswap(true).mcpServers[GATEWAY_SERVER_KEY]!;
    expect(optedIn.args).toEqual(mcp.args);
    expect(optedIn.env.PAYSWAP_FINANCIAL_WORKSPACE).toBe("true");
  });

  it("launches PaySwap through the real ZCode plugin host and keeps S1 (opted-out) refusals", { timeout: 120_000 }, async () => {
    const client = await connectProductionHost(false, "payswap-host-launch-s1");
    try {
      // 经 CLI 入口派发（main.ts → runPluginHostCommand → import server.mjs → main()）
      // 后，MCP 服务必须照常回答：六个工具一个不少。
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(SIX_TOOLS);

      // S1（已启用、未 opt-in）：数据读取与意图编译在真实宿主路径上仍是 typed refusal，
      // 信封永不携带账户信息。
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
      // 宿主派发不改变面板纪律——经 CLI 入口读到的与直连 server.mjs 读到的完全一致。
      for (const uri of THREE_SURFACE_URIS) {
        const resource = await client.readResource({ uri });
        expect(resource.contents).toHaveLength(1);
        const entry = resource.contents[0]!;
        expect(entry.mimeType).toBe("text/html;profile=mcp-app");
        const html = String(entry.text).toLowerCase();
        expect(html).toContain(STATIC_SURFACE_MARKER);
        expect(html).not.toMatch(/balance: \$|amount: \$|usd 0\.00/);
      }
    } finally {
      await client.close();
    }
  });

  it("launches the opted-in S2 gateway through the host and refuses with not_connected", { timeout: 120_000 }, async () => {
    const client = await connectProductionHost(true, "payswap-host-launch-s2");
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(SIX_TOOLS);

      // S2（已 opt-in、无已连接账户——Wave 1 没有 broker）：not_connected，仍无任何数据。
      const result = await client.callTool({
        arguments: {},
        name: "payswap_get_account_overview",
      });
      const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(envelope).toEqual({
        kind: "refused",
        refusal: { code: "not_connected", message: expect.any(String) },
      });

      // S2 面板同样是静态骨架：opt-in 打开的是工具语义臂，不是数据臂。
      const resource = await client.readResource({ uri: "ui://payswap/workspace.html" });
      expect(resource.contents).toHaveLength(1);
      const entry = resource.contents[0]!;
      expect(entry.mimeType).toBe("text/html;profile=mcp-app");
      const html = String(entry.text).toLowerCase();
      expect(html).toContain(STATIC_SURFACE_MARKER);
      expect(html).not.toMatch(/balance: \$|amount: \$|usd 0\.00/);
    } finally {
      await client.close();
    }
  });
});
