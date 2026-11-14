#!/usr/bin/env node
/**
 * PaySwap P1 —— ADR-15 D15.1/D15.2：Windows peer-verification helper 的单一
 * CLI 持有 prepare 纪律（一个实现，两个分发载体共用；SEA 构建与桌面 prepare 链
 * 都调本脚本，绝不 fork 第二套编译纪律）。
 *
 * 纪律（D15.1 —— 与 gates-windows 的 csc 编译纪律逐字节同源；任何 flag 变更
 * 重开平台行，打包产物必须是已被证明的产物）：
 *   - OS 内置 .NET Framework csc.exe（Framework64 优先，Framework 兜底）；
 *   - flags：/nologo /optimize+ /target:exe /platform:<arch> /warnaserror+
 *     /win32manifest:app.manifest /reference:System.Core.dll —— 与 ci.yml
 *     gates-windows 的既有编译步（ADR-14 D14.1）完全一致，且沿用其
 *     Push-Location/短相对名调用形态（源根 cwd + out/ 相对输出，round-2 CI 教训）；
 *   - x64 缺省；arm64 只经显式 Roslyn ZCODE_CSC_PATH override
 *     （build-windows-browser-import-helper.mjs 先例规则）。
 *
 * 落位（D15.2）：packages/desktop/bundled-tools/<platformKey>/payswap-broker-peer/
 * （runtime-tools staging 根）—— manifest.json 与二进制成对、不可分离；
 *   - helper 记录：{ version: 1, target: <sea-target>, helper: { binaryName,
 *     sha256, size } }，digest 在 prepare 时由编译产物计算；
 *   - helper:null：显式缺席记录（P1 不打包 helper 的每一个目标 —— darwin/linux
 *     目标与一切外国宿主交叉构建）。
 *
 * 大声失败法（D15.1）：win32 目标 + win32 宿主的构建在编译器缺席时必须失败
 * （会降级出货的 Windows release 必须是故意行为，不是意外）；此时绝不落任何
 * manifest —— 大声失败 ≠ 伪造缺席记录。
 *
 * P9 递延：darwin helper 的打包（编译/stage、SEA 内嵌、桌面资源接线）属于 P9
 * 最终平台加固子里程碑；P1 里 darwin 编译只属于 gates-macos 回归门。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostTarget, normalizeTarget, targetParts } from "./sea-targets.mjs";

export const PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME = "payswap-broker-peer-helper.exe";
export const PAYSWAP_BROKER_PEER_HELPER_DIR_NAME = "payswap-broker-peer";
export const PAYSWAP_BROKER_PEER_HELPER_MANIFEST_FILE_NAME = "manifest.json";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));

/** native 源根（apps/zcode-cli/native/payswap-broker-peer-windows —— 源是已证明的，打包只消费）。 */
export const payswapBrokerPeerHelperSourceRoot = (root) =>
  resolve(root, "apps/zcode-cli/native/payswap-broker-peer-windows");

/**
 * staging 计划（runtime-tools 同根）：platformKey 用桌面 bundled-tools 键族
 * （win-x64 -> win32-x64），manifest/binary 路径成对落位。
 */
export const resolvePayswapBrokerPeerHelperPlan = ({ root, target }) => {
  const { arch, releasePlatform } = targetParts(target);
  const platform = releasePlatform === "win" ? "win32" : releasePlatform;
  const platformKey = `${platform}-${arch}`;
  const outputDir = join(
    root,
    "packages",
    "desktop",
    "bundled-tools",
    platformKey,
    PAYSWAP_BROKER_PEER_HELPER_DIR_NAME,
  );

  return {
    arch,
    binaryPath: join(outputDir, PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME),
    compileArch: arch,
    manifestPath: join(outputDir, PAYSWAP_BROKER_PEER_HELPER_MANIFEST_FILE_NAME),
    outputDir,
    platform,
    platformKey,
    releasePlatform,
    target,
  };
};

