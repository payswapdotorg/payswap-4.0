/**
 * PaySwap gateway alwaysLoad 回归保护（TL review §3 B-3）。
 *
 * 契约：PaySwap 官方插件的 gateway MCP server 一旦插件被启用，六个 `payswap_*` 工具
 * 即常驻模型目录（`alwaysLoad: true`）—— 不依赖模型按需发现延迟工具。该声明必须：
 * 1. 真实存在于插件 manifest（plugin.json 的 mcpServers.gateway）；
 * 2. 原样穿过插件 MCP 解析管线（adapters resolvePluginMcpServers → runtime 配置）。
 *
 * 本 battery 两层都钉死。不会绕过 S0b 禁用态 / financialWorkspace 同意门（那是
 * OFFICIAL_PLUGIN_DEFINITIONS.defaultEnabled=false 与三码法则的管辖，与本字段无关）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePluginMcpServers } from "../src/plugins/mcp.js";
import type { LoadedPlugin, PluginManifest } from "../src/plugins/types.js";

const testsDir = dirname(fileURLToPath(import.meta.url));
// adapters/tests → ../../payswap-plugin/.zcode-plugin/plugin.json
const pluginRoot = join(testsDir, "..", "..", "payswap-plugin");
const manifestPath = join(pluginRoot, ".zcode-plugin", "plugin.json");

function readGatewayServer(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest & {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  const gateway = manifest.mcpServers?.gateway;
  if (!gateway) throw new Error("payswap plugin.json lost its gateway MCP server");
  return gateway;
}

function fakeLoadedPlugin(manifest: PluginManifest): LoadedPlugin {
  // resolvePluginMcpServers 只触 LoadedPlugin 的 id/manifest/manifestPath/marketplace/
  // rootPath 投影面 —— 官方 marketplace 身份走 source.kind 归类（builtin）。
  return {
    id: "payswap@zcode-plugins-official",
    manifest,
    manifestPath,
    marketplace: "zcode-plugins-official",
    rootPath: pluginRoot,
    source: { kind: "builtin" },
  } as unknown as LoadedPlugin;
}

describe("payswap gateway alwaysLoad (TL review §3 B-3)", () => {
  it("the plugin manifest declares alwaysLoad: true on the gateway server", () => {
    const gateway = readGatewayServer();
    expect(gateway.alwaysLoad).toBe(true);
    expect(gateway.type).toBe("stdio");
    expect(gateway.isolation).toBe("workspace");
  });

  it("the resolved runtime MCP config preserves alwaysLoad: true on plugin:payswap:gateway", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    const diagnostics: unknown[] = [];
    const resolved = resolvePluginMcpServers({
      dataPath: join(pluginRoot, "data"),
      diagnostics: diagnostics as never,
      env: {},
      loaded: fakeLoadedPlugin(manifest),
      options: {},
      workingDirectory: pluginRoot,
    });
    const gateway = resolved["plugin:payswap:gateway"];
    expect(gateway).toBeDefined();
    expect(gateway?.alwaysLoad).toBe(true);
    // 六工具插件的 gateway 恰一个 server；解析零诊断（变量面齐备）。
    expect(Object.keys(resolved).sort()).toEqual(["plugin:payswap:gateway"]);
    expect(diagnostics).toEqual([]);
  });
});
