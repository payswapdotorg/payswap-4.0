/**
 * PaySwap P1 —— ADR-15 D15.3：SEA collector 的 payswap broker peer helper 面
 * （sea-runtime-tool-assets.mjs 的兄弟；P1 仅 win 目标内嵌）。
 *
 * 内嵌资产键（D15.3）：
 *   - zcode-payswap-broker-peer/manifest.json（helper 记录或显式 helper:null）；
 *   - zcode-payswap-broker-peer/<sha256>/<binaryName>（仅 helper 非 null）。
 *
 * 纪律：
 *   - darwin/linux 目标一概不嵌（darwin 打包是 P9 递延；Linux 臂按设计无 helper）；
 *   - win 目标读取 prepare 脚本（prepare-payswap-broker-peer-helper.mjs）staging
 *     的成对 manifest —— 缺 manifest 或 pair 失配（stale/mismatched）当场失败：
 *     二进制没有它的 manifest（或反之）绝不内嵌（D15.2 的不可分离对纪律）；
 *   - 外国宿主交叉构建的 helper:null manifest 照常内嵌 —— SEA 产物照常构建，
 *     平台诚实 boot degraded_refusing（D15.1）。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { targetParts } from "./sea-targets.mjs";

export const seaPayswapBrokerPeerAssetPrefix = "zcode-payswap-broker-peer/";
export const seaPayswapBrokerPeerManifestAssetKey = `${seaPayswapBrokerPeerAssetPrefix}manifest.json`;

const binaryAssetKeyFor = (helper) =>
  `${seaPayswapBrokerPeerAssetPrefix}${helper.sha256}/${helper.binaryName}`;

/** staging 根（与 runtime-tools 同根；platformKey 用桌面 bundled-tools 键族）。 */
export const payswapBrokerPeerHelperStagingDir = (root, target) => {
  const { arch, releasePlatform } = targetParts(target);
  const platformKey = `${releasePlatform === "win" ? "win32" : releasePlatform}-${arch}`;
  return resolve(
    root,
    "packages",
    "desktop",
    "bundled-tools",
    platformKey,
    "payswap-broker-peer",
  );
};

function validateStagedManifest(manifest, target) {
  const fail = () =>
    new Error(`Invalid payswap broker peer helper manifest staged for ${target}.`);

  if (typeof manifest !== "object" || manifest === null) throw fail();
  if (Object.keys(manifest).length !== 3 || !("helper" in manifest) || !("target" in manifest) || !("version" in manifest)) {
    throw fail();
  }
  if (manifest.version !== 1) throw fail();
  if (manifest.target !== target) {
    throw new Error(
      `Payswap broker peer helper manifest target mismatch for ${target}: staged manifest declares ${String(manifest.target)}.`,
    );
  }
  if (manifest.helper === null) return null;

  const helper = manifest.helper;
  if (typeof helper !== "object" || helper === null) throw fail();
  if (Object.keys(helper).length !== 3 || !("binaryName" in helper) || !("sha256" in helper) || !("size" in helper)) {
    throw fail();
  }
  if (
    typeof helper.binaryName !== "string" ||
    basename(helper.binaryName) !== helper.binaryName ||
    !/^[A-Za-z0-9._-]+$/u.test(helper.binaryName)
  ) {
    throw fail();
  }
  if (typeof helper.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(helper.sha256)) {
    throw fail();
  }
  if (!Number.isSafeInteger(helper.size) || helper.size <= 0) throw fail();
  return helper;
}

export const collectSeaPayswapBrokerPeerAssets = async ({ root, target }) => {
  const { releasePlatform } = targetParts(target);
  if (releasePlatform !== "win") {
    // P1：darwin/linux SEA 不内嵌任何 broker-helper 资产（P9 递延 / 设计缺席）。
    return { assets: {}, manifest: null };
  }

  const helperDir = payswapBrokerPeerHelperStagingDir(root, target);
  const manifestPath = join(helperDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Missing SEA payswap broker peer helper manifest for ${target}: ${manifestPath}. ` +
        "Run scripts/prepare-payswap-broker-peer-helper.mjs before building the SEA binary.",
      { cause: error },
    );
  }

  const helper = validateStagedManifest(manifest, target);
  const assets = { [seaPayswapBrokerPeerManifestAssetKey]: manifestPath };
  if (!helper) return { assets, manifest };

  const binaryPath = join(helperDir, helper.binaryName);
  let bytes;
  try {
    bytes = await readFile(binaryPath);
  } catch (error) {
    throw new Error(
      `Missing staged payswap broker peer helper binary for ${target}: ${binaryPath}.`,
      { cause: error },
    );
  }
  if (bytes.byteLength !== helper.size || createHash("sha256").update(bytes).digest("hex") !== helper.sha256) {
    // stale pair（二进制与 manifest 失配）绝不内嵌 —— 内嵌即被 manifest 指认的
    // 供给被偷换。构建当场失败，逼一次干净 prepare。
    throw new Error(
      `Stale payswap broker peer helper pair staged for ${target}: the binary at ${binaryPath} ` +
        `does not match the manifest digest (sha256 mismatch). Re-run the prepare script.`,
    );
  }

  assets[binaryAssetKeyFor(helper)] = binaryPath;
  return { assets, manifest };
};
