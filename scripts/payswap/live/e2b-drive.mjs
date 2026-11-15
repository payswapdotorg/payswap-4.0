#!/usr/bin/env node
/**
 * PaySwap P2 live 验收 —— E2B microVM 驱动器（仓控重建版；操作员侧工具）。
 *
 * 从一台有网络的操作机运行：创建 E2B 沙箱 → clone 仓库（公共 repo）→
 * mega-setup → 运行选定验收臂（E2E live spec 或对话面 harness）→ 取回证据
 * 工件。沙箱 1h 硬 TTL —— 每臂一个新沙箱、跑完即取件（既定操作纪律）。
 *
 * 依赖（操作机，非仓内依赖 —— 有意不入 package.json）：
 *   npm i e2b@^1   （或任意提供 `e2b` 包的临时安装）
 *   E2B_API_KEY 在 env（或 ~/.e2b/e2b.toml）
 *
 * 用法：
 *   node scripts/payswap/live/e2b-drive.mjs --arm e2e
 *   node scripts/payswap/live/e2b-drive.mjs --arm harness
 *   （两个臂都跑：--arm both）
 *
 *   ZCODE_E2E_STRIPE_LIVE_KEY 从 env 或 0600 的 env 文件读取（--env-file）。
 *
 * 秘密纪律：键只经 env 注入沙箱命令；本脚本永不打印它；产物拉回后先跑
 * 泄漏自检（证据文件中出现键明文即删除并报错）再落盘。
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = { arm: "harness", envFile: null };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--arm") options.arm = argv[++index];
    else if (arg === "--env-file") options.envFile = argv[++index];
    else {
      console.error(`[e2b-drive] 未知参数：${arg}`);
      process.exit(2);
    }
  }
  return options;
}

async function loadLiveKey(envFile) {
  if (envFile) {
    const text = await readFile(resolve(envFile), "utf8");
    const match = text.match(/^\s*(?:export\s+)?ZCODE_E2E_STRIPE_LIVE_KEY=(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  const fromEnv = process.env.ZCODE_E2E_STRIPE_LIVE_KEY?.trim();
  return fromEnv || null;
}

async function main() {
  const options = parseArgs(process.argv);
  const liveKey = await loadLiveKey(options.envFile);
  if (!liveKey) {
    console.error(
      "[e2b-drive] FATAL: ZCODE_E2E_STRIPE_LIVE_KEY 缺席（env 或 --env-file 指向 0600 env 文件）",
    );
    process.exit(2);
  }

  let Sandbox;
  try {
    ({ Sandbox } = await import("e2b"));
  } catch {
    console.error(
      "[e2b-drive] FATAL: `e2b` 包不可解析 —— 操作机侧临时安装：npm i e2b@^1（有意不入仓内依赖）",
    );
    process.exit(2);
  }

  const REPO = "https://github.com/payswapdotorg/payswap-4.0.git";
  const arms = options.arm === "both" ? ["e2e", "harness"] : [options.arm];

  for (const arm of arms) {
    console.log(`[e2b-drive] === arm: ${arm}（新沙箱 —— 1h TTL，一臂一箱） ===`);
    const sandbox = await Sandbox.create();
    try {
      console.log(`[e2b-drive] sandbox ${sandbox.sandboxId} — cloning + mega-setup`);
      await sandbox.commands.run(
        `git clone --depth 1 ${REPO} /workspace/payswap`,
        { timeoutMs: 10 * 60_000 },
      );
      // mega-setup（install + build 较长 —— 单命令 25min 上限内）。
      await sandbox.commands.run(
        "cd /workspace/payswap && bash scripts/payswap/live/vm-mega-setup.sh",
        { timeoutMs: 25 * 60_000 },
      );
      const runner =
        arm === "e2e"
          ? "bash scripts/payswap/live/vm-run-live.sh"
          : "bash scripts/payswap/live/vm-harness-only.sh";
      console.log(`[e2b-drive] running ${runner}`);
      // 退出码即验收判定（harness：0=四类别数据落地 / 1=拒绝边界；e2e：0=3/3）。
      // 有意不因非零退出而中断驱动器 —— 证据工件必须取回后再判定。
      const result = await sandbox.commands.run(`cd /workspace/payswap && ${runner}`, {
        envs: { ZCODE_E2E_STRIPE_LIVE_KEY: liveKey },
        timeoutMs: 25 * 60_000,
      });
      console.log(`[e2b-drive] ${arm} exit=${result.exitCode}`);

      const artifactDir = arm === "e2e" ? "/workspace/artifacts/live-e2e" : "/workspace/artifacts/live-harness";
      const localDir = resolve(`p2-live-${arm}-evidence`);
      await sandbox.files.makeDir(localDir).catch(() => undefined);
      const listed = await sandbox.files
        .list(artifactDir)
        .catch(() => []);
      for (const entry of listed) {
        const content = await sandbox.files.readText(`${artifactDir}/${entry.name}`);
        // 泄漏自检：证据文件中出现键明文 = 处置事故 —— 拒绝落盘并报错。
        if (content.includes(liveKey)) {
          console.error(
            `[e2b-drive] FATAL: 证据文件 ${entry.name} 含键明文 —— 拒绝落盘（泄漏事故，处置后重跑）`,
          );
          process.exit(3);
        }
        const { writeFile, mkdir } = await import("node:fs/promises");
        await mkdir(localDir, { recursive: true });
        await writeFile(`${localDir}/${entry.name}`, content);
        console.log(`[e2b-drive] retrieved ${entry.name} -> ${localDir}/`);
      }
    } finally {
      await sandbox.kill().catch(() => undefined);
    }
  }
  console.log("[e2b-drive] done");
}

main().catch((error) => {
  console.error("[e2b-drive] FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
