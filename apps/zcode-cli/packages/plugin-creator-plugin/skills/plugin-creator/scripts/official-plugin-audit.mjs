import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { preflightPlugin } from "./validate-plugin.mjs";

/**
 * Deterministic audit for a plugin package intended to become an official
 * built-in ZCode plugin (Profiles 2/3 in SKILL.md). It checks *consistency*
 * between the plugin package and the host's official plugin machinery; it does
 * NOT re-implement the manifest schema (that stays with `zcode plugins
 * validate` and the adapters loader).
 *
 * Checks, each pinned to the real host behavior it mirrors:
 * 1. Official definition registration + version triangle
 *    (bootstrap/tests/plugins.test.ts "keeps every bundled plugin package,
 *    manifest, and seed version aligned").
 * 2. requiredSeedPaths exist on disk, including dist build outputs
 *    (bootstrap bundled-plugins.ts findMissingOfficialPluginSeedPaths refuses
 *    to seed an incomplete plugin).
 * 3. componentTypes "ui" ↔ manifest ui.surfaces
 *    (bootstrap/tests/plugins.test.ts "declares the ui component type exactly").
 * 4. ui.surfaces entry validation (adapters/src/plugins/ui-surfaces.ts rules:
 *    id pattern, title, server must name a declared mcpServers key, ui://
 *    resourceUri, availability "session").
 * 5. Runtime host integration: manifest stdio args must resolve to existing
 *    artifacts after ${ZCODE_PLUGIN_ROOT} substitution, and the entry must
 *    export main() (cli/src/plugin-host-command.ts: "Plugin server does not
 *    export main()"). Stale build outputs are reported.
 * 6. Tool implementations: the built entry must register tools and must not be
 *    the basic scaffold's empty-tool handshake server.
 * 7. Credential/secret boundary: reserved host env keys, the PaySwap broker
 *    five-key credential group and credential-shaped keys are rejected in
 *    manifest mcpServers.*.env (packages/shared/src/payswap/broker-env.ts §4.2:
 *    credentials only flow through the trusted config-injection path);
 *    manifest env keys must live in the plugin's own namespace; alwaysLoad
 *    is never treated as user consent.
 * 8. Manifest variable resolution that the adapters resolver would reject
 *    (adapters/src/plugins/mcp.ts resolveTemplate): unknown user_config keys,
 *    sensitive user_config in command/args, session/skill template tokens.
 * 9. Host-repo launch test wiring for this plugin (warning when absent).
 */

const DEFAULT_DEFINITIONS_RELATIVE = join(
  "apps",
  "zcode-cli",
  "packages",
  "bootstrap",
  "src",
  "app",
  "official-plugin-definitions.ts",
);

/** Host-authoritative env keys the resolver overwrites; a manifest must not set them. */
const RESERVED_HOST_ENV_KEYS = new Set([
  "ZCODE_PLUGIN_ID",
  "CLAUDE_PLUGIN_ID",
  "ZCODE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "ZCODE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_DATA",
  "ZCODE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIR",
  "ELECTRON_RUN_AS_NODE",
]);

/** Broker credential env keys (packages/shared/src/payswap/broker-env.ts). Never serializable. */
const PAYSWAP_BROKER_CREDENTIAL_ENV_KEYS = [
  "PAYSWAP_BROKER_SOCKET",
  "PAYSWAP_BROKER_TOKEN",
  "PAYSWAP_BROKER_INSTANCE_ID",
  "PAYSWAP_BROKER_HOST_ID",
  "PAYSWAP_BROKER_VERIFY_KEY",
  "PAYSWAP_BROKER_HELPER_PATH",
  "PAYSWAP_BROKER_HELPER_SHA256",
];

