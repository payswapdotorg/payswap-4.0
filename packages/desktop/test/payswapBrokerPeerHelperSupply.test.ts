import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
} from "@zcode/shared/payswap";
import {
  PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
  resolvePayswapBrokerPeerHelperSupply,
} from "#src/main/payswapBrokerPeerHelperSupply.js";

/**
 * PaySwap P1 —— ADR-15 D15.4 的桌面注入解析行（POSIX 可跑，fake resourcesPath）：
 *
 * 桌面 agent-env 组装（desktopRuntimeEnv.ts 的 buildHostProcessEnv，CUA helper
 * app 供给先例）经本解析器解析 process.resourcesPath/payswap-broker-peer/<binary>、
 * 读取随包 manifest、在注入时验证二进制 digest，并把同一对键注入 agent env ——
 * 同一 operator-wins 优先级，任何失配诚实不注入（agent 落 degraded_refusing，
 * §5.4 诊断可达）。P1 仅 win32；dev 回退沿 bundled-tools 相对路径族。
 * fake 不转绿平台行（playbook §5(5)）—— gates-windows 对真实 prepare 产物重跑。
 */

const HELPER_BINARY_NAME = "payswap-broker-peer-helper.exe";
const helperBytes = Buffer.from("fake-desktop-peer-helper-bytes");
const helperSha256 = createHash("sha256").update(helperBytes).digest("hex");

async function stageHelperPair(root: string, options: { manifestHelper?: unknown; binaryBytes?: Buffer } = {}) {
  const helperDir = join(root, PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR);
  await mkdir(helperDir, { recursive: true });
  await writeFile(join(helperDir, HELPER_BINARY_NAME), options.binaryBytes ?? helperBytes);
  await writeFile(
    join(helperDir, "manifest.json"),
    JSON.stringify(
      options.manifestHelper === undefined
        ? { helper: { binaryName: HELPER_BINARY_NAME, sha256: helperSha256, size: helperBytes.byteLength }, target: "win-x64", version: 1 }
        : options.manifestHelper,
      null,
      2,
    ),
  );
  return helperDir;
}