const writeNullManifest = async (plan) => {
  const manifest = { helper: null, target: plan.target, version: 1 };
  await rm(plan.outputDir, { force: true, recursive: true });
  await mkdir(plan.outputDir, { recursive: true });
  await writeFile(
    plan.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
};

const resolveCscCandidates = (env) =>
  [
    env.ZCODE_CSC_PATH?.trim(),
    "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
  ].filter(Boolean);

/** CI-gates 编译纪律（ADR-14 D14.1 / ADR-15 D15.1）—— flag 集与 ci.yml 的 gates-windows 编译步逐项一致。 */
const cscArgsForArch = (arch) => [
  "/nologo",
  "/optimize+",
  "/target:exe",
  `/platform:${arch}`,
  "/warnaserror+",
  "/win32manifest:app.manifest",
  "/reference:System.Core.dll",
  `/out:out/${PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME}`,
  "Program.cs",
];

/**
 * prepare 主体（可注入 hostPlatform/env，POSIX 宿主半边测试以 fake csc 走真
 * spawn 路径）。返回 { manifest, outputDir, helperPath }；helperPath 仅在真实
 * 编译并 staging 后非空。
 */
export const preparePayswapBrokerPeerHelper = async ({
  env = process.env,
  hostPlatform = process.platform,
  root,
  target,
}) => {
  const plan = resolvePayswapBrokerPeerHelperPlan({ root, target });

  // (1) P1 刻意 no-op：darwin/linux 目标（darwin 打包是 P9 递延；Linux 臂按
  //     D13.8 设计没有 helper）与一切外国宿主交叉构建 —— 显式 helper:null，
  //     构建不失败，载体诚实地 boot degraded_refusing。
  if (plan.releasePlatform !== "win" || hostPlatform !== "win32") {
    const manifest = await writeNullManifest(plan);
    return { helperPath: null, manifest, outputDir: plan.outputDir };
  }

  // (2) win32 目标 + win32 宿主：必须编译。先验证输入（源在场 —— 已证明的源，
  //     打包只消费），再解析编译器；arm64 只经显式 Roslyn override。
  if (plan.arch !== "x64" && plan.arch !== "arm64") {
    throw new Error(
      `Unsupported payswap broker peer helper architecture for ${plan.target}: ${plan.arch}`,
    );
  }
  const sourceRoot = payswapBrokerPeerHelperSourceRoot(root);
  for (const requiredFile of ["Program.cs", "app.manifest"]) {
    if (!existsSync(join(sourceRoot, requiredFile))) {
      throw new Error(
        `Missing payswap broker peer helper source ${requiredFile} at ${sourceRoot}`,
      );
    }
  }
  if (plan.arch === "arm64" && !env.ZCODE_CSC_PATH?.trim()) {
    throw new Error(
      "Windows arm64 payswap broker peer helper requires ZCODE_CSC_PATH pointing to an " +
        "arm64-capable Roslyn csc.exe (ADR-15 D15.1; the OS-bundled .NET Framework csc is x64-only)",
    );
  }
  const cscCandidates = resolveCscCandidates(env);
  const cscPath = cscCandidates.find((candidate) => existsSync(candidate));
  if (!cscPath) {
    // 大声失败法（D15.1）：会静默降级出货的 Windows 构建必须当场失败，
    // 且绝不落 manifest（大声失败 ≠ 伪造缺席记录）。
    throw new Error(
      `Windows peer-verification helper compile requires the OS-bundled .NET Framework ` +
        `csc.exe (or ZCODE_CSC_PATH) for a win32 build on a win32 host — refusing to stage a ` +
        `Windows helper artifact without compiling it (ADR-15 D15.1 loud-failure law). ` +
        `Tried: ${cscCandidates.join(", ")}`,
    );
  }

  const outDirectory = join(sourceRoot, "out");
  const argv = cscArgsForArch(plan.compileArch);
  await rm(outDirectory, { force: true, recursive: true });
  await mkdir(outDirectory, { recursive: true });
  const compileResult = spawnSync(cscPath, argv, {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  if (compileResult.error) {
    throw new Error(
      `Failed to invoke the Windows C# compiler for the payswap broker peer helper: ${compileResult.error.message}`,
      { cause: compileResult.error },
    );
  }
  if (compileResult.status !== 0) {
    throw new Error(
      `csc.exe failed for the payswap broker peer helper (${plan.target}) with code ` +
        `${compileResult.status}: ${[compileResult.stdout, compileResult.stderr]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000)}`,
    );
  }

  // (3) staging：binary + manifest 成对落位（先清空 —— 陈旧 pair 不存活）。
  const builtPath = join(outDirectory, PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME);
  if (!existsSync(builtPath)) {
    throw new Error(
      `csc.exe reported success but the payswap broker peer helper binary is missing at ${builtPath}`,
    );
  }
  await rm(plan.outputDir, { force: true, recursive: true });
  await mkdir(plan.outputDir, { recursive: true });
  await copyFile(builtPath, plan.binaryPath);

  const bytes = await readFile(plan.binaryPath);
  const manifest = {
    helper: {
      binaryName: PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    },
    target: plan.target,
    version: 1,
  };
  await writeFile(plan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { helperPath: plan.binaryPath, manifest, outputDir: plan.outputDir };
};

// ---------------------------------------------------------------------------
// CLI 入口（桌面 prepare 链与 gates-windows 直接调用；SEA 构建经模块导入复用）。
// ---------------------------------------------------------------------------

const usage = `Usage:
  node scripts/prepare-payswap-broker-peer-helper.mjs
  node scripts/prepare-payswap-broker-peer-helper.mjs --target win-x64

Targets: win-x64 (default via host or ZCODE_TARGET_OS/ZCODE_TARGET_ARCH), win-arm64
(requires ZCODE_CSC_PATH), darwin-*/linux-* (explicit helper:null no-ops in P1).
`;

const parsePrepareArgs = (argv) => {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--target" || arg.startsWith("--target=")) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      target = value;
      if (!arg.includes("=")) index += 1;
      continue;
    }
    throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
  }
  return { target };
};

/** 桌面交叉构建约定（ZCODE_TARGET_OS/ZCODE_TARGET_ARCH）→ SEA target 族；缺省宿主 target。 */
const targetFromEnvironment = (env, { arch, platform }) => {
  const targetOs = env.ZCODE_TARGET_OS?.trim();
  const targetArch = env.ZCODE_TARGET_ARCH?.trim();
  if (targetOs || targetArch) {
    const os = (targetOs || platform).replace(/^win32$/u, "win");
    return normalizeTarget(`${os}-${targetArch || arch}`);
  }
  return hostTarget({ arch, platform });
};

const main = async () => {
  const { help, target: rawTarget } = parsePrepareArgs(process.argv.slice(2));
  if (help) {
    console.log(usage);
    return;
  }
  const target = rawTarget
    ? normalizeTarget(rawTarget)
    : targetFromEnvironment(process.env, { arch: process.arch, platform: process.platform });

  // scripts → cli → packages → zcode-cli → apps → 仓库根（五级）。
  const root = resolve(scriptDir, "../../../../..");
  const { manifest, outputDir } = await preparePayswapBrokerPeerHelper({
    env: process.env,
    hostPlatform: process.platform,
    root,
    target,
  });

  const helperDescription = manifest.helper
    ? `helper ${manifest.helper.binaryName} sha256=${manifest.helper.sha256} size=${manifest.helper.size}`
    : "helper: null (explicit absent record)";
  console.log(
    `[prepare-payswap-broker-peer-helper] ${target}: ${helperDescription} -> ${outputDir}`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
