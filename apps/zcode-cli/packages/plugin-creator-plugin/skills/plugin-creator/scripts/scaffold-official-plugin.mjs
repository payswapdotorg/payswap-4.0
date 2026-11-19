import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizePluginName } from "./create-basic-plugin.mjs";
import { exists, rejectSymlink } from "./marketplace-files.mjs";

/**
 * Official workspace plugin scaffold (Profile 2/3 in SKILL.md).
 *
 * Generates a complete plugin package following the repo conventions proven by
 * apps/zcode-cli/packages/payswap-plugin and documents-plugin/office-runtime:
 * package.json + .zcode-plugin/plugin.json (mcpServers/ui.surfaces/userConfig) +
 * src/{contract,server,panels,main}.ts + scripts/build.mjs (esbuild bundle) +
 * vitest wiring. The generated tools answer typed-refusal envelopes (the same
 * envelope shape payswap ships); real data flows are implemented afterwards via
 * the host integration references. It never creates empty tool lists and never
 * generates a credential-bearing server.
 *
 * The OfficialPluginDefinition block is printed and optionally written with
 * --definition-out; the agent inserts it into the host's
 * official-plugin-definitions.ts (bootstrap) — the audit script then verifies
 * registration, version alignment and required seed paths.
 */

const DEFAULT_LICENSE = "Apache-2.0";
const SDK_VERSION = "1.29.0";
const PANEL_MIME = "text/html;profile=mcp-app";

export function envNamespaceFromName(name) {
  return `${name.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`;
}

export function normalizeEnvNamespace(raw) {
  const value = raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+$/u, "");
  if (!value) throw new Error("env namespace must contain letters or digits");
  return `${value.toUpperCase()}_`;
}

function camelIdentifier(name) {
  const parts = name.split("-").filter(Boolean);
  const head = parts[0] ?? "plugin";
  const tail = parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  const identifier = `${head}${tail.join("")}`;
  return /^[a-zA-Z]/u.test(identifier) ? identifier : `plugin${identifier}`;
}

