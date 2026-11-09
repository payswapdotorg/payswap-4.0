// 使命 P1-C（插件生命周期 E2E 前置）：官方 payswap 插件必须随 dev agent bundle
// 一起种子化到 bundled-agents/<platform>/glm/packages/payswap-plugin —— S0b 基线
// （已安装未启用 → 启动即种子 INSTALLED+DISABLED）与 marketplace E2E 管线都依赖
// rootCandidates[0] 从 agent entrypointDir（glm/）解析到该布局。
//
// 纯 JS（node --test）：TS 类型注解无法被 node --test 解析（WP-C1 首版教训）；
// import 路径相对 scripts/test/ 需上溯两层（../packages 是错的，../../packages 才对）。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { stageAgentBundle } from "../../packages/desktop/scripts/stage-agent-bundle.mjs";

function buildFixtureRepo({ withPayswapRuntime }) {
  const repoRoot = mkdtempSync(join(tmpdir(), "payswap-stage-seed-"));
  const cliDist = join(repoRoot, "apps/zcode-cli", "packages", "cli", "dist");
  mkdirSync(cliDist, { recursive: true });
  writeFileSync(join(cliDist, "zcode.cjs"), "// fixture agent bundle\n");

  const payswapRoot = join(repoRoot, "apps/zcode-cli", "packages", "payswap-plugin");
  mkdirSync(join(payswapRoot, ".zcode-plugin"), { recursive: true });
  writeFileSync(
    join(payswapRoot, ".zcode-plugin", "plugin.json"),
    `${JSON.stringify({ id: "payswap", name: "payswap" }, null, 2)}\n`,
  );
  writeFileSync(
    join(payswapRoot, "package.json"),
    `${JSON.stringify({ name: "@zcode/payswap-plugin" }, null, 2)}\n`,
  );
  if (withPayswapRuntime) {
    mkdirSync(join(payswapRoot, "dist"), { recursive: true });
    writeFileSync(join(payswapRoot, "dist", "server.mjs"), "export {};\n");
  }
  return repoRoot;
}

function glmPackagesDir(repoRoot, platformKey) {
  return join(
    repoRoot,
    "packages",
    "desktop",
    "bundled-agents",
    platformKey,
    "glm",
    "packages",
    "payswap-plugin",
  );
}

test("已构建 runtime 的官方 payswap 插件随 glm 一起种子化", () => {
  const repoRoot = buildFixtureRepo({ withPayswapRuntime: true });
  try {
    const { stagedBundlePath } = stageAgentBundle({
      repoRoot,
      platformKey: "linux-x64",
      log: () => {},
    });
    assert.ok(existsSync(stagedBundlePath), "agent bundle 本体必须暂存");
    const glmPackages = glmPackagesDir(repoRoot, "linux-x64");
    assert.ok(
      existsSync(join(glmPackages, "dist", "server.mjs")),
      "种子必须带 dist/server.mjs 运行时",
    );
    assert.ok(
      existsSync(join(glmPackages, ".zcode-plugin", "plugin.json")),
      "种子必须带插件清单",
    );
    assert.ok(
      existsSync(join(glmPackages, "package.json")),
      "种子必须带 package.json",
    );
    const meta = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          "packages",
          "desktop",
          "bundled-agents",
          "linux-x64",
          "glm",
          ".node-bundle-meta.json",
        ),
        "utf8",
      ),
    );
    assert.equal(meta.entry, "zcode.cjs");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("dist/server.mjs 缺失时跳过 payswap 种子：不产出残缺种子、不阻断其余暂存", () => {
  const repoRoot = buildFixtureRepo({ withPayswapRuntime: false });
  try {
    const { stagedBundlePath } = stageAgentBundle({
      repoRoot,
      platformKey: "linux-x64",
      log: () => {},
    });
    assert.ok(existsSync(stagedBundlePath), "agent bundle 本体仍必须暂存");
    assert.equal(
      existsSync(glmPackagesDir(repoRoot, "linux-x64")),
      false,
      "不得暂存无 runtime 的残缺 payswap 种子",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
