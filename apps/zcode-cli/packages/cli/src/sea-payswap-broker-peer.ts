/**
 * PaySwap P1 —— ADR-15 D15.3：SEA 内嵌 payswap broker peer helper 的运行时抽取
 * 与 env 注入（`sea-runtime-tools.ts` 的兄弟，同一 main.ts 注入位）。
 *
 * 与 runtime-tools 同款纪律（镜像 `ensureRuntimeTool`）：
 *   - 严格闭形状 manifest 校验（version=1；target 对运行平台/arch —— `win-<arch>`
 *     键族；binaryName 裸文件名；sha256 64-hex 小写；size 安全正整数）；
 *   - 抽取到 `~/.zcode/cache/payswap_broker_peer/<target>/<sha256>/`
 *     （`ZCODE_STORAGE_DIR` 覆盖根），尺寸 + SHA-256 双验、原子 tmp-then-rename、
 *     marker 文件（缓存时效判定）、chmod 0755；
 *   - **注入**：仅在平台是 win32、helper 记录在场、且 operator 未设两键时，把
 *     `PAYSWAP_BROKER_HELPER_PATH` + `PAYSWAP_BROKER_HELPER_SHA256` 注入
 *     process.env（runtime-tools 的 operator-wins 优先级规则逐字适用）；
 *     非 SEA（node dev 形态）永不注入 —— env 键供给仍是 dev/CI 纪律（D13.9）。
 *
 * 与 runtime-tools 的刻意差异（D15.7 的行语言）：任何失配 —— manifest 缺席/
 * 损坏/形状非法/target 失配、抽取字节尺寸或 hash 不符、二进制资产缺失 —— 都
 * **诚实不注入**（返回空 env），绝不抛出：broker 按既有 boot law 落
 * degraded_refusing（§5.4 诊断可达），打包缺陷不允许崩掉整个 CLI。spawn 时的
 * 二次验证（`verifyHelperBinary`，D13.4/D15.5）保持原样 —— 抽取时检查与
 * spawn 时检查是同一 digest 的两次验证，不是冗余。
 *
 * P1 仅 win：darwin/linux SEA 不内嵌任何 broker-helper 资产（P9 递延/设计缺席），
 * `null`/缺席记录零注入，既有诚实 boot law 原样适用。
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
} from "@zcode/shared/payswap";
import type { SeaRuntimeModule } from "./sea-runtime-tools.js";

type CliEnv = Record<string, string | undefined>;

interface PayswapBrokerPeerHelperRecord {
  binaryName: string;
  sha256: string;
  size: number;
}

interface PayswapBrokerPeerHelperManifest {
  helper: PayswapBrokerPeerHelperRecord | null;
  target: string;
  version: 1;
}

interface PayswapBrokerPeerHelperMarker {
  binaryName: string;
  sha256: string;
  size: number;
  target: string;
  version: 1;
}

export interface EnsureSeaPayswapBrokerPeerHelperOptions {
  arch?: string;
  env?: CliEnv;
  platform?: NodeJS.Platform;
  sea?: SeaRuntimeModule;
  storageRoot?: string;
}

const assetPrefix = "zcode-payswap-broker-peer/";
const manifestAssetKey = `${assetPrefix}manifest.json`;
const cacheDirectoryRootName = "payswap_broker_peer";
const markerFileName = ".zcode-payswap-broker-peer-helper.json";

export async function ensureSeaPayswapBrokerPeerHelper(
  options: EnsureSeaPayswapBrokerPeerHelperOptions = {},
): Promise<CliEnv> {
  // 非 SEA 永不注入（D13.9 dev/CI env 键纪律不变）。
  const sea = options.sea ?? getSeaModule();
  if (!sea?.isSea()) return {};

  // P1 仅 win：其它平台的 SEA 一概零注入（darwin/linux 本就不内嵌该资产）。
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return {};

  const manifest = readManifest(sea);
  if (manifest === null) return {};
  if (!isValidManifest(manifest)) return {};
  if (manifest.helper === null) return {};

  const target = winRuntimeTarget(options.arch ?? process.arch);
  if (manifest.target !== target) return {};

  const env = options.env ?? process.env;
  if (
    env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]?.trim() ||
    env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]?.trim()
  ) {
    // operator-wins（runtime-tools 优先级规则逐字适用）：operator 已声明任一
    // 供给键即整体让位 —— 半组键同样构成 operator 的显式声明，混搭供给不出现。
    return {};
  }

  const storageRoot = resolveStorageRoot(options, env);
  const helperPath = await ensureExtractedHelper({
    helper: manifest.helper,
    sea,
    storageRoot,
    target,
  });
  if (helperPath === null) return {};

  return {
    [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: helperPath,
    [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: manifest.helper.sha256,
  };
}

async function ensureExtractedHelper(input: {
  helper: PayswapBrokerPeerHelperRecord;
  sea: SeaRuntimeModule;
  storageRoot: string;
  target: string;
}): Promise<string | null> {
  const { helper, sea, storageRoot, target } = input;
  const cacheDirectory = join(storageRoot, "cache", cacheDirectoryRootName, target, helper.sha256);
  const binaryPath = join(cacheDirectory, helper.binaryName);
  const marker = markerFor(helper, target);

  if (await isCacheCurrent(cacheDirectory, marker)) return binaryPath;

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await rm(temporaryDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(temporaryDirectory, {
    recursive: true,
  });

  try {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(sea.getRawAsset(assetKeyFor(helper)));
    } catch {
      // manifest 声称有 helper 但 SEA 没有对应二进制资产 = 损坏的对 → 诚实不注入。
      return null;
    }
    if (bytes.byteLength !== helper.size) return null;
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== helper.sha256) return null;

    const temporaryBinaryPath = join(temporaryDirectory, helper.binaryName);
    await writeFile(temporaryBinaryPath, bytes);
    await chmod(temporaryBinaryPath, 0o755);
    await writeFile(join(temporaryDirectory, markerFileName), JSON.stringify(marker, null, 2));

    await mkdir(dirname(cacheDirectory), {
      recursive: true,
    });
    if (await isCacheCurrent(cacheDirectory, marker)) return binaryPath;
    await installCacheDirectory(temporaryDirectory, cacheDirectory, marker);
    return binaryPath;
  } finally {
    await rm(temporaryDirectory, {
      force: true,
      recursive: true,
    });
  }
}

async function installCacheDirectory(
  temporaryDirectory: string,
  cacheDirectory: string,
  marker: PayswapBrokerPeerHelperMarker,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rename(temporaryDirectory, cacheDirectory);
      return;
    } catch (error) {
      if (await isCacheCurrent(cacheDirectory, marker)) return;
      if (!isDirectoryReplaceRace(error) || attempt === 1) throw error;
      await rm(cacheDirectory, {
        force: true,
        recursive: true,
      });
    }
  }
}

function readManifest(sea: SeaRuntimeModule): PayswapBrokerPeerHelperManifest | null {
  let text: string;
  try {
    text = sea.getAsset(manifestAssetKey, "utf8");
  } catch {
    // 缺席记录 → 零注入（既有诚实 boot law）。
    return null;
  }
  try {
    return JSON.parse(text) as PayswapBrokerPeerHelperManifest;
  } catch {
    return null;
  }
}

/** 严格闭形状（D15.3：version/target/binaryName/64-hex digest/size）。 */
function isValidManifest(manifest: PayswapBrokerPeerHelperManifest): boolean {
  if (typeof manifest !== "object" || manifest === null) return false;
  if (!hasExactlyKeys(manifest, ["helper", "target", "version"])) return false;
  if (manifest.version !== 1) return false;
  if (typeof manifest.target !== "string" || !/^win-(?:arm64|x64)$/u.test(manifest.target)) {
    return false;
  }
  if (manifest.helper === null) return true;

  const helper = manifest.helper as unknown;
  if (typeof helper !== "object" || helper === null) return false;
  if (!hasExactlyKeys(helper, ["binaryName", "sha256", "size"])) return false;
  const record = helper as PayswapBrokerPeerHelperRecord;
  if (
    typeof record.binaryName !== "string" ||
    basename(record.binaryName) !== record.binaryName ||
    !/^[A-Za-z0-9._-]+$/u.test(record.binaryName)
  ) {
    return false;
  }
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)) return false;
  if (!Number.isSafeInteger(record.size) || record.size <= 0) return false;
  return true;
}

