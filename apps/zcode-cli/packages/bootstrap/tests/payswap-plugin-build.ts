import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withOfficialPluginSeedLock } from "../src/app/official-plugin-seed-lock.js";

/**
 * PaySwap 官方插件打包产物的并行安全保证（bootstrap 测试共享 helper）。
 *
 * 背景（P1 PR #3 CI run 41929517675 的失败根因）：vitest 并行运行多个测试文件；
 * 旧纪律让每个套件在 beforeAll 里无条件跑 `scripts/build.mjs`（内部 rm+重建
 * dist），而并行的 `plugins.test.ts` 正在通过官方 seed 管线读取同一目录的
 * `dist/server.mjs` —— rm 窗口命中即 ENOENT。两个构建套件把碰撞概率抬高到
 * CI 必现。
 *
 * 新纪律：
 * - **产物已新鲜 → 完全不触碰**（零写风险）。CI 的 workspace build、本地
 *   verify:pre-push / turbo build 都会在 vitest 之前产出 dist；此时任何套件
 *   都不再写插件目录。
 * - **产物缺失或过期 → 在跨进程锁内跑同一个官方构建脚本**（绝不手搓 bundle
 *   配置；证据始终来自 `scripts/build.mjs` 的真实输出）。锁复用 bootstrap 自己
 *   `withOfficialPluginSeedLock`（mkdir 语义 + stale 接管 + TOCTOU 安全），
 *   锁目录放 tmpdir（键 = 插件根路径哈希），不污染插件目录；锁内二次检查新鲜度。
 * - 新鲜度 = dist/server.mjs 的 mtime ≥ 全部构建输入（src/、scripts/、
 *   manifest、package.json）的最大 mtime。源码改动后直接跑测试会自动重建；
 *   误触发的多余重建无害（锁内、少见）。
 *
 * 残余风险（已接受并记录）：本地修改源码后**直接**并行跑多套件时，锁内的
 * rm+重建窗口理论上仍可能与 `plugins.test.ts` 的 seed 读取竞争。CI 不受影响
 * （dist 永远由 workspace build 预先产出，套件零写入）；本地标准流程
 * （先 build 再 test）同样不受影响。
 */

export const PAYSWAP_PLUGIN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "payswap-plugin",
);

// 新鲜度输入：源码、构建脚本、manifest 与包定义（不含 dist / node_modules）。
const FRESHNESS_INPUT_DIRECTORIES = ["src", "scripts"];
const FRESHNESS_INPUT_FILES = [join(".zcode-plugin", "plugin.json"), "package.json"];

export function ensurePayswapPluginDist(): void {
  if (isPayswapPluginDistFresh()) return;
  withOfficialPluginSeedLock(buildLockRoot(), () => {
    // 锁内二次检查：等锁期间可能已有别的 worker 完成构建。
    if (isPayswapPluginDistFresh()) return;
    execFileSync(process.execPath, [join(PAYSWAP_PLUGIN_ROOT, "scripts", "build.mjs")], {
      cwd: PAYSWAP_PLUGIN_ROOT,
      stdio: "pipe",
    });
  });
  if (!isPayswapPluginDistFresh()) {
    throw new Error(
      `payswap-plugin build did not produce a fresh dist/server.mjs under ${PAYSWAP_PLUGIN_ROOT}`,
    );
  }
}

function isPayswapPluginDistFresh(): boolean {
  try {
    const distMtimeMs = statSync(join(PAYSWAP_PLUGIN_ROOT, "dist", "server.mjs")).mtimeMs;
    return newestInputMtimeMs() <= distMtimeMs;
  } catch {
    return false;
  }
}

function newestInputMtimeMs(): number {
  let newest = 0;
  for (const directory of FRESHNESS_INPUT_DIRECTORIES) {
    const root = join(PAYSWAP_PLUGIN_ROOT, directory);
    for (const entry of readdirSync(root)) {
      const mtimeMs = statSync(join(root, entry)).mtimeMs;
      if (mtimeMs > newest) newest = mtimeMs;
    }
  }
  for (const file of FRESHNESS_INPUT_FILES) {
    const mtimeMs = statSync(join(PAYSWAP_PLUGIN_ROOT, file)).mtimeMs;
    if (mtimeMs > newest) newest = mtimeMs;
  }
  return newest;
}

function buildLockRoot(): string {
  const key = createHash("sha256").update(PAYSWAP_PLUGIN_ROOT).digest("hex").slice(0, 16);
  return join(tmpdir(), `payswap-plugin-build-lock-${key}`);
}
