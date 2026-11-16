#!/usr/bin/env node
/**
 * PaySwap P2 live 验收 —— E2B microVM 驱动器（仓控重建版；操作员侧工具）。
 *
 * 从一台有网络的操作机运行：创建 E2B 沙箱 → clone 仓库（公共 repo）→
 * mega-setup → 运行选定验收臂（E2E live spec 或对话面 harness）→ 取回证据
 * 工件 → 完整性判定。沙箱 1h 硬 TTL —— 每臂一个新沙箱、跑完即取件（既定
 * 操作纪律）。
 *
 * 依赖（操作机，非仓内依赖 —— 有意不入 package.json）：
 *   npm i e2b@^1   （或任意提供 `e2b` 包的临时安装）
 *   E2B_API_KEY 在 env（或 ~/.e2b/e2b.toml）
 *   tar（工件取回经 tar.gz + base64 —— 二进制安全且不依赖 SDK 文件 API
 *   的目录/二进制形态；GNU/BusyBox tar 均可，Windows 用 WSL/Git-Bash 自带 tar）
 *
 * 用法：
 *   node scripts/payswap/live/e2b-drive.mjs --arm e2e
 *   node scripts/payswap/live/e2b-drive.mjs --arm harness
 *   （两个臂都跑：--arm both）
 *
 *   ZCODE_E2E_STRIPE_LIVE_KEY 从 env 或 0600 的 env 文件读取（--env-file）。
 *
 * 秘密纪律：键只经 env 注入沙箱命令；本脚本永不打印它；产物先落**临时目录**，
 * 逐文件**字节级**泄漏自检（任何文件出现键明文 = 处置事故 —— 删除临时目录并
 * 报错）通过后才移动到最终证据目录。
 *
 * 完整性判定（2026-11-15 架构师评审跟进 —— 驱动器不得在工件不全或结果未验证
 * 时报告完成）：
 *   1. 每臂的期望工件必须齐备：REQUIRED 缺失 = FATAL；条件期望（如 connect
 *      已落地则 at-rest 快照必须在）缺失 = FATAL —— 不再接受空表静默通过。
 *   2. RESULT 文件必须存在、可解析，且与结构化工件一致（RESULT_HARNESS=n 与
 *      evidence JSON 的 all-steps-ok 互证；不一致 = FATAL）。
 *   3. --env-file 通告 0600 的 env 文件必须实际为 0600（组/他任一权限位 =
 *      FATAL —— 广告的权限就是断言）。
 *
 * 退出码：0 = 所有臂 RESULT=0（验收绿）；2 = 用法/环境缺失；3 = 键泄漏事故
 * （临时目录已删除）；4 = 工件不全/结果不可验证（证据不可信）；5 = 验收判定
 * 非零（RESULT≠0 —— 证据已取回并判定，如未激活账户的拒绝边界 = 1）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

/** 完整性违规（工件不全/结果不可验证）—— main 捕获后先清临时目录再 FATAL。 */
class IntegrityError extends Error {}

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_LEAK = 3;
const EXIT_INTEGRITY = 4;
const EXIT_ACCEPTANCE = 5;

/** 工件取回的 stdout 上限（base64 后）—— 超限即 fail loud（手工取回指引），
 * 不做静默截断（截断的 base64 在本地解包时必然 fail loud，双保险）。 */
const MAX_PACKED_ARTIFACTS_BYTES = 12 * 1024 * 1024;