const CREDENTIAL_SHAPED_KEY = /(^|_)(API_?KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIALS?)(_|$)/iu;
const SECRET_LITERAL_PATTERNS = [
  [/sk-[A-Za-z0-9]{16,}/u, "OpenAI-style key literal"],
  [/AKIA[0-9A-Z]{16}/u, "AWS access key id literal"],
  [/ghp_[A-Za-z0-9]{20,}/u, "GitHub token literal"],
  [/xox[bpars]-[A-Za-z0-9-]{10,}/u, "Slack token literal"],
];
const SESSION_TEMPLATE_KEYS = [
  "ZCODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "ZCODE_SKILL_DIR",
  "CLAUDE_SKILL_DIR",
];
const RESOLVABLE_PATH_TOKENS = new Set([
  "ZCODE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "ZCODE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_DATA",
  "ZCODE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIR",
]);
const SURFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const SURFACE_RESOURCE_URI_MAX = 2048;
const MANIFEST_ENV_NAMESPACE_EXPORT = /([A-Z0-9_]*ENV_NAMESPACE|[A-Z0-9_]*ENV_PREFIX)\s*=\s*"([^"]+)"/u;

function outside(root, path) {
  const value = relative(root, path);
  return value === ".." || value.startsWith(`..${sep}`) || isAbsoluteLeaf(value);
}

function isAbsoluteLeaf(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith(sep) || value.startsWith("/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve `export const NAME = "value"` string constants in the definitions file. */
function extractStringConstants(text) {
  const constants = new Map();
  for (const match of text.matchAll(/export const (\w+) = "([^"]*)"/gu)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

/** Resolve `export const X_REQUIRED_SEED_PATHS = ["a", "b"] as const` arrays. */
function extractSeedPathConstants(text) {
  const constants = new Map();
  for (const match of text.matchAll(/export const (\w+REQUIRED_SEED_PATHS) = \[([^\]]*)\] as const/gu)) {
    const values = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((entry) => entry[1]);
    constants.set(match[1], values);
  }
  return constants;
}

/**
 * Collapse nested object/array literals to a marker so a regex for a scalar
 * field like `name:` can no longer match a nested `listing.name`. String
 * literals are placeholder-protected first (braces inside strings must not
 * confuse the collapse) and restored afterwards so scalar values survive.
 */
function topLevelView(slice) {
  const strings = [];
  let text = slice
    // Strings first: comment markers inside string literals (e.g. https:// in a
    // listing URL) must not corrupt the pairing of quotes.
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, (match) => {
      strings.push(match);
      return `\x00${strings.length - 1}\x00`;
    })
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ");
  let changed = true;
  while (changed) {
    changed = false;
    text = text.replace(/\{[^{}[\]]*\}|\[[^{}[\]]*\]/gu, (match) => {
      if (match === "{}") return match;
      changed = true;
      // Keep a brace pair: the element's own outer object must never collapse.
      return "{}";
    });
  }
  return text.replace(/\x00(\d+)\x00/gu, (match, index) => strings[Number(index)] ?? '""');
}

/** Extract a string-array field from the original slice by bracket matching. */
function extractStringArrayField(slice, field, seedPathConstants) {
  const literal = new RegExp(`${field}\\s*:\\s*\\[`, "u").exec(slice);
  if (literal) {
    let depth = 0;
    let end = -1;
    const start = literal.index + literal[0].length - 1;
    for (let index = start; index < slice.length; index += 1) {
      const char = slice[index];
      if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end > start) {
      const inner = slice.slice(start + 1, end);
      return [...inner.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((entry) => entry[1]);
    }
    return undefined;
  }
  const view = topLevelView(slice);
  const reference = new RegExp(`${field}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)`, "u").exec(view);
  if (reference && seedPathConstants.has(reference[1])) {
    return seedPathConstants.get(reference[1]);
  }
  return undefined;
}

/** Resolve a scalar string field at the element's top level (never inside nested objects). */
function extractScalarField(slice, field, constants) {
  const view = topLevelView(slice);
  const literal = new RegExp(`(?:^|[,{\\n(])\\s*${field}\\s*:\\s*"([^"]*)"`, "u").exec(view);
  if (literal) return literal[1];
  const reference = new RegExp(`(?:^|[,{\\n(])\\s*${field}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)`, "u").exec(view);
  if (reference) return constants.get(reference[1]);
  return undefined;
}

/**
 * Parse OFFICIAL_PLUGIN_DEFINITIONS from the bootstrap TypeScript source.
 * Literal `{ ... }` elements are parsed field by field; entries generated by
 * `.map(...)` (document plugins) are reported as `generated: true` so the
 * caller can verify them manually instead of failing hard.
 */
export function parseOfficialDefinitions(text) {
  const constants = extractStringConstants(text);
  const seedPathConstants = extractSeedPathConstants(text);
  const definitions = [];
  const declaration = /OFFICIAL_PLUGIN_DEFINITIONS[^=]*=\s*\[/u.exec(text);
  if (!declaration) return { definitions, constants, seedPathConstants };
  const arrayStart = declaration.index + declaration[0].length - 1;
  const arrayEnd = text.indexOf("];", arrayStart);
  const raw = arrayEnd > arrayStart ? text.slice(arrayStart, arrayEnd) : text.slice(arrayStart);
  let depth = 0;
  let elementStart = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "{") {
      if (depth === 0) elementStart = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && elementStart >= 0) {
        const slice = raw.slice(elementStart, index + 1);
        elementStart = -1;
        const name = extractScalarField(slice, "name", constants);
        if (!name) continue;
        const version = extractScalarField(slice, "version", constants);
        const view = topLevelView(slice);
        const defaultEnabled = /defaultEnabled\s*:\s*true/u.test(view)
          ? true
          : /defaultEnabled\s*:\s*false/u.test(view)
            ? false
            : undefined;
        const componentTypes = extractStringArrayField(slice, "componentTypes", seedPathConstants);
        const rootCandidates = extractStringArrayField(slice, "rootCandidates", seedPathConstants);
        const requiredSeedPaths = extractStringArrayField(slice, "requiredSeedPaths", seedPathConstants);
        const runtimeTopLevelPaths = extractStringArrayField(slice, "runtimeTopLevelPaths", seedPathConstants);
        const hostMcpServerNames = extractStringArrayField(slice, "hostMcpServerNames", seedPathConstants);
        definitions.push({
          name,
          version,
          defaultEnabled,
          componentTypes,
          rootCandidates,
          requiredSeedPaths,
          runtimeTopLevelPaths,
          hostMcpServerNames,
        });
      }
    }
  }
  return { definitions, constants, seedPathConstants, raw };
}

