import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { scaffoldOfficialPlugin } from "../skills/plugin-creator/scripts/scaffold-official-plugin.mjs";
import {
  auditOfficialPlugin,
  findOfficialDefinition,
  parseOfficialDefinitions,
} from "../skills/plugin-creator/scripts/official-plugin-audit.mjs";
import { preflightPlugin } from "../skills/plugin-creator/scripts/validate-plugin.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREE_ROOT = resolve(PACKAGE_ROOT, "..", "..", "..", "..");

/** Minimal definitions file mirroring the real bootstrap file's structure. */
const DEFINITIONS_FIXTURE = `import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

export interface OfficialPluginDefinition {
  componentTypes?: readonly string[];
  defaultEnabled?: boolean;
  listing?: Record<string, unknown>;
  name: string;
  requiredSeedPaths?: readonly string[];
  rootCandidates: readonly string[];
  version: string;
}

export const OFFICIAL_FIXTURE_REQUIRED_SEED_PATHS = [
  ".zcode-plugin/plugin.json",
  "dist/server.mjs",
] as const;

export const OFFICIAL_PLUGIN_DEFINITIONS: readonly OfficialPluginDefinition[] = [
  {
    componentTypes: ["ui"],
    defaultEnabled: false,
    listing: {
      // The author URL exercises https:// inside a string (comment-strip trap).
      author: { name: "Z.ai", url: "https://z.ai" },
      category: "productivity",
      displayName: "Fixture Workspace",
    },
    name: "fixture-workspace",
    requiredSeedPaths: OFFICIAL_FIXTURE_REQUIRED_SEED_PATHS,
    rootCandidates: ["packages/fixture-workspace-plugin", "../fixture-workspace-plugin"],
    version: "0.1.0",
  },
  ...(
    [
      ["map-plugin", "map", "Map Plugin", "映射插件", "0.2.0"],
    ] as const
  ).map(
    ([name, skill, displayName, chineseName, version]): OfficialPluginDefinition => ({
      defaultEnabled: true,
      listing: { category: "productivity", displayName, displayName_i18n: { "zh-CN": chineseName } },
      name,
      requiredSeedPaths: [\`skills/\${skill}/SKILL.md\`],
      rootCandidates: [\`packages/\${name}-plugin\`, \`../\${name}-plugin\`],
      version,
    }),
  ),
];
`;

const FIXTURE_SERVER_BUNDLE = `// minimal fixture "bundle": registers a tool and exports main()
const registry = [];
function registerTool(name) {
  registry.push(name);
}
registerTool("fixture_get_status");
async function main() {}
export { main };
`;

async function writeFixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), "creator-official-repo-"));
  await writeFile(join(repo, "official-plugin-definitions.ts"), DEFINITIONS_FIXTURE);
  return repo;
}

/** Scaffold + fake build output + definition registration: the clean audit case. */
async function writeCleanFixture(repo) {
  const scaffold = await scaffoldOfficialPlugin({
    name: "fixture-workspace",
    parentPath: repo,
    tools: "fixture_get_status,fixture_compile_thing",
    surfaces: "overview:Overview|概览",
    optIn: "financialWorkspace",
    envNamespace: "FIXTURE",
    author: "Z.ai",
  });
  const pluginRoot = scaffold.root;
  await mkdir(join(pluginRoot, "dist"), { recursive: true });
  await writeFile(join(pluginRoot, "dist", "server.mjs"), FIXTURE_SERVER_BUNDLE);
  // Make the fake artifact newer than every source input (fresh build).
  const now = new Date();
  await utimes(join(pluginRoot, "dist", "server.mjs"), now, now);
  return pluginRoot;
}