function fatal(code, message) {
  console.error(`[e2b-drive] FATAL: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { arm: "harness", envFile: null };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--arm") options.arm = argv[++index];
    else if (arg === "--env-file") options.envFile = argv[++index];
    else {
      console.error(`[e2b-drive] 未知参数：${arg}`);
      process.exit(EXIT_USAGE);
    }
  }
  if (!["e2e", "harness", "both"].includes(options.arm)) {
    console.error(`[e2b-drive] FATAL: --arm 必须是 e2e | harness | both（得到 '${options.arm}'）`);
    process.exit(EXIT_USAGE);
  }
  return options;
}

/** 通告 0600 的 env 文件必须实际为 0600（组/他权限位任一即 FATAL —— 权限广告
 * 即断言；owner 位异常只告警：0400 只读更严，0700 的 exec 位无害但非标）。 */
async function assertEnvFilePermissions(envFile) {
  const absolute = resolve(envFile);
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    fatal(EXIT_USAGE, `--env-file 无法读取：${absolute}（${error.message}）`);
  }
  if (!info.isFile()) fatal(EXIT_USAGE, `--env-file 不是常规文件：${absolute}`);
  const mode = info.mode & 0o777;
  if (mode & 0o077) {
    fatal(
      EXIT_USAGE,
      `--env-file 权限为 0${mode.toString(8)} —— 通告 0600 的键文件不得含组/他权限位` +
        `（chmod 600 ${absolute} 后重跑）`,
    );
  }
  if (mode !== 0o600) {
    console.warn(`[e2b-drive] warn: env 文件权限 0${mode.toString(8)} 非标准 0600（组/他为零，可接受）`);
  }
  return absolute;
}

async function loadLiveKey(envFile) {
  if (envFile) {
    const absolute = await assertEnvFilePermissions(envFile);
    const text = await readFile(absolute, "utf8");
    const match = text.match(/^\s*(?:export\s+)?ZCODE_E2E_STRIPE_LIVE_KEY=(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  const fromEnv = process.env.ZCODE_E2E_STRIPE_LIVE_KEY?.trim();
  return fromEnv || null;
}

async function listFilesRecursive(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await listFilesRecursive(absolute)));
    else if (entry.isFile()) found.push(absolute);
  }
  return found;
}

/** 每臂的期望工件（相对 artifactDir 的归一化路径 —— tar 以 `-C <dir> .` 打包，
 * 本地展开后取相对 tempDir 路径比对）。 */
const EXPECTED_ARTIFACTS = {
  harness: {
    required: ["RESULT-harness.txt", "live-conversational-evidence.json"],
    // connect 已 ok 则 at-rest 快照必须在（harness finish() 只在 store 在场时写
    // 它；connect 成功而快照缺席 = 工件链断裂）。
    conditional: [{ path: "payswap-connections-at-rest.json", requiresConnectOk: true }],
  },
  e2e: {
    required: ["RESULT.txt"],
    conditional: [],
  },
};

/** 从沙箱取回工件：tar.gz + base64 经 commands.run（二进制安全 —— 截断/损坏
 * 在本地 tar -t 校验时 fail loud）→ 临时目录解包 → 逐文件字节级泄漏自检。
 * 返回 { tempDir, relativeFiles }（秘密纪律：泄漏即删临时目录并 FATAL）。 */
async function collectArmArtifacts(sandbox, arm, artifactDir, liveKey) {
  const pack = await sandbox.commands.run(
    `set -e -o pipefail; cd ${artifactDir} && tar -czf - . | base64 -w 0`,
    { timeoutMs: 5 * 60_000 },
  );
  if (pack.exitCode !== 0) {
    fatal(
      EXIT_INTEGRITY,
      `${arm} 臂工件目录缺失或打包失败（exit=${pack.exitCode}；` +
        `stderr=${String(pack.stderr || "").slice(0, 400)}）—— 工件不全，验收不可判定`,
    );
  }
  if (pack.stdout.length === 0) {
    fatal(EXIT_INTEGRITY, `${arm} 臂工件打包为空 —— 运行器未产出任何工件，验收不可判定`);
  }
  if (pack.stdout.length > MAX_PACKED_ARTIFACTS_BYTES) {
    fatal(
      EXIT_INTEGRITY,
      `${arm} 臂工件包 ${pack.stdout.length} 字节超上限 ${MAX_PACKED_ARTIFACTS_BYTES} —— ` +
        `改手工取回（沙箱 ${sandbox.sandboxId}：scp/tar 分块），勿依赖驱动器`,
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), `p2-live-${arm}-`));
  const packedPath = join(tempDir, ".artifacts.tar.gz");
  await writeFile(packedPath, Buffer.from(pack.stdout, "base64"));
  try {
    // 完整性自证：先列目录再解包 —— base64 截断/包损坏在此 fail loud。
    execFileSync("tar", ["-tzf", packedPath], { stdio: "pipe" });
    execFileSync("tar", ["-xzf", packedPath, "-C", tempDir], { stdio: "pipe" });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    fatal(
      EXIT_INTEGRITY,
      `${arm} 臂工件包损坏（tar 校验失败：${error.message}）—— 疑传输截断，重跑`,
    );
  }
  await rm(packedPath, { force: true });

  const files = await listFilesRecursive(tempDir);
  if (files.length === 0) {
    await rm(tempDir, { recursive: true, force: true });
    fatal(EXIT_INTEGRITY, `${arm} 臂工件包展开后为空 —— 验收不可判定`);
  }
  // 泄漏自检（字节级 —— 对任何文件类型成立；通过前工件不离开临时目录）。
  const keyBytes = Buffer.from(liveKey, "utf8");
  for (const file of files) {
    if ((await readFile(file)).includes(keyBytes)) {
      await rm(tempDir, { recursive: true, force: true });
      fatal(
        EXIT_LEAK,
        `证据文件 ${basename(file)} 含键明文 —— 处置事故（临时目录已删除；处置后重跑）`,
      );
    }
  }
  return { tempDir, relativeFiles: files.map((file) => relative(tempDir, file)).sort() };
}

/** 期望工件齐备性 + RESULT 可解析性 + 结构化互证。返回该臂验收码；
 * 完整性违规抛 IntegrityError（main 捕获后先清临时目录再 FATAL）。 */
function verifyArmArtifacts(arm, tempDir, relativeFiles) {
  const expectations = EXPECTED_ARTIFACTS[arm];
  for (const required of expectations.required) {
    if (!relativeFiles.includes(required)) {
      throw new IntegrityError(
        `${arm} 臂期望工件缺失：${required}（取回面：${relativeFiles.join(", ")}）`,
      );
    }
  }

  let evidence = null;
  if (arm === "harness") {
    const evidenceText = readFileUtf8(join(tempDir, "live-conversational-evidence.json"));
    try {
      evidence = JSON.parse(evidenceText);
    } catch (error) {
      throw new IntegrityError(`live-conversational-evidence.json 不可解析：${error.message}`);
    }
    if (!Array.isArray(evidence.steps) || evidence.steps.length === 0) {
      throw new IntegrityError("live-conversational-evidence.json 缺 steps 数组 —— 工件不可信");
    }
  }

  // 条件期望：connect ok ⇒ at-rest 快照必须在。
  if (arm === "harness") {
    const connectOk = evidence.steps.some(
      (entry) => entry.name.startsWith("connect with the real restricted key") && entry.ok === true,
    );
    for (const conditional of expectations.conditional) {
      if (conditional.requiresConnectOk && connectOk && !relativeFiles.includes(conditional.path)) {
        throw new IntegrityError(
          `harness 臂 connect 已 ok 而 ${conditional.path} 缺失 —— 工件链断裂`,
        );
      }
    }
  }

  const resultFile = arm === "harness" ? "RESULT-harness.txt" : "RESULT.txt";
  const resultLabel = arm === "harness" ? "RESULT_HARNESS" : "RESULT_E2E";
  const match = readFileUtf8(join(tempDir, resultFile)).match(new RegExp(`^${resultLabel}=(\\d+)\\s*$`, "m"));
  if (!match) {
    throw new IntegrityError(`${resultFile} 缺失可解析的 ${resultLabel}=<n> 行 —— 结果不可验证`);
  }
  const code = Number(match[1]);

  // 结构化互证（harness 臂）：RESULT 码与 evidence steps 全 ok 必须一致。
  if (arm === "harness") {
    const allOk = evidence.steps.every((entry) => entry.ok === true);
    if ((code === 0) !== allOk) {
      throw new IntegrityError(
        `RESULT_HARNESS=${code} 与 evidence steps（allOk=${allOk}）不一致 —— 工件完整性违规`,
      );
    }
  }
  return code;
}

function readFileUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new IntegrityError(`期望工件读取失败 ${path}：${error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const liveKey = await loadLiveKey(options.envFile);
  if (!liveKey) {
    console.error(
      "[e2b-drive] FATAL: ZCODE_E2E_STRIPE_LIVE_KEY 缺席（env 或 --env-file 指向 0600 env 文件）",
    );
    process.exit(EXIT_USAGE);
  }

  let Sandbox;
  try {
    ({ Sandbox } = await import("e2b"));
  } catch {
    console.error(
      "[e2b-drive] FATAL: `e2b` 包不可解析 —— 操作机侧临时安装：npm i e2b@^1（有意不入仓内依赖）",
    );
    process.exit(EXIT_USAGE);
  }

  const REPO = "https://github.com/payswapdotorg/payswap-4.0.git";
  // 模板选择（可选）：PAYSWAP_E2B_TEMPLATE 指定既有模板 id/alias。2026-11-16
  // 实测：E2B 当前默认模板仅 ~484MB RAM —— desktop 构建（3GB 堆）必然 OOM
  // （exit 137）；验收 VM 必须是真实规格（≥4GB）。不设该 env = 维持默认模板
  // 行为（小模板上 mega-setup 会因内存不足失败，fail loud）。
  const template = process.env.PAYSWAP_E2B_TEMPLATE?.trim() || null;
  const arms = options.arm === "both" ? ["e2e", "harness"] : [options.arm];
  const verdicts = [];

  for (const arm of arms) {
    console.log(`[e2b-drive] === arm: ${arm}（新沙箱 —— 1h TTL，一臂一箱） ===`);
    const sandbox = template ? await Sandbox.create(template) : await Sandbox.create();
    if (template) console.log(`[e2b-drive] template: ${template}`);
    try {
      console.log(`[e2b-drive] sandbox ${sandbox.sandboxId} — cloning + mega-setup`);
      // E2B 基础模板的默认用户对 `/` 无写权限（/workspace 不存在且不可创建）——
      // 工具链（clone 目标 + vm-*.sh 的 LIVE_ARTIFACT_DIR 缺省）都以 /workspace
      // 为根；先以 sudo 供给目录并移交属主，再 clone（fail loud：exitCode 检查）。
      const provision = await sandbox.commands.run(
        `sudo mkdir -p /workspace /workspace/artifacts && sudo chown -R "$(whoami)" /workspace`,
        { timeoutMs: 60_000 },
      );
      if (provision.exitCode !== 0) {
        throw new Error(
          `/workspace provisioning failed (exit=${provision.exitCode}` +
            `; stderr=${String(provision.stderr || "").slice(0, 300)})`,
        );
      }
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
      // 运行器退出码先记录、不判定 —— 判定以取回并验证过的工件为准
      // （RESULT 文件 + 结构化互证；完整性不足时以 EXIT_INTEGRITY 报错）。
      const result = await sandbox.commands.run(`cd /workspace/payswap && ${runner}`, {
        envs: { ZCODE_E2E_STRIPE_LIVE_KEY: liveKey },
        timeoutMs: 25 * 60_000,
      });
      console.log(`[e2b-drive] ${arm} runner exit=${result.exitCode}`);

      const artifactDir =
        arm === "e2e" ? "/workspace/artifacts/live-e2e" : "/workspace/artifacts/live-harness";
      const { tempDir, relativeFiles } = await collectArmArtifacts(sandbox, arm, artifactDir, liveKey);
      let code;
      try {
        code = verifyArmArtifacts(arm, tempDir, relativeFiles);
      } catch (error) {
        // 完整性违规：临时目录（已过泄漏自检）清掉再报 —— 不留孤儿目录。
        await rm(tempDir, { recursive: true, force: true });
        if (error instanceof IntegrityError) fatal(EXIT_INTEGRITY, error.message);
        throw error;
      }

      // 工件齐备 + 泄漏自检通过 → 移入最终证据目录（rename；跨设备回退
      // cp+rm；旧目录先清）。
      const localDir = resolve(`p2-live-${arm}-evidence`);
      await rm(localDir, { recursive: true, force: true });
      try {
        await rename(tempDir, localDir);
      } catch (error) {
        if (error && error.code === "EXDEV") {
          await cp(tempDir, localDir, { recursive: true });
          await rm(tempDir, { recursive: true, force: true });
        } else {
          throw error;
        }
      }
      console.log(`[e2b-drive] artifacts verified + retrieved (${relativeFiles.length} files) -> ${localDir}/`);
      for (const file of relativeFiles) console.log(`[e2b-drive]   ${file}`);
      verdicts.push({ arm, code });
      console.log(`[e2b-drive] VERDICT ${arm}: ${code === 0 ? "GREEN" : "NON-ZERO"} (RESULT=${code})`);
    } finally {
      await sandbox.kill().catch(() => undefined);
    }
  }

  console.log("[e2b-drive] === verdicts ===");
  for (const { arm, code } of verdicts) console.log(`RESULT ${arm}=${code}`);
  if (verdicts.length !== arms.length) process.exit(EXIT_INTEGRITY);
  if (verdicts.some(({ code }) => code !== 0)) process.exit(EXIT_ACCEPTANCE);
  process.exit(EXIT_OK);
}

main().catch((error) => {
  console.error("[e2b-drive] FAILED:", error && error.stack ? error.stack : error);
  process.exit(EXIT_INTEGRITY);
});