/** Resolve a definition by plugin name; map-generated entries surface as `generated`. */
export function findOfficialDefinition(parsed, name) {
  const literal = parsed.definitions.find((definition) => definition.name === name);
  if (literal) return { ...literal, generated: false };
  // The document plugins are produced by `.map(...)` over tuple arrays; a name
  // that only appears inside such a tuple region is still registered.
  if (parsed.raw) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of parsed.raw.matchAll(/\.map\(/gu)) {
      const window = parsed.raw.slice(Math.max(0, match.index - 600), match.index);
      if (new RegExp(`"${escaped}"`, "u").test(window)) return { name, generated: true };
    }
  }
  return undefined;
}

async function collectInputMtimes(pluginRoot) {
  const mtimes = [];
  async function walk(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          mtimes.push((await stat(full)).mtimeMs);
        } catch {
          /* ignore unreadable inputs */
        }
      }
    }
  }
  await walk(pluginRoot, 0);
  return mtimes;
}

/** Main entry: audit one plugin package against the host definitions file. */
export async function auditOfficialPlugin(input) {
  const pluginPath = resolve(input.pluginPath);
  const repoRoot = input.repoRoot ? resolve(input.repoRoot) : undefined;
  const definitionsPath = resolve(
    input.definitionsPath ?? (repoRoot ? join(repoRoot, DEFAULT_DEFINITIONS_RELATIVE) : pluginPath),
  );
  const errors = [];
  const warnings = [];
  const notes = [];

  // 0. Generic preflight (placeholders, resource containment).
  for (const error of await preflightPlugin(pluginPath)) errors.push(`preflight: ${error}`);

  const manifestPath = join(pluginPath, ".zcode-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let packageVersion;
  try {
    const pkg = JSON.parse(await readFile(join(pluginPath, "package.json"), "utf8"));
    packageVersion = pkg.version;
  } catch {
    warnings.push("package.json is missing or unreadable; official plugins need one for the version triangle");
  }

  const pluginName = manifest.name;
  const mcpServers = isRecord(manifest.mcpServers) ? manifest.mcpServers : {};
  const serverKeys = Object.keys(mcpServers);
  const surfaces = isRecord(manifest.ui) && Array.isArray(manifest.ui.surfaces) ? manifest.ui.surfaces : [];

  // 1. Official definition registration + version triangle.
  let definition;
  if (repoRoot || input.definitionsPath) {
    const parsed = parseOfficialDefinitions(await readFile(definitionsPath, "utf8"));
    definition = findOfficialDefinition(parsed, pluginName);
    if (!definition) {
      errors.push(
        `missing official definition: "${pluginName}" is not registered in ${relative(repoRoot ?? pluginPath, definitionsPath)}`,
      );
    } else if (definition.generated) {
      warnings.push(
        `official definition for "${pluginName}" is generated by a .map() entry; verify version, listing and requiredSeedPaths manually in official-plugin-definitions.ts`,
      );
    } else {
      const triangle = {
        definition: definition.version,
        manifest: manifest.version,
        package: packageVersion,
      };
      const unique = new Set(Object.values(triangle));
      if (unique.size !== 1 || unique.has(undefined)) {
        errors.push(
          `version misalignment across package.json / manifest / official definition: ${JSON.stringify(triangle)}`,
        );
      }
      const firstCandidate = definition.rootCandidates?.[0];
      if (firstCandidate && basename(firstCandidate) !== basename(pluginPath)) {
        errors.push(
          `definition rootCandidates[0] "${firstCandidate}" does not point at this package directory (${basename(pluginPath)})`,
        );
      }
      // componentTypes "ui" ↔ ui.surfaces (bootstrap plugins.test.ts discipline).
      const declaredUi = definition.componentTypes?.includes("ui") ?? false;
      if (declaredUi !== (surfaces.length > 0)) {
        errors.push(
          `componentTypes "ui" (${declaredUi}) does not match manifest ui.surfaces (${surfaces.length} entries)`,
        );
      }
      // 2. requiredSeedPaths exist (also covers dist build outputs).
      for (const required of definition.requiredSeedPaths ?? []) {
        try {
          await stat(join(pluginPath, ...required.split("/")));
        } catch {
          errors.push(`missing required seed path (build output?): ${required}`);
        }
      }
      // Consent law: an opt-in gate in userConfig forbids default-on registration.
      const hasOptInGate = Object.values(manifest.userConfig ?? {}).some(
        (option) => isRecord(option) && option.default === false,
      );
      if (definition.defaultEnabled === true && hasOptInGate) {
        errors.push(
          "definition sets defaultEnabled:true while the manifest declares an opt-in userConfig gate (default:false); opt-in requires default-off",
        );
      }
      if (definition.defaultEnabled === true && serverKeys.length > 0) {
        warnings.push(
          "defaultEnabled:true on an MCP-bearing plugin is reserved for reviewed content plugins; confirm the product decision",
        );
      }
    }
  } else {
    notes.push("no repo root given: definition registration and seed-path checks skipped");
  }

  // 4. ui.surfaces validation (adapters/src/plugins/ui-surfaces.ts rules).
  const seenSurfaceIds = new Set();
  for (const [index, raw] of surfaces.entries()) {
    const where = `ui.surfaces[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${where}: entry must be an object`);
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!SURFACE_ID_PATTERN.test(id) || id.length > 128) {
      errors.push(`${where}: id must match [A-Za-z0-9][A-Za-z0-9_.-]* (<=128 chars)`);
    } else if (seenSurfaceIds.has(id)) {
      errors.push(`${where}: duplicate surface id "${id}"`);
    } else {
      seenSurfaceIds.add(id);
    }
    const title = raw.title;
    const titleOk =
      (typeof title === "string" && title.trim().length > 0) ||
      (isRecord(title) && Object.values(title).some((value) => typeof value === "string" && value.trim()));
    if (!titleOk) errors.push(`${where}: title must be a non-empty string or locale map`);
    if (typeof raw.server !== "string" || !serverKeys.includes(raw.server)) {
      errors.push(`${where}: server "${raw.server}" must name a server declared in mcpServers`);
    }
    const resourceUri = typeof raw.resourceUri === "string" ? raw.resourceUri : "";
    if (!resourceUri.startsWith("ui://") || resourceUri.length > SURFACE_RESOURCE_URI_MAX) {
      errors.push(`${where}: resourceUri must start with ui:// and be <= ${SURFACE_RESOURCE_URI_MAX} chars`);
    }
    if (raw.availability !== "session") {
      errors.push(`${where}: availability must be "session"`);
    }
  }

  // 5+6+7+8. MCP servers: artifacts, tool implementations, env boundaries, templates.
  const userConfig = isRecord(manifest.userConfig) ? manifest.userConfig : {};
  let contractNamespace;
  for (const contractCandidate of ["contract.ts", "src/contract.ts", "contract.js", "src/contract.js"]) {
    try {
      const text = await readFile(join(pluginPath, ...contractCandidate.split("/")), "utf8");
      const match = MANIFEST_ENV_NAMESPACE_EXPORT.exec(text);
      if (match) {
        contractNamespace = match[2];
        break;
      }
    } catch {
      /* contract file optional */
    }
  }
  for (const [serverKey, rawServer] of Object.entries(mcpServers)) {
    const where = `mcpServers.${serverKey}`;
    if (!isRecord(rawServer)) {
      errors.push(`${where}: server config must be an object`);
      continue;
    }
    const type = typeof rawServer.type === "string" ? rawServer.type : "stdio";
    if (type !== "stdio") {
      notes.push(`${where}: ${type} server; local artifact checks skipped`);
      continue;
    }
    if (typeof rawServer.command !== "string" || !Array.isArray(rawServer.args) || rawServer.args.length === 0) {
      errors.push(`${where}: stdio servers need command and args`);
      continue;
    }
    // Variable resolution the adapters resolver would reject.
    const declaredOptionKeys = new Set(Object.keys(userConfig));
    const sensitiveOptions = new Set(
      Object.entries(userConfig)
        .filter(([, option]) => isRecord(option) && option.sensitive === true)
        .map(([key]) => key),
    );
    const checkTemplateField = (field, value, allowSensitive) => {
      if (typeof value !== "string") return;
      for (const match of value.matchAll(/\$\{([^}]+)\}/gu)) {
        const token = match[1];
        if (RESOLVABLE_PATH_TOKENS.has(token)) continue;
        if (token.startsWith("user_config.")) {
          const key = token.slice("user_config.".length);
          if (!declaredOptionKeys.has(key)) {
            errors.push(`${where}: ${field} references undeclared userConfig key "${key}"`);
          } else if (!allowSensitive && sensitiveOptions.has(key)) {
            errors.push(
              `${where}: ${field} references sensitive userConfig key "${key}" (adapters resolves sensitive values only in env sinks)`,
            );
          }
        } else if (SESSION_TEMPLATE_KEYS.includes(token)) {
          errors.push(`${where}: ${field} uses runtime-only template token "${token}" (rejected by the resolver)`);
        } else if (!token.startsWith("ZCODE_") && !token.startsWith("CLAUDE_") && !allowSensitive) {
          warnings.push(`${where}: ${field} template \${${token}} is not resolved by the adapters resolver outside env sinks`);
        }
      }
    };
    checkTemplateField("command", rawServer.command, false);
    for (const arg of rawServer.args) checkTemplateField("args", arg, false);
    checkTemplateField("cwd", rawServer.cwd, false);
    const env = isRecord(rawServer.env) ? rawServer.env : {};
    for (const [key, value] of Object.entries(env)) {
      if (RESERVED_HOST_ENV_KEYS.has(key)) {
        errors.push(`${where}.env: "${key}" is host-authoritative and must not be set by the manifest`);
      }
      if (PAYSWAP_BROKER_CREDENTIAL_ENV_KEYS.includes(key) || CREDENTIAL_SHAPED_KEY.test(key)) {
        errors.push(
          `${where}.env: "${key}" looks like a credential; credentials never travel in serializable manifest env (trusted host injection only, broker-env.ts §4.2)`,
        );
      }
      if (contractNamespace && !key.startsWith(contractNamespace) && !RESERVED_HOST_ENV_KEYS.has(key)) {
        errors.push(
          `${where}.env: key "${key}" is outside the plugin namespace ${contractNamespace} declared in src/contract.ts`,
        );
      }
      checkTemplateField(`env.${key}`, value, true);
    }
    if (!contractNamespace && Object.keys(env).length > 0) {
      warnings.push(
        `${where}.env has keys but src/contract.ts does not pin PLUGIN_ENV_NAMESPACE (precedent: PAYSWAP_* / ANDROID_PLUGIN_* / IOS_SIM_*)`,
      );
    }
    if (rawServer.alwaysLoad === true && Object.values(userConfig).some((option) => isRecord(option) && option.default === false)) {
      errors.push(
        `${where}: alwaysLoad:true together with an opt-in gate — alwaysLoad is not user consent; keep the default-off registration`,
      );
    }
    if (rawServer.alwaysLoad === true) {
      warnings.push(`${where}: alwaysLoad:true bypasses tool deferral; confirm the product decision (it is never consent)`);
    }
    // Artifacts + entry checks.
    let entryText;
    for (const arg of rawServer.args) {
      if (typeof arg !== "string") continue;
      const substituted = arg.replaceAll("${ZCODE_PLUGIN_ROOT}", pluginPath).replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginPath);
      if (!/\.(mjs|cjs|js)$/u.test(substituted)) continue;
      const artifact = resolve(pluginPath, substituted.startsWith(pluginPath) ? relative(pluginPath, substituted) : substituted);
      if (outside(pluginPath, artifact)) {
        errors.push(`${where}: arg "${arg}" escapes the plugin root`);
        continue;
      }
      try {
        const info = await stat(artifact);
        entryText ??= await readFile(artifact, "utf8");
        const inputs = await collectInputMtimes(pluginPath);
        if (info.mtimeMs < Math.max(...inputs, 0)) {
          warnings.push(`${where}: runtime artifact ${relative(pluginPath, artifact)} is older than the plugin sources; run the build script`);
        }
      } catch {
        errors.push(`${where}: runtime artifact missing (build output?): ${arg}`);
      }
    }
    if (entryText) {
      // Host entry contract (cli/src/plugin-host-command.ts).
      const exportsMain =
        /export\s*\{[^}]*\bmain\b[^}]*\}/u.test(entryText) ||
        /export\s+(?:async\s+)?function\s+main\b/u.test(entryText) ||
        /export\s+const\s+main\b/u.test(entryText);
      if (!exportsMain) {
        errors.push(`${where}: entry must export main(); the official plugin host calls module.main()`);
      }
      // Tool implementations.
      const registersTools = /registerTool\(|\.tool\(|setRequestHandler|addTool|registerCapabilities/u.test(entryText);
      const emptyHandshake = /tools\s*:\s*\[\]/u.test(entryText) && /Method not found/u.test(entryText);
      if (emptyHandshake) {
        errors.push(`${where}: scaffold handshake server with an empty tool list; implement real tools before shipping`);
      } else if (!registersTools) {
        errors.push(`${where}: no MCP tool registration found in the built entry; an official plugin never ships an empty tool surface`);
      }
      for (const [pattern, label] of SECRET_LITERAL_PATTERNS) {
        if (pattern.test(entryText)) warnings.push(`${where}: entry contains a ${label}; remove hardcoded secrets`);
      }
    }
  }

  // 9. Host-repo launch test wiring (warning only).
  if (repoRoot) {
    const bootstrapTests = join(repoRoot, "apps", "zcode-cli", "packages", "bootstrap", "tests");
    let found;
    try {
      found = (await readdir(bootstrapTests)).filter(
        (entry) => entry.includes(pluginName) && /\.test\.ts$/u.test(entry),
      );
    } catch {
      found = [];
    }
    if (found.length === 0) {
      warnings.push(
        `no bootstrap/tests/<plugin>*.test.ts launch tests reference "${pluginName}" (see references/production-launch-testing.md)`,
      );
    }
  }

  return { pluginName, definition, contractNamespace, errors, warnings, notes };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      definitions: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (positionals.length < 1 || positionals.length > 2)
    throw new Error(
      "Usage: node official-plugin-audit.mjs <plugin-path> [repo-root] [--definitions file] [--json]",
    );
  const result = await auditOfficialPlugin({
    pluginPath: positionals[0],
    repoRoot: positionals[1],
    definitionsPath: values.definitions,
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const note of result.notes) process.stdout.write(`note: ${note}\n`);
    for (const warning of result.warnings) process.stdout.write(`warning: ${warning}\n`);
    for (const error of result.errors) process.stdout.write(`error: ${error}\n`);
    process.stdout.write(
      `audit ${result.pluginName}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`,
    );
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