function hasExactlyKeys(value: object, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key) => key in value)
  );
}

async function isCacheCurrent(
  cacheDirectory: string,
  expected: PayswapBrokerPeerHelperMarker,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(cacheDirectory, markerFileName), "utf8"),
    ) as PayswapBrokerPeerHelperMarker;
    if (
      marker.version !== expected.version ||
      marker.target !== expected.target ||
      marker.binaryName !== expected.binaryName ||
      marker.sha256 !== expected.sha256 ||
      marker.size !== expected.size
    ) {
      return false;
    }

    const binaryPath = join(cacheDirectory, expected.binaryName);
    const binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.size !== expected.size) return false;
    // win32 抽取面运行在 POSIX 宿主半边测试上时仍校验执行位；真实 win32 上
    // chmod 是 no-op，与 runtime-tools 同款放行。
    if (process.platform !== "win32" && (binaryStat.mode & 0o111) === 0) return false;

    const actualSha256 = createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex");
    return actualSha256 === expected.sha256;
  } catch {
    return false;
  }
}

function markerFor(
  helper: PayswapBrokerPeerHelperRecord,
  target: string,
): PayswapBrokerPeerHelperMarker {
  return {
    binaryName: helper.binaryName,
    sha256: helper.sha256,
    size: helper.size,
    target,
    version: 1,
  };
}

function winRuntimeTarget(arch: string): string {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported SEA payswap broker peer helper target win32-${arch}.`);
  }
  return `win-${arch}`;
}

function assetKeyFor(helper: PayswapBrokerPeerHelperRecord): string {
  return `${assetPrefix}${helper.sha256}/${helper.binaryName}`;
}

function resolveStorageRoot(
  options: EnsureSeaPayswapBrokerPeerHelperOptions,
  env: CliEnv,
): string {
  if (options.storageRoot) return options.storageRoot;
  const configuredStorageRoot = env.ZCODE_STORAGE_DIR?.trim();
  return configuredStorageRoot || join(homedir(), ".zcode");
}

function getSeaModule(): SeaRuntimeModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: string) => SeaRuntimeModule | undefined)
    | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function isDirectoryReplaceRace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))
  );
}