test("official scaffold generates a complete workspace plugin package", async () => {
  const parent = await mkdtemp(join(tmpdir(), "creator-official-scaffold-"));
  try {
    const result = await scaffoldOfficialPlugin({
      name: "fixture-workspace",
      parentPath: parent,
      tools: "fixture_get_status,fixture_compile_thing",
      surfaces: "overview:Overview|概览,details:Details|详情",
      optIn: "financialWorkspace",
      envNamespace: "FIXTURE",
    });
    const root = result.root;
    for (const file of [
      "package.json",
      "tsconfig.json",
      "vitest.config.ts",
      "README.md",
      ".zcode-plugin/plugin.json",
      "src/contract.ts",
      "src/server.ts",
      "src/panels.ts",
      "src/main.ts",
      "src/server.test.ts",
      "scripts/build.mjs",
    ]) {
      assert.ok(existsSync(join(root, file)), `missing generated file: ${file}`);
    }
    const manifest = JSON.parse(await readFile(join(root, ".zcode-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "fixture-workspace");
    assert.equal(manifest.mcpServers["fixture-workspace"].isolation, "workspace");
    assert.deepEqual(manifest.mcpServers["fixture-workspace"].env, {
      FIXTURE_FINANCIAL_WORKSPACE: "${user_config.financialWorkspace}",
    });
    // CamelCase opt-in options split into the plugin's snake-case env namespace
    // (financialWorkspace -> FIXTURE_FINANCIAL_WORKSPACE, the PAYSWAP_ precedent).
    const contract = await readFile(join(root, "src", "contract.ts"), "utf8");
    assert.match(contract, /export const OPT_IN_ENV = "FIXTURE_FINANCIAL_WORKSPACE"/);
    assert.equal(manifest.userConfig.financialWorkspace.default, false);
    assert.equal(manifest.ui.surfaces.length, 2);
    assert.equal(manifest.ui.surfaces[0].availability, "session");
    assert.ok(manifest.ui.surfaces[0].resourceUri.startsWith("ui://fixture-workspace/"));
    assert.match(contract, /"fixture_get_status",/);
    assert.match(contract, /"not_opted_in"/);
    assert.match(contract, /export const PLUGIN_OUTPUTS/);
    const main = await readFile(join(root, "src", "main.ts"), "utf8");
    assert.match(main, /export async function main\(\)/);
    const testFile = await readFile(join(root, "src", "server.test.ts"), "utf8");
    assert.match(testFile, /InMemoryTransport/);
    assert.match(testFile, /not_opted_in/);
    // The generated package passes the generic preflight (paths, placeholders).
    assert.deepEqual(await preflightPlugin(root), []);
    // Scaffolding refuses an existing directory.
    await assert.rejects(
      scaffoldOfficialPlugin({ name: "fixture-workspace", parentPath: parent, tools: "t_one" }),
      /exists/i,
    );
    // Empty tool lists are refused up front.
    await assert.rejects(
      scaffoldOfficialPlugin({ name: "empty-tools", parentPath: parent }),
      /--tools/,
    );
    // The definition snippet pins name, version and default-off consent.
    assert.match(result.definitionSnippet, /name: "fixture-workspace"/);
    assert.match(result.definitionSnippet, /defaultEnabled: false/);
    assert.match(result.definitionSnippet, /version: "0.1.0"/);
    assert.match(result.definitionSnippet, /componentTypes: \["ui"\]/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("official audit passes a clean registered fixture and enforces the official laws", async () => {
  const repo = await writeFixtureRepo();
  try {
    const pluginRoot = await writeCleanFixture(repo);
    const clean = await auditOfficialPlugin({ pluginPath: pluginRoot, definitionsPath: join(repo, "official-plugin-definitions.ts") });
    assert.deepEqual(clean.errors, []);
    assert.equal(clean.definition.name, "fixture-workspace");
    assert.equal(clean.contractNamespace, "FIXTURE_");

    const auditWith = (mutations) =>
      auditOfficialPlugin({
        pluginPath: pluginRoot,
        definitionsPath: join(repo, "official-plugin-definitions.ts"),
        ...mutations,
      });
    const errorsOf = async (mutations) => (await auditWith(mutations)).errors.join("\n");

    // Version triangle (package.json / manifest / definition).
    const manifestPath = join(pluginRoot, ".zcode-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "0.2.0";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    assert.match(await errorsOf(), /version misalignment/);
    manifest.version = "0.1.0";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Missing required seed path / build output.
    const dist = join(pluginRoot, "dist", "server.mjs");
    const distBackup = await readFile(dist, "utf8");
    await rm(dist);
    assert.match(await errorsOf(), /missing required seed path|runtime artifact missing/);
    await writeFile(dist, distBackup);

    // Consent law: opt-in gate + defaultEnabled:true is rejected.
    const definitionsPath = join(repo, "official-plugin-definitions.ts");
    const original = await readFile(definitionsPath, "utf8");
    await writeFile(definitionsPath, original.replace("defaultEnabled: false,", "defaultEnabled: true,"));
    assert.match(await errorsOf(), /opt-in userConfig gate/);
    await writeFile(definitionsPath, original);

    // Credential-shaped manifest env keys are rejected.
    const manifest2 = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest2.mcpServers["fixture-workspace"].env.FIXTURE_API_KEY = "x";
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));
    assert.match(await errorsOf(), /credential/i);
    delete manifest2.mcpServers["fixture-workspace"].env.FIXTURE_API_KEY;
    manifest2.mcpServers["fixture-workspace"].env.ZCODE_PLUGIN_ID = "x";
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));
    assert.match(await errorsOf(), /host-authoritative/);
    delete manifest2.mcpServers["fixture-workspace"].env.ZCODE_PLUGIN_ID;
    manifest2.mcpServers["fixture-workspace"].env.OUTSIDE_NAMESPACE = "${user_config.financialWorkspace}";
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));
    assert.match(await errorsOf(), /outside the plugin namespace/);
    delete manifest2.mcpServers["fixture-workspace"].env.OUTSIDE_NAMESPACE;
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));

    // alwaysLoad is not consent — the error fires when the server does NOT
    // consume the opt-in env (the scaffolded fixture consumes it by design,
    // so the negative case removes the env wiring first).
    const savedOptInEnv = manifest2.mcpServers["fixture-workspace"].env.FIXTURE_FINANCIAL_WORKSPACE;
    delete manifest2.mcpServers["fixture-workspace"].env.FIXTURE_FINANCIAL_WORKSPACE;
    manifest2.mcpServers["fixture-workspace"].alwaysLoad = true;
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));
    assert.match(await errorsOf(), /alwaysLoad/);
    manifest2.mcpServers["fixture-workspace"].env.FIXTURE_FINANCIAL_WORKSPACE = savedOptInEnv;
    delete manifest2.mcpServers["fixture-workspace"].alwaysLoad;
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));

    // ADR-P2-3 payswap precedent: alwaysLoad + default-off opt-in is lawful when
    // the SERVER consumes the opt-in via its env (consent enforced server-side);
    // the error is reserved for residency without server-side consent evidence.
    manifest2.mcpServers["fixture-workspace"].alwaysLoad = true;
    manifest2.mcpServers["fixture-workspace"].env.FIXTURE_FINANCIAL_WORKSPACE =
      "${user_config.financialWorkspace}";
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));
    assert.doesNotMatch(await errorsOf(), /alwaysLoad/);
    delete manifest2.mcpServers["fixture-workspace"].env.FIXTURE_FINANCIAL_WORKSPACE;
    delete manifest2.mcpServers["fixture-workspace"].alwaysLoad;
    await writeFile(manifestPath, JSON.stringify(manifest2, null, 2));

    // UI surface must name a declared server.
    const manifest3 = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest3.ui.surfaces[0].server = "other";
    await writeFile(manifestPath, JSON.stringify(manifest3, null, 2));
    assert.match(await errorsOf(), /must name a server declared in mcpServers/);
    manifest3.ui.surfaces[0].server = "fixture-workspace";
    await writeFile(manifestPath, JSON.stringify(manifest3, null, 2));

    // Entry contract: main export + non-empty tool surface.
    await writeFile(dist, "async function main() {}\n");
    assert.match(await errorsOf(), /export main/);
    await writeFile(dist, "const tools = [];\nif (method === 'tools/list') return { tools: [] };\nthrow new Error('Method not found');\nexport { tools };\n");
    assert.match(await errorsOf(), /empty tool list/);
    await writeFile(dist, FIXTURE_SERVER_BUNDLE);
    assert.deepEqual((await auditWith()).errors, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("definitions parser resolves constants, detects map-generated entries and absent names", async () => {
  const parsed = parseOfficialDefinitions(DEFINITIONS_FIXTURE);
  assert.equal(parsed.definitions.length, 1);
  const definition = parsed.definitions[0];
  assert.equal(definition.name, "fixture-workspace");
  assert.equal(definition.version, "0.1.0");
  assert.equal(definition.defaultEnabled, false);
  assert.deepEqual(definition.componentTypes, ["ui"]);
  assert.deepEqual(definition.requiredSeedPaths, [".zcode-plugin/plugin.json", "dist/server.mjs"]);
  assert.deepEqual(definition.rootCandidates[0], "packages/fixture-workspace-plugin");
  const literal = findOfficialDefinition(parsed, "fixture-workspace");
  assert.equal(literal.generated, false);
  const generated = findOfficialDefinition(parsed, "map-plugin");
  assert.ok(generated);
  assert.equal(generated.generated, true);
  assert.equal(findOfficialDefinition(parsed, "absent-plugin"), undefined);
});

test("golden reference: the production payswap plugin audits clean against the real definitions", { skip: !existsSync(join(WORKTREE_ROOT, "apps", "zcode-cli", "packages", "bootstrap", "src", "app", "official-plugin-definitions.ts")) }, async () => {
  const result = await auditOfficialPlugin({
    pluginPath: join(WORKTREE_ROOT, "apps", "zcode-cli", "packages", "payswap-plugin"),
    repoRoot: WORKTREE_ROOT,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.definition.name, "payswap");
  assert.equal(result.definition.version, "0.1.0");
  assert.equal(result.contractNamespace, "PAYSWAP_");
});