function pascalIdentifier(name) {
  const camel = camelIdentifier(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** "id:Title|zh-Title" → surface descriptor; titles keep en-US as the primary locale. */
export function parseSurfaces(raw) {
  const surfaces = [];
  for (const entry of String(raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [id, ...titles] = trimmed.split(":");
    const surfaceId = id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(surfaceId) || surfaceId.length > 128)
      throw new Error(`Surface id must match [A-Za-z0-9][A-Za-z0-9_.-]*: "${surfaceId}"`);
    if (titles.length === 0) throw new Error(`Surface "${surfaceId}" needs "id:Title"`);
    const [primary, secondary] = titles.join(":").split("|").map((value) => value.trim());
    if (!primary) throw new Error(`Surface "${surfaceId}" needs a non-empty title`);
    const title = secondary
      ? { "en-US": primary, "zh-CN": secondary }
      : { "en-US": primary };
    surfaces.push({ id: surfaceId, title });
  }
  if (surfaces.length === 0) throw new Error("Declare at least one surface with --surfaces");
  return surfaces;
}

function contractTemplate(input) {
  const { name, version, description, tools, surfaces, optIn, envNamespace, refusals } = input;
  const id = camelIdentifier(name);
  const lines = [];
  lines.push(`/**`);
  lines.push(` * ${name} plugin contract (generated scaffold; single source of truth for the`);
  lines.push(` * tool list, refusal taxonomy, surfaces and env namespace).`);
  lines.push(` *`);
  lines.push(` * Discipline: the MCP server process holds no domain state, no credentials and`);
  lines.push(` * no ledger/data access. Every tool answers a typed envelope — ok data,`);
  lines.push(` * typed refusal or typed failure — never a bare error. Real data flows go`);
  lines.push(` * through the host integration (see skills/plugin-creator references).`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`export const SERVER_NAME = ${JSON.stringify(name)};`);
  lines.push(`export const PLUGIN_VERSION = ${JSON.stringify(version)};`);
  lines.push(``);
  lines.push(`/** ui:// resource MIME (mcp-app contract; packages/shared/src/mcp-apps). */`);
  lines.push(`export const PANEL_MIME_TYPE = ${JSON.stringify(PANEL_MIME)};`);
  lines.push(``);
  lines.push(
    `/** Plugin-owned env namespace for every manifest-injected mcpServers.*.env key.`,
  );
  lines.push(
    ` * Precedent: PAYSWAP_* / ANDROID_PLUGIN_* / IOS_SIM_* (never ZCODE_*, never credentials). */`,
  );
  lines.push(`export const PLUGIN_ENV_NAMESPACE = ${JSON.stringify(envNamespace)};`);
  lines.push(``);
  lines.push(`/** Official seed requires exactly these outputs (bootstrap requiredSeedPaths). */`);
  lines.push(`export const PLUGIN_OUTPUTS = [".zcode-plugin/plugin.json", "dist/server.mjs"] as const;`);
  lines.push(``);
  lines.push(`/** Registered MCP tools; order is registration order. */`);
  lines.push(`export const TOOL_NAMES = [`);
  for (const tool of tools) lines.push(`  ${JSON.stringify(tool)},`);
  lines.push(`] as const;`);
  lines.push(`export type ToolName = (typeof TOOL_NAMES)[number];`);
  lines.push(``);
  if (optIn) {
    lines.push(`/** Manifest userConfig.${optIn.key} injected via \${user_config.${optIn.key}}. */`);
    lines.push(`export const OPT_IN_OPTION = ${JSON.stringify(optIn.key)};`);
    lines.push(`export const OPT_IN_ENV = ${JSON.stringify(optIn.envKey)};`);
    lines.push(``);
  }
  lines.push(`/**`);
  lines.push(` * Typed refusal codes (closed set; never conflate distinct states):`);
  for (const refusal of refusals) lines.push(` * - ${refusal.code}: ${refusal.note}`);
  lines.push(` */`);
  lines.push(`export type RefusalCode =`);
  lines.push(`  | ${refusals.map((refusal) => JSON.stringify(refusal.code)).join("\n  | ")};`);
  lines.push(``);
  lines.push(`export interface Refusal {`);
  lines.push(`  code: RefusalCode;`);
  lines.push(`  message: string;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * Unified response envelope for every tool: business data, typed refusal or typed`);
  lines.push(` * integration failure. Serialization never leaks raw errors or credential material.`);
  lines.push(` */`);
  lines.push(`export type ToolEnvelope<T = unknown> =`);
  lines.push(`  | { kind: "ok"; data: T }`);
  lines.push(`  | { kind: "refused"; refusal: Refusal }`);
  lines.push(`  | { kind: "failure"; failure: { code: string; message: string; retryable: boolean } };`);
  lines.push(``);
  if (surfaces.length > 0) {
    lines.push(`/** Informational ui:// surfaces; keep them Class A (no approval semantics). */`);
    lines.push(`export const SURFACES = [`);
    for (const surface of surfaces) {
      lines.push(`  {`);
      lines.push(`    id: ${JSON.stringify(surface.id)},`);
      lines.push(`    resourceUri: ${JSON.stringify(surface.resourceUri)},`);
      lines.push(`    title: ${JSON.stringify(surface.title)},`);
      lines.push(`    icon: ${JSON.stringify(surface.icon)},`);
      lines.push(`  },`);
    }
    lines.push(`] as const;`);
    lines.push(`export type SurfaceId = (typeof SURFACES)[number]["id"];`);
    lines.push(``);
  }
  if (optIn) {
    lines.push(`/** Snapshot of the opt-in state from the manifest-injected env. */`);
    lines.push(`export function readOptInSnapshot(env: NodeJS.ProcessEnv): boolean {`);
    lines.push(`  return env[OPT_IN_ENV] === "true";`);
    lines.push(`}`);
    lines.push(``);
    lines.push(`/** Unified refusal for the snapshot states (matches the host-side law). */`);
    lines.push(`export function snapshotRefusal(optedIn: boolean): Refusal {`);
    lines.push(`  return optedIn`);
    lines.push(`    ? {`);
    lines.push(`        code: ${JSON.stringify(refusals[1]?.code ?? "not_connected")},`);
    lines.push(`        message:`);
    lines.push(
      `          ${JSON.stringify(refusals[1]?.message ?? "The integration is enabled, but its prerequisite is not connected yet.")},`,
    );
    lines.push(`      }`);
    lines.push(`    : {`);
    lines.push(`        code: ${JSON.stringify(refusals[0]?.code ?? "not_opted_in")},`);
    lines.push(`        message:`);
    lines.push(
      `          ${JSON.stringify(refusals[0]?.message ?? "This workspace is not enabled. Turn on the option in the plugin settings, then try again.")},`,
    );
    lines.push(`      };`);
    lines.push(`}`);
    lines.push(``);
  }
  lines.push(`/** Envelope serialization (tool results are JSON text). */`);
  lines.push(`export function envelopeText<T>(envelope: ToolEnvelope<T>): string {`);
  lines.push(`  return JSON.stringify(envelope);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export const PLUGIN_DESCRIPTION = ${JSON.stringify(description)};`);
  lines.push(`export const PLUGIN_ID = ${JSON.stringify(id)};`);
  return `${lines.join("\n")}\n`;
}

function serverTemplate(input) {
  const { name, version, tools, surfaces, optIn } = input;
  const id = pascalIdentifier(name);
  const refusalNote = optIn
    ? `/** Refusal law: every tool answers the snapshot refusal until host integration is armed. */`
    : `/** Refusal law: tools answer a typed refusal until their handler is implemented. */`;
  const lines = [];
  lines.push(`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`);
  if (tools.length > 0) {
    lines.push(`import { z } from "zod";`);
  }
  lines.push(`import {`);
  lines.push(`  PANEL_MIME_TYPE,`);
  lines.push(`  TOOL_NAMES,`);
  lines.push(`  envelopeText,`);
  if (optIn) {
    lines.push(`  readOptInSnapshot,`);
    lines.push(`  snapshotRefusal,`);
  }
  lines.push(`  type ToolEnvelope,`);
  lines.push(`  type ToolName,`);
  if (surfaces.length > 0) {
    lines.push(`  SURFACES,`);
  }
  lines.push(`} from "./contract.ts";`);
  if (surfaces.length > 0) {
    lines.push(`import { renderPanelHtml } from "./panels.ts";`);
  }
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * ${name} MCP server (generated scaffold).`);
  lines.push(` *`);
  lines.push(` * - Every declared tool is registered with a real input schema and a typed`);
  lines.push(` *   refusal envelope; wire the handler to the host integration (thin proxy`);
  lines.push(` *   through the host's authenticated service boundary) before answering data.`);
  lines.push(` * - The server process holds no credentials and no domain state.`);
  lines.push(` * - Surfaces are informational ui:// resources (mcp-app mime, static skeleton).`);
  lines.push(` */`);
  lines.push(``);
  lines.push(refusalNote);
  lines.push(``);
  lines.push(`export interface ${id}ServerOptions {`);
  lines.push(`  env?: NodeJS.ProcessEnv;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`interface ToolCallExtra {`);
  lines.push(`  signal?: AbortSignal;`);
  lines.push(`  _meta?: unknown;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function create${id}Server(options: ${id}ServerOptions = {}): McpServer {`);
  lines.push(`  const server = new McpServer({ name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} });`);
  lines.push(`  const env = options.env ?? process.env;`);
  if (optIn) {
    lines.push(`  const refusal = snapshotRefusal(readOptInSnapshot(env));`);
    lines.push(``);
    lines.push(`  const refusalResult = (tool: string) => {`);
    lines.push(`    const envelope: ToolEnvelope = { kind: "refused", refusal: { ...refusal } };`);
    lines.push(`    process.stderr.write(\`[${name}] \${tool}: refused \${refusal.code}\\n\`);`);
    lines.push(`    return { content: [{ type: "text" as const, text: envelopeText(envelope) }] };`);
    lines.push(`  };`);
    lines.push(``);
  } else {
    lines.push(`  const refusalResult = (tool: string) => {`);
    lines.push(`    const envelope: ToolEnvelope = {`);
    lines.push(`      kind: "refused",`);
    lines.push(`      refusal: {`);
    lines.push(`        code: "not_available",`);
    lines.push(`        message:`);
    lines.push(
      `          ${JSON.stringify(`${name} has no wired host integration yet: implement the tool handler against the host service boundary before it answers real data.`)},`,
    );
    lines.push(`      },`);
    lines.push(`    };`);
    lines.push(`    process.stderr.write(\`[${name}] \${tool}: refused not_available\\n\`);`);
    lines.push(`    return { content: [{ type: "text" as const, text: envelopeText(envelope) }] };`);
    lines.push(`  };`);
    lines.push(``);
  }
  lines.push(`  const toolHandler = (tool: ToolName) => async (args: unknown, extra: ToolCallExtra) => {`);
  lines.push(`    void args;`);
  lines.push(`    void extra;`);
  lines.push(`    return refusalResult(tool);`);
  lines.push(`  };`);
  lines.push(``);
  for (const tool of input.toolDescriptors) {
    lines.push(`  server.registerTool(`);
    lines.push(`    TOOL_NAMES[${tool.index}],`);
    lines.push(`    {`);
    lines.push(`      title: ${JSON.stringify(tool.title)},`);
    lines.push(`      description:`);
    lines.push(`        ${JSON.stringify(tool.description)},`);
    lines.push(`      inputSchema: {`);
    lines.push(`        ${tool.schemaVar}: z.string().min(1).describe(${JSON.stringify(tool.schemaDescribe)}),`);
    lines.push(`      },`);
    lines.push(`      annotations: { readOnlyHint: ${tool.readOnly ? "true" : "false"} },`);
    lines.push(`    },`);
    lines.push(`    toolHandler(TOOL_NAMES[${tool.index}]) as never,`);
    lines.push(`  );`);
    lines.push(``);
  }
  if (surfaces.length > 0) {
    lines.push(`  for (const surface of SURFACES) {`);
    lines.push(`    server.registerResource(`);
    lines.push(`      surface.id,`);
    lines.push(`      surface.resourceUri,`);
    lines.push(`      { mimeType: PANEL_MIME_TYPE },`);
    lines.push(`      async (uri) => ({`);
    lines.push(`        contents: [`);
    lines.push(`          {`);
    lines.push(`            uri: uri.href,`);
    lines.push(`            mimeType: PANEL_MIME_TYPE,`);
    lines.push(`            text: renderPanelHtml(surface.id),`);
    lines.push(`          },`);
    lines.push(`        ],`);
    lines.push(`      }),`);
    lines.push(`    );`);
    lines.push(`  }`);
    lines.push(``);
  }
  lines.push(`  return server;`);
  lines.push(`}`);
  return `${lines.join("\n")}\n`;
}

function panelsTemplate(input) {
  const { name, surfaces, optIn } = input;
  const lines = [];
  lines.push(`import { SURFACES, type SurfaceId } from "./contract.ts";`);
  lines.push(``);
  lines.push(`/**`);
  lines.push(` * Informational ui:// HTML resources for the declared surfaces.`);
  lines.push(` *`);
  lines.push(` * Discipline: panels are static skeletons — zero external dependencies (no`);
  lines.push(` * linked scripts, network requests or remote fonts) and zero placeholder`);
  lines.push(` * data. They state their own status and the path to live data instead.`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`interface PanelContent {`);
  lines.push(`  heading: string;`);
  lines.push(`  lede: string;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`const PANEL_CONTENT: Record<SurfaceId, PanelContent> = {`);
  for (const surface of surfaces) {
    lines.push(`  ${JSON.stringify(surface.id)}: {`);
    lines.push(`    heading: ${JSON.stringify(surface.title["en-US"] ?? surface.id)},`);
    lines.push(`    lede: ${JSON.stringify(`${name} informational surface.`)},`);
    lines.push(`  },`);
  }
  lines.push(`};`);
  lines.push(``);
  lines.push(`function escapeHtml(value: string): string {`);
  lines.push(`  return value`);
  lines.push(`    .replaceAll("&", "&amp;")`);
  lines.push(`    .replaceAll("<", "&lt;")`);
  lines.push(`    .replaceAll(">", "&gt;")`);
  lines.push(`    .replaceAll('"', "&quot;")`);
  lines.push(`    .replaceAll("'", "&#39;");`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`export function renderPanelHtml(surfaceId: SurfaceId): string {`);
  lines.push(`  const content = PANEL_CONTENT[surfaceId];`);
  lines.push(`  const surface = SURFACES.find((entry) => entry.id === surfaceId);`);
  lines.push(`  if (!surface || !content) throw new Error(\`Unknown surface: \${surfaceId}\`);`);
  lines.push(
    `  const enablement = ${JSON.stringify(optIn ? "the plugin option is enabled in settings" : "the host integration is implemented")};`,
  );
  lines.push(`  return \`<!doctype html>`);
  lines.push(`<html lang="en">`);
  lines.push(`<head>`);
  lines.push(`<meta charset="utf-8">`);
  lines.push(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  lines.push(`<title>\${escapeHtml(content.heading)}</title>`);
  lines.push(`<style>`);
  lines.push(`  :root { color-scheme: light dark; }`);
  lines.push(`  body { margin: 0; font-family: -apple-system, "Segoe UI", sans-serif; background: var(--bg, #fff); color: var(--fg, #222); }`);
  lines.push(`  main { padding: 24px; max-width: 640px; }`);
  lines.push(`  h1 { font-size: 16px; margin: 0 0 8px; }`);
  lines.push(`  p { font-size: 13px; line-height: 1.6; opacity: 0.85; }`);
  lines.push(`  .card { border: 1px solid #ddd; border-radius: 10px; padding: 16px; font-size: 13px; }`);
  lines.push(`</style>`);
  lines.push(`</head>`);
  lines.push(`<body>`);
  lines.push(`<main>`);
  lines.push(`  <h1>\${escapeHtml(content.heading)}</h1>`);
  lines.push(`  <p>\${escapeHtml(content.lede)}</p>`);
  lines.push(`  <div class="card">`);
  lines.push(`    <div class="state">Status: no data is shown on this surface yet.</div>`);
  lines.push(`    Live data appears once \${escapeHtml(enablement)}.`);
  lines.push(`  </div>`);
  lines.push(`  <footer>Surfaces are informational only; approvals are rendered by the host.</footer>`);
  lines.push(`</main>`);
  lines.push(`</body>`);
  lines.push(`</html>`);
  lines.push(`\`;`);
  lines.push(`}`);
  return `${lines.join("\n")}\n`;
}

function mainTemplate(name) {
  return `import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { create${pascalIdentifier(name)}Server } from "./server.ts";

// The official plugin host starts this module through its exported main();
// connecting on import is rejected by the host (plugin-host-command.ts requires
// module.main). Keep the direct-run branch for local debugging only.
export async function main(): Promise<void> {
  const server = create${pascalIdentifier(name)}Server();
  let stopping = false;
  async function close(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  }
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  process.stdin.once("end", () => void close());
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
`;
}

function buildScriptTemplate(name) {
  return `import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bundles the plugin to a single dist/server.mjs (same parameters as the
// payswap-plugin and office-runtime official builds: bundle + platform node +
// esm + node24 + createRequire banner). dist/ is a build output consumed by
// the official seed via requiredSeedPaths.
const target = dirname(fileURLToPath(import.meta.url));
const root = join(target, "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
  logOverride: { "direct-eval": "silent" },
});

process.stdout.write(${JSON.stringify(`${name}-plugin: built dist/server.mjs`)} + "\\n");
`;
}

function testTemplate(input) {
  const { name, tools, surfaces, optIn } = input;
  const id = pascalIdentifier(name);
  const lines = [];
  lines.push(`import { Client } from "@modelcontextprotocol/sdk/client/index.js";`);
  lines.push(`import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";`);
  lines.push(`import { afterEach, describe, expect, it } from "vitest";`);
  lines.push(`import {`);
  lines.push(`  TOOL_NAMES,`);
  if (optIn) lines.push(`  OPT_IN_ENV,`);
  if (surfaces.length > 0) {
    lines.push(`  SURFACES,`);
    lines.push(`  PANEL_MIME_TYPE,`);
  }
  lines.push(`} from "./contract.ts";`);
  if (surfaces.length > 0) lines.push(`import { renderPanelHtml } from "./panels.ts";`);
  lines.push(`import { create${id}Server } from "./server.ts";`);
  lines.push(``);
  lines.push(`/** Generated acceptance tests: tool registration, typed refusals, surface resources. */`);
  lines.push(``);
  lines.push(`async function connectClient(env: NodeJS.ProcessEnv) {`);
  lines.push(`  const server = create${id}Server({ env });`);
  lines.push(`  const client = new Client({ name: "${name}-test", version: "0.0.0" });`);
  lines.push(`  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();`);
  lines.push(`  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);`);
  lines.push(`  return { client, server };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`let closer: (() => Promise<void>) | undefined;`);
  lines.push(`afterEach(async () => {`);
  lines.push(`  await closer?.();`);
  lines.push(`  closer = undefined;`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`describe("tool registration", () => {`);
  lines.push(`  it("registers exactly the declared tools", async () => {`);
  lines.push(`    const { client, server } = await connectClient(${optIn ? `{ [OPT_IN_ENV]: "false" }` : `{}`});`);
  lines.push(`    closer = async () => {`);
  lines.push(`      await client.close();`);
  lines.push(`      await server.close();`);
  lines.push(`    };`);
  lines.push(`    const tools = await client.listTools();`);
  lines.push(`    expect([...tools.tools.map((tool) => tool.name)].sort()).toEqual([...TOOL_NAMES].sort());`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`describe("typed refusals", () => {`);
  if (optIn) {
    lines.push(`  const cases: Array<{ env: NodeJS.ProcessEnv; code: string }> = [`);
    lines.push(`    { env: {}, code: "not_opted_in" },`);
    lines.push(`    { env: { [OPT_IN_ENV]: "false" }, code: "not_opted_in" },`);
    lines.push(`    { env: { [OPT_IN_ENV]: "true" }, code: ${JSON.stringify(input.refusals[1]?.code ?? "not_connected")} },`);
    lines.push(`  ];`);
    lines.push(`  for (const { env, code } of cases) {`);
    lines.push(`    it(\`every tool refuses \${code} when env is \${JSON.stringify(env)}\`, async () => {`);
    lines.push(`      const { client, server } = await connectClient(env);`);
    lines.push(`      closer = async () => {`);
    lines.push(`        await client.close();`);
    lines.push(`        await server.close();`);
    lines.push(`      };`);
    lines.push(`      for (const tool of TOOL_NAMES) {`);
    lines.push(`        // The scaffold schema requires one string field; real schemas replace it.`);
    lines.push(`        const result = await client.callTool({ name: tool, arguments: { input: "sample" } });`);
    lines.push(`        expect(result.isError).toBeFalsy();`);
    lines.push(`        const text = (result.content as Array<{ type: string; text?: string }>).find(`);
    lines.push(`          (entry) => entry.type === "text",`);
    lines.push(`        )?.text;`);
    lines.push(`        expect(text).toBeTruthy();`);
    lines.push(`        const envelope = JSON.parse(text as string);`);
    lines.push(`        expect(envelope).toEqual({`);
    lines.push(`          kind: "refused",`);
    lines.push(`          refusal: { code, message: expect.any(String) },`);
    lines.push(`        });`);
    lines.push(`      }`);
    lines.push(`    });`);
    lines.push(`  }`);
    lines.push(``);
    lines.push(`  it("never conflates the two reachable codes", async () => {`);
    lines.push(`    const { client, server } = await connectClient({ [OPT_IN_ENV]: "true" });`);
    lines.push(`    closer = async () => {`);
    lines.push(`      await client.close();`);
    lines.push(`      await server.close();`);
    lines.push(`    };`);
    lines.push(`    const result = await client.callTool({ name: TOOL_NAMES[0], arguments: { input: "sample" } });`);
    lines.push(`    const envelope = JSON.parse(`);
    lines.push(`      (result.content as Array<{ type: string; text?: string }>)[0].text as string,`);
    lines.push(`    );`);
    lines.push(`    expect(envelope.refusal.code).not.toBe("not_opted_in");`);
    lines.push(`  });`);
  } else {
    lines.push(`  it("every tool answers a typed refusal envelope", async () => {`);
    lines.push(`    const { client, server } = await connectClient({});`);
    lines.push(`    closer = async () => {`);
    lines.push(`      await client.close();`);
    lines.push(`      await server.close();`);
    lines.push(`    };`);
    lines.push(`    for (const tool of TOOL_NAMES) {`);
    lines.push(`      const result = await client.callTool({ name: tool, arguments: {} });`);
    lines.push(`      expect(result.isError).toBeFalsy();`);
    lines.push(`      const text = (result.content as Array<{ type: string; text?: string }>).find(`);
    lines.push(`        (entry) => entry.type === "text",`);
    lines.push(`      )?.text;`);
    lines.push(`      const envelope = JSON.parse(text as string);`);
    lines.push(`      expect(envelope.kind).toBe("refused");`);
    lines.push(`      expect(envelope.refusal.message.length).toBeGreaterThan(0);`);
    lines.push(`    }`);
    lines.push(`  });`);
  }
  lines.push(`});`);
  if (surfaces.length > 0) {
    lines.push(``);
    lines.push(`describe("informational surfaces", () => {`);
    lines.push(`  it("serves every declared ui:// resource with the mcp-app mime", async () => {`);
    lines.push(`    const { client, server } = await connectClient(${optIn ? `{ [OPT_IN_ENV]: "false" }` : `{}`});`);
    lines.push(`    closer = async () => {`);
    lines.push(`      await client.close();`);
    lines.push(`      await server.close();`);
    lines.push(`    };`);
    lines.push(`    for (const surface of SURFACES) {`);
    lines.push(`      const resource = await client.readResource({ uri: surface.resourceUri });`);
    lines.push(`      expect(resource.contents).toHaveLength(1);`);
    lines.push(`      const entry = resource.contents[0];`);
    lines.push(`      expect(entry.mimeType).toBe(PANEL_MIME_TYPE);`);
    lines.push(`      expect(String((entry as { text?: string }).text)).toContain("no data is shown");`);
    lines.push(`    }`);
    lines.push(`  });`);
    lines.push(``);
    lines.push(`  it("panels stay informational and dependency-free", () => {`);
    lines.push(`    for (const surface of SURFACES) {`);
    lines.push(`      const html = renderPanelHtml(surface.id);`);
    lines.push(`      const lowered = html.toLowerCase();`);
    lines.push(`      for (const forbidden of ["balance: $", "amount: $"]) {`);
    lines.push(`        expect(lowered.includes(forbidden), \`\${surface.id} must not render placeholder data\`).toBe(false);`);
    lines.push(`      }`);
    lines.push(`      for (const forbidden of ["<script src", '<link rel="stylesheet"']) {`);
    lines.push(`        expect(html.includes(forbidden), \`\${surface.id} must stay dependency-free\`).toBe(false);`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(`  });`);
    lines.push(`});`);
  }
  return `${lines.join("\n")}\n`;
}

function readmeTemplate(input) {
  const { name, pkgDir, tools, surfaces, optIn, serverKey } = input;
  const lines = [];
  lines.push(`# ${name}-plugin (official plugin scaffold)`);
  lines.push(``);
  lines.push(`Generated by the plugin-creator official workspace scaffold. Next steps, in order:`);
  lines.push(``);
  lines.push(`1. Register the official definition: insert the generated block (printed by the`);
  lines.push(`   scaffold or saved via --definition-out) into`);
  lines.push(`   apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts.`);
  lines.push(`   Keep package.json version, manifest version and definition.version equal.`);
  lines.push(`2. Implement the tool handlers in src/server.ts. Each tool currently answers a`);
  lines.push(`   typed refusal envelope; wire it to the host integration (thin proxy through`);
  lines.push(`   the host service boundary; never a second runtime, never plugin-held`);
  lines.push(`   credentials). See the plugin-creator references: official-plugin-lifecycle.md,`);
  lines.push(`   host-broker-integration.md, workspace-plugin-security.md.`);
  lines.push(`3. Extend src/contract.ts as the single source of truth when adding tools,`);
  lines.push(`   refusal codes or surfaces; keep the manifest in sync.`);
  lines.push(`4. Build and verify: pnpm install (workspace link), then pnpm --filter`);
  lines.push(`   @zcode/${name}-plugin build && pnpm --filter @zcode/${name}-plugin test.`);
  lines.push(`5. Run the deterministic audit:`);
  lines.push(`   node skills/plugin-creator/scripts/official-plugin-audit.mjs <plugin-path> <repo-root>`);
  lines.push(`   It checks definition registration, version alignment, required seed paths,`);
  lines.push(`   build outputs, env namespace and credential boundaries.`);
  lines.push(`6. Add host-repo launch tests (see references/production-launch-testing.md):`);
  lines.push(`   bootstrap/tests/${name}-launch-path.test.ts and, for the production dispatch`);
  lines.push(`   chain, bootstrap/tests/${name}-host-launch.test.ts.`);
  lines.push(``);
  lines.push(`Facts pinned by this scaffold:`);
  lines.push(``);
  lines.push(`- Plugin name / manifest name: ${name}`);
  lines.push(`- MCP server key: ${serverKey} (runtime name: plugin:${name}:${serverKey})`);
  lines.push(`- Tools: ${tools.join(", ")}`);
  lines.push(
    `- Surfaces: ${surfaces.map((surface) => `${surface.id} (${surface.resourceUri})`).join(", ") || "none"}`,
  );
  lines.push(
    `- Opt-in gate: ${optIn ? `userConfig.${optIn.key} (default false, env ${optIn.envKey})` : "none"}`,
  );
  lines.push(`- Package directory convention: ${pkgDir}`);
  return `${lines.join("\n")}\n`;
}

function definitionSnippet(input) {
  const { name, version, displayName, displayNameZh, description, descriptionZh, author, pkgDir, surfaces } = input;
  const lines = [];
  lines.push(`    // Official definition for ${name} — insert into OFFICIAL_PLUGIN_DEFINITIONS in`);
  lines.push(`    // apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts,`);
  lines.push(`    // keeping this file's key ordering and comment discipline.`);
  lines.push(`    {`);
  if (surfaces.length > 0) lines.push(`      componentTypes: ["ui"],`);
  lines.push(`      defaultEnabled: false,`);
  lines.push(`      listing: {`);
  lines.push(`        author: { name: ${JSON.stringify(author)} },`);
  lines.push(`        category: "productivity",`);
  lines.push(`        displayName: ${JSON.stringify(displayName)},`);
  lines.push(`        displayName_i18n: { "zh-CN": ${JSON.stringify(displayNameZh ?? displayName)} },`);
  lines.push(`        description_i18n: { "zh-CN": ${JSON.stringify(descriptionZh ?? description)} },`);
  lines.push(`      },`);
  lines.push(`      name: ${JSON.stringify(name)},`);
  lines.push(`      requiredSeedPaths: [".zcode-plugin/plugin.json", "dist/server.mjs"],`);
  lines.push(`      rootCandidates: [`);
  lines.push(`        ${JSON.stringify(`packages/${pkgDir}`)},`);
  lines.push(`        ${JSON.stringify(`../${pkgDir}`)},`);
  lines.push(`        ${JSON.stringify(`../../${pkgDir}`)},`);
  lines.push(`        ${JSON.stringify(`../../../${pkgDir}`)},`);
  lines.push(`      ],`);
  lines.push(`      version: ${JSON.stringify(version)},`);
  lines.push(`    },`);
  return `${lines.join("\n")}\n`;
}

export async function scaffoldOfficialPlugin(options) {
  const rawName = options.name;
  if (!rawName) throw new Error("A plugin name is required");
  const name = normalizePluginName(rawName);
  if (options.force !== true && (await exists(resolve(options.parentPath ?? process.cwd(), `${name}-plugin`))))
    throw new Error(`Plugin directory already exists: ${name}-plugin`);

  const tools = String(options.tools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools.length === 0)
    throw new Error("Declare --tools (an official workspace plugin never ships an empty tool list)");
  for (const tool of tools)
    if (!/^[a-z][a-z0-9_]*$/u.test(tool))
      throw new Error(`Tool names are lower_snake_case: ${tool}`);

  const envNamespace = normalizeEnvNamespace(options.envNamespace ?? name);
  const optInKey = options.optIn
    ? (() => {
        const key = String(options.optIn).trim();
        if (!/^[a-z][a-zA-Z0-9_]*$/u.test(key))
          throw new Error("Opt-in option must be a lowerCamelCase identifier (userConfig key)");
        return key;
      })()
    : undefined;
  const optIn = optInKey
    ? {
        key: optInKey,
        // PAYSWAP_FINANCIALWORKSPACE is wrong; split camelCase into underscores
        // (financialWorkspace -> FINANCIAL_WORKSPACE, the official precedent).
        envKey: `${envNamespace}${optInKey.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase()}`,
      }
    : undefined;
  const refusals = optIn
    ? [
        {
          code: "not_opted_in",
          note: "plugin enabled but the opt-in option is off (default state)",
          message: `${name} surfaces are not enabled. Turn on the option in the plugin settings, then try again.`,
        },
        {
          code: "not_connected",
          note: "opted in but the prerequisite integration is not connected yet",
          message: `${name} is enabled, but its integration is not connected yet. Connect it before using these tools.`,
        },
      ]
    : [
        {
          code: "not_available",
          note: "tool is declared but its host-side handler is not implemented yet",
          message: `${name} has no wired host integration yet.`,
        },
      ];

  const surfaces = options.surfaces ? parseSurfaces(options.surfaces) : [];
  for (const surface of surfaces) {
    surface.resourceUri = `ui://${name}/${surface.id}.html`;
    if (!surface.icon) surface.icon = "layout-panel";
  }

  const version = "0.1.0";
  const description = options.description ?? `${name} official plugin`;
  const author = options.author ?? "Z.ai";
  const displayName = options.displayName ?? name;
  const pkgDir = `${name}-plugin`;
  const serverKey = options.serverKey ? normalizePluginName(options.serverKey) : name;

  const toolDescriptors = tools.map((tool, index) => ({
    index,
    title: tool
      .split("_")
      .slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || tool,
    description: `${tool.replace(/_/g, " ")}. Answers a typed refusal until the host integration is wired; the plugin process holds no credentials or domain state.`,
    schemaVar: /^[a-z]/u.test(tool.replace(/_/g, "")) ? "input" : "payload",
    schemaDescribe: "Primary input for this tool.",
    readOnly: !tool.includes("request") && !tool.includes("create") && !tool.includes("send"),
  }));

  const input = { name, version, description, tools, surfaces, optIn, envNamespace, refusals, toolDescriptors };
  const manifest = {
    name,
    version,
    description,
    author: { name: author },
    license: DEFAULT_LICENSE,
  };
  const mcpEnv = optIn ? { [optIn.envKey]: `\${user_config.${optIn.key}}` } : undefined;
  manifest.mcpServers = {
    [serverKey]: {
      type: "stdio",
      command: "node",
      args: ["${ZCODE_PLUGIN_ROOT}/dist/server.mjs"],
      cwd: "${ZCODE_PROJECT_DIR}",
      ...(mcpEnv ? { env: mcpEnv } : {}),
      isolation: "workspace",
    },
  };
  if (surfaces.length > 0) {
    manifest.ui = {
      surfaces: surfaces.map((surface) => ({
        id: surface.id,
        title: surface.title,
        icon: surface.icon,
        server: serverKey,
        resourceUri: surface.resourceUri,
        availability: "session",
      })),
    };
  }
  if (optIn) {
    manifest.userConfig = {
      [optIn.key]: {
        type: "boolean",
        default: false,
        title: `${displayName} opt-in`,
        description: `Opt in to ${name} surfaces. Off by default: nothing is fetched or shown until this is enabled.`,
      },
    };
  }

  const files = new Map();
  files.set("README.md", readmeTemplate({ name, pkgDir, tools, surfaces, optIn, serverKey }));
  files.set(
    "package.json",
    `${JSON.stringify(
      {
        $schema: "https://json.schemastore.org/package.json",
        name: `@zcode/${pkgDir}`,
        version,
        private: true,
        description,
        license: DEFAULT_LICENSE,
        type: "module",
        scripts: {
          build: "node scripts/build.mjs",
          typecheck: "tsc -p tsconfig.json --noEmit",
          test: "vitest run",
          clean: "node ../../scripts/clean-dist.mjs",
        },
        devDependencies: {
          "@modelcontextprotocol/sdk": SDK_VERSION,
          "@types/node": "^24.0.0",
          esbuild: "^0.25.0",
          typescript: "^6.0.2",
          vitest: "^4.1.5",
          zod: "4.6.5",
        },
        engines: { node: ">=24.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  files.set(
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        include: ["*.ts", "src/**/*.ts", "scripts/**/*.mjs"],
      },
      null,
      2,
    )}\n`,
  );
  files.set(
    "vitest.config.ts",
    `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
`,
  );
  files.set(".zcode-plugin/plugin.json", `${JSON.stringify(manifest, null, 2)}\n`);
  files.set("src/contract.ts", contractTemplate(input));
  files.set("src/server.ts", serverTemplate(input));
  if (surfaces.length > 0) files.set("src/panels.ts", panelsTemplate(input));
  files.set("src/main.ts", mainTemplate(name));
  files.set("src/server.test.ts", testTemplate({ ...input, refusals }));
  files.set("scripts/build.mjs", buildScriptTemplate(name));

  const root = resolve(options.parentPath ?? process.cwd(), pkgDir);
  await rejectSymlink(root);
  if (options.force !== true && (await exists(root)))
    throw new Error(`Plugin directory already exists: ${root}`);
  await mkdir(root, { recursive: true });
  for (const [file, contents] of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, { flag: options.force ? "w" : "wx" });
  }

  const snippet = definitionSnippet({
    name,
    version,
    displayName,
    displayNameZh: options.displayNameZh,
    description,
    descriptionZh: options.descriptionZh,
    author,
    pkgDir,
    surfaces,
  });
  if (options.definitionOut) {
    await mkdir(dirname(resolve(options.definitionOut)), { recursive: true });
    await writeFile(resolve(options.definitionOut), snippet, { flag: "wx" });
  }

  return { root, manifest, definitionSnippet: snippet, files: [...files.keys()] };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      path: { type: "string" },
      tools: { type: "string" },
      surfaces: { type: "string" },
      "opt-in": { type: "string" },
      "env-namespace": { type: "string" },
      "display-name": { type: "string" },
      "display-name-zh": { type: "string" },
      description: { type: "string" },
      "description-zh": { type: "string" },
      author: { type: "string" },
      "server-key": { type: "string" },
      "definition-out": { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: node scaffold-official-plugin.mjs <name> --tools t1,t2 [--surfaces id:Title|zh] [--opt-in option] [--path parent] [--definition-out file] [--force]",
    );
  const result = await scaffoldOfficialPlugin({
    name: positionals[0],
    parentPath: values.path,
    tools: values.tools,
    surfaces: values.surfaces,
    optIn: values["opt-in"],
    envNamespace: values["env-namespace"],
    displayName: values["display-name"],
    displayNameZh: values["display-name-zh"],
    description: values.description,
    descriptionZh: values["description-zh"],
    author: values.author,
    serverKey: values["server-key"],
    definitionOut: values["definition-out"],
    force: values.force,
  });
  process.stdout.write(
    `${JSON.stringify({ root: result.root, files: result.files }, null, 2)}\n${result.definitionSnippet}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