describe("resolvePayswapBrokerPeerHelperSupply", () => {
  it("fake resourcesPath + 成对 manifest 注入同一对 env 键", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-supply-"));
    try {
      const resourcesPath = join(directory, "resources");
      await mkdir(resourcesPath, { recursive: true });
      await stageHelperPair(resourcesPath);

      const supply = resolvePayswapBrokerPeerHelperSupply({
        arch: "x64",
        env: {},
        isPackaged: true,
        platform: "win32",
        resourcesPath,
      });

      expect(supply).toEqual({
        [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: join(
          resourcesPath,
          PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
          HELPER_BINARY_NAME,
        ),
        [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: helperSha256,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("二进制 digest 失配 → 诚实不注入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-mismatch-"));
    try {
      const resourcesPath = join(directory, "resources");
      await mkdir(resourcesPath, { recursive: true });
      await stageHelperPair(resourcesPath, { binaryBytes: Buffer.from("tampered") });

      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "x64",
          env: {},
          isPackaged: true,
          platform: "win32",
          resourcesPath,
        }),
      ).toEqual({});
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("manifest 声明的尺寸与实际不符 → 诚实不注入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-size-"));
    try {
      const resourcesPath = join(directory, "resources");
      await mkdir(resourcesPath, { recursive: true });
      await stageHelperPair(resourcesPath, {
        manifestHelper: {
          helper: { binaryName: HELPER_BINARY_NAME, sha256: helperSha256, size: helperBytes.byteLength + 1 },
          target: "win-x64",
          version: 1,
        },
      });

      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "x64",
          env: {},
          isPackaged: true,
          platform: "win32",
          resourcesPath,
        }),
      ).toEqual({});
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("operator 已设任一供给键 → operator 胜出，桌面不注入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-operator-"));
    try {
      const resourcesPath = join(directory, "resources");
      await mkdir(resourcesPath, { recursive: true });
      await stageHelperPair(resourcesPath);

      for (const operatorEnv of [
        { [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: "C:/operator/helper.exe", [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: "1".repeat(64) },
        { [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: "C:/operator/helper.exe" },
        { [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: "1".repeat(64) },
      ]) {
        expect(
          resolvePayswapBrokerPeerHelperSupply({
            arch: "x64",
            env: operatorEnv,
            isPackaged: true,
            platform: "win32",
            resourcesPath,
          }),
        ).toEqual({});
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  // runtime-tools 优先级规则逐字适用（D15.3/D15.4）：trim 后为空的值不构成
  // operator 声明（resolveDefaultPeerRelayHelper 同样 trim）。
  it("trim 后为空的 operator 值不构成声明（同款规则）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-whitespace-"));
    try {
      const resourcesPath = join(directory, "resources");
      await mkdir(resourcesPath, { recursive: true });
      await stageHelperPair(resourcesPath);

      const supply = resolvePayswapBrokerPeerHelperSupply({
        arch: "x64",
        env: { [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: "   " },
        isPackaged: true,
        platform: "win32",
        resourcesPath,
      });
      expect(supply[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]).toBe(helperSha256);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("非 win32 平台、helper:null、target 失配与损坏 manifest → 全部诚实不注入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-noop-"));
    try {
      const resourcesPath = join(directory, "resources");
      await mkdir(resourcesPath, { recursive: true });
      await stageHelperPair(resourcesPath);

      // 非 win32（P1 仅 win32；darwin 桌面资源在 P9 子里程碑前不携带 helper）
      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "arm64",
          env: {},
          isPackaged: true,
          platform: "darwin",
          resourcesPath,
        }),
      ).toEqual({});

      // target 与运行平台/arch 不符 → 拒绝
      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "arm64",
          env: {},
          isPackaged: true,
          platform: "win32",
          resourcesPath,
        }),
      ).toEqual({});

      const nullResourcesPath = join(directory, "resources-null");
      await mkdir(nullResourcesPath, { recursive: true });
      await stageHelperPair(nullResourcesPath, {
        manifestHelper: { helper: null, target: "win-x64", version: 1 },
      });
      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "x64",
          env: {},
          isPackaged: true,
          platform: "win32",
          resourcesPath: nullResourcesPath,
        }),
      ).toEqual({});

      const corruptResourcesPath = join(directory, "resources-corrupt");
      await mkdir(corruptResourcesPath, { recursive: true });
      const corruptHelperDir = join(corruptResourcesPath, PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR);
      await mkdir(corruptHelperDir, { recursive: true });
      await writeFile(join(corruptHelperDir, HELPER_BINARY_NAME), helperBytes);
      await writeFile(join(corruptHelperDir, "manifest.json"), "{ not json");
      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "x64",
          env: {},
          isPackaged: true,
          platform: "win32",
          resourcesPath: corruptResourcesPath,
        }),
      ).toEqual({});

      // 缺少整个资源目录 → 不注入
      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "x64",
          env: {},
          isPackaged: true,
          platform: "win32",
          resourcesPath: join(directory, "resources-absent"),
        }),
      ).toEqual({});
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("dev bundled-tools 相对路径族回退解析 staging pair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-desktop-broker-peer-dev-"));
    try {
      const bundledToolsRoot = join(directory, "bundled-tools");
      const platformRoot = join(bundledToolsRoot, "win32-x64");
      await mkdir(platformRoot, { recursive: true });
      await stageHelperPair(platformRoot);

      expect(
        resolvePayswapBrokerPeerHelperSupply({
          arch: "x64",
          devBundledToolsRoots: [bundledToolsRoot],
          env: {},
          isPackaged: false,
          platform: "win32",
        }),
      ).toEqual({
        [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: join(
          platformRoot,
          PAYSWAP_BROKER_PEER_HELPER_RESOURCE_DIR,
          HELPER_BINARY_NAME,
        ),
        [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: helperSha256,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
