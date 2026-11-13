/**
 * PaySwap P1 —— ADR-15 D15.4：桌面 agent-env 组装的 payswap broker peer helper
 * 供给解析器（desktopRuntimeEnv.ts `buildHostProcessEnv` 的 CUA-helper-app 供给
 * 先例同族；P1 仅 win32）。
 *
 * 解析（browser-import-helper / windowsChromeAppBoundKey 的 resourcesPath 解析族
 * + bundled-tools 相对路径 dev 回退族）：
 *   - 打包态：process.resourcesPath/payswap-broker-peer/{manifest.json,<binary>}；
 *   - dev 态：bundled-tools/<platformKey>/payswap-broker-peer/（import.meta.dirname
 *     相对族 + cwd 候选族）。
 *
 * 注入纪律（与 SEA 侧 D15.3 同一 law，两载体一个实现语义）：
 *   - 读 staging manifest（prepare 脚本的 v1 闭形状：version/target/helper
 *     {binaryName,sha256,size}|null）；
 *   - 注入时验证二进制 digest（尺寸 + SHA-256 对 manifest 重算）；
 *   - operator-wins：operator 已设任一供给键（trim 后非空）即整体让位；
 *   - 任何失配（损坏 manifest/target 失配/digest 失配/缺文件/非 win32）→
 *     **诚实不注入**（agent 落 degraded_refusing，§5.4 诊断可达）——
 *     `verifyHelperBinary`（D13.4，未改动）仍是 spawn 时的单一验证点。
 *
 * 本模块刻意不 import electron（`isPackaged`/`resourcesPath` 由调用方
 * desktopRuntimeEnv.ts 传入 —— main-process 单测可在无 Electron 运行时直接覆盖）。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
} from "@zcode/shared/payswap";

export const PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR = "payswap-broker-peer";
const manifestFileName = "manifest.json";

export interface ResolvePayswapBrokerPeerHelperSupplyOptions {
  arch?: string;
  /** dev 回退的 bundled-tools 根候选（缺省为 import.meta.dirname/cwd 相对族；测试注入）。 */
  devBundledToolsRoots?: string[];
  /** operator env（缺省 process.env）；任一供给键有值即让位。 */
  env?: Record<string, string | undefined>;
  /** 是否打包态（由调用方传入 isElectronAppPackaged()；缺省 false）。 */
  isPackaged?: boolean;
  platform?: string;
  /** 打包态资源根（缺省 process.resourcesPath）。 */
  resourcesPath?: string;
}

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

const defaultDevBundledToolsRoots = () => [
  // 仓库内 dev 形态（src/main → packages/desktop/bundled-tools）。
  join(import.meta.dirname, "../../bundled-tools"),
  // dev cwd 可能是 packages/desktop 或仓库根（resolveBundledZCodeAgentBinaryPath
  // 同款多候选根，避免启动入口不同导致资源解析漂移）。
  join(process.cwd(), "bundled-tools"),
  join(process.cwd(), "packages", "desktop", "bundled-tools"),
];

/**
 * 解析并验证桌面随包 helper pair；合法且 operator 未声明时返回两键 env，
 * 否则返回空对象（诚实不注入 —— 从不抛出：供给失配走 degraded_refusing）。
 */
export function resolvePayswapBrokerPeerHelperSupply(
  options: ResolvePayswapBrokerPeerHelperSupplyOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  // P1 仅 win32；darwin 桌面资源在 P9 子里程碑前不携带 helper（同一诚实 law）。
  if (platform !== "win32") return {};

  const env = options.env ?? process.env;
  if (
    env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]?.trim() ||
    env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]?.trim()
  ) {
    return {};
  }

  const manifestPath = resolveStagedManifestPath(options, platform);
  if (!manifestPath) return {};

  let manifest: PayswapBrokerPeerHelperManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PayswapBrokerPeerHelperManifest;
  } catch {
    return {};
  }
  if (!isValidManifest(manifest, options.arch ?? process.arch)) return {};
  if (manifest.helper === null) return {};

  const helper = manifest.helper;
  const binaryPath = join(dirname(manifestPath), helper.binaryName);
  let bytes: Buffer;
  try {
    bytes = readFileSync(binaryPath);
  } catch {
    return {};
  }
  // 注入时 digest 验证（D15.4）：manifest 是 prepare 时算的期望，磁盘字节是事实。
  if (bytes.byteLength !== helper.size) return {};
  if (createHash("sha256").update(bytes).digest("hex") !== helper.sha256) return {};

  return {
    [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: binaryPath,
    [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: helper.sha256,
  };
}

function resolveStagedManifestPath(
  options: ResolvePayswapBrokerPeerHelperSupplyOptions,
  platform: string,
): string | undefined {
  const platformKey = `${platform}-${options.arch ?? process.arch}`;
  const helperDirName = join(platformKey, PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR);
  const candidates = [
    ...(options.isPackaged
      ? [
          join(
            options.resourcesPath ?? process.resourcesPath ?? "",
            PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
            manifestFileName,
          ),
        ]
      : []),
    ...(options.devBundledToolsRoots ?? defaultDevBundledToolsRoots()).map((root) =>
      join(root, helperDirName, manifestFileName),
    ),
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** 严格闭形状 + target 对运行平台/arch（与 SEA 侧 D15.3 校验同语义）。 */
function isValidManifest(manifest: PayswapBrokerPeerHelperManifest, arch: string): boolean {
  if (typeof manifest !== "object" || manifest === null) return false;
  if (!hasExactlyKeys(manifest, ["helper", "target", "version"])) return false;
  if (manifest.version !== 1) return false;
  if (manifest.target !== `win-${arch}`) return false;
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
  return keys.length === expectedKeys.length && expectedKeys.every((key) => key in value);
}
