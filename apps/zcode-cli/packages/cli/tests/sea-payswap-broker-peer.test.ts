import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
} from "@zcode/shared/payswap";
import type { SeaRuntimeModule } from "../src/sea-runtime-tools.js";
import { ensureSeaPayswapBrokerPeerHelper } from "../src/sea-payswap-broker-peer.js";

/**
 * PaySwap P1 —— ADR-15 D15.3 的 SEA 运行时行（POSIX 可跑，fake SEA 模块）：
 *
 * `ensureSeaPayswapBrokerPeerHelper()` 是 `sea-runtime-tools.ts` 的兄弟（同一
 * main.ts 注入位）：严格闭形状 manifest 校验（version/target 对运行平台 arch/
 * binaryName/64-hex digest/size）、抽取到
 * `~/.zcode/cache/payswap_broker_peer/<target>/<sha256>/`（尺寸 + SHA-256 双验、
 * 原子 tmp-then-rename、marker 文件、chmod 0755），仅在 win32 且 helper 存在
 * 且 operator 未设键时注入 PAYSWAP_BROKER_HELPER_PATH + _SHA256。
 *
 * 诚实边界（D15.7）：任何失配（shape/target/digest/size/抽取字节）→ **不注入**
 * —— broker 按既有 boot law 落 degraded_refusing，绝不为此崩掉整个 CLI；
 * 非 SEA 永不注入（D13.9 dev/CI env 键纪律不变）。fake 不转绿平台行
 * （playbook §5(5)）—— gates-windows 对真实 prepare 产物重跑 §5.3 套件。
 */

const HELPER_BINARY_NAME = "payswap-broker-peer-helper.exe";
const helperBytes = Buffer.from("fake-windows-peer-helper-bytes");
const helperSha256 = createHash("sha256").update(helperBytes).digest("hex");

interface SeaFixture {
  manifestText: string | undefined;
  rawAssets: Map<string, Buffer>;
  sea: SeaRuntimeModule;
}

function createSeaFixture(input: {
  binaryBytes?: Buffer;
  manifestText?: string;
  omitManifest?: boolean;
  tamperBinary?: (bytes: Buffer) => Buffer;
}): SeaFixture {
  const binaryBytes = input.tamperBinary
    ? input.tamperBinary(helperBytes)
    : (input.binaryBytes ?? helperBytes);
  const defaultManifest = {
    helper: {
      binaryName: HELPER_BINARY_NAME,
      sha256: helperSha256,
      size: helperBytes.byteLength,
    },
    target: "win-x64",
    version: 1,
  };
  const manifestText = input.manifestText ?? JSON.stringify(defaultManifest, null, 2);
  const rawAssets = new Map<string, Buffer>();
  rawAssets.set(`zcode-payswap-broker-peer/${helperSha256}/${HELPER_BINARY_NAME}`, binaryBytes);

  return {
    manifestText,
    rawAssets,
    sea: {
      getAsset: (key: string) => {
        if (key === "zcode-payswap-broker-peer/manifest.json") {
          if (input.omitManifest || manifestText === undefined) {
            throw new Error(`missing fake SEA asset ${key}`);
          }
          return manifestText;
        }
        throw new Error(`unexpected fake SEA asset ${key}`);
      },
      getRawAsset: (key: string) => {
        const bytes = rawAssets.get(key);
        if (!bytes) throw new Error(`missing fake SEA asset ${key}`);
        return Uint8Array.from(bytes).buffer;
      },
      isSea: () => true,
    },
  };
}

const win32Options = (fixture: SeaFixture, storageRoot: string) => ({
  arch: "x64",
  platform: "win32" as const,
  sea: fixture.sea,
  storageRoot,
});

test("never injects outside a SEA runtime", async () => {
  const result = await ensureSeaPayswapBrokerPeerHelper({
    arch: "x64",
    platform: "win32",
    sea: {
      getAsset: () => {
        throw new Error("unexpected manifest read");
      },
      getRawAsset: () => {
        throw new Error("unexpected asset read");
      },
      isSea: () => false,
    },
  });
  assert.deepEqual(result, {});
});

test("never injects on non-win32 platforms", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-platform-"));
  const fixture = createSeaFixture({});
  try {
    for (const platform of ["darwin", "linux"] as const) {
      const result = await ensureSeaPayswapBrokerPeerHelper({
        arch: "arm64",
        env: {},
        platform,
        sea: fixture.sea,
        storageRoot,
      });
      assert.deepEqual(result, {});
    }
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("extracts the helper and injects the env pair for a matching win32 target", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-extract-"));
  const fixture = createSeaFixture({});
  try {
    const result = await ensureSeaPayswapBrokerPeerHelper(win32Options(fixture, storageRoot));

    const expectedBinaryPath = join(
      storageRoot,
      "cache",
      "payswap_broker_peer",
      "win-x64",
      helperSha256,
      HELPER_BINARY_NAME,
    );
    assert.deepEqual(result, {
      [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: expectedBinaryPath,
      [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: helperSha256,
    });

    assert.deepEqual(await readFile(expectedBinaryPath), helperBytes);
    assert.notEqual((await stat(expectedBinaryPath)).mode & 0o111, 0);

    const marker = JSON.parse(
      await readFile(
        join(storageRoot, "cache", "payswap_broker_peer", "win-x64", helperSha256, ".zcode-payswap-broker-peer-helper.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(marker, {
      binaryName: HELPER_BINARY_NAME,
      sha256: helperSha256,
      size: helperBytes.byteLength,
      target: "win-x64",
      version: 1,
    });
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("reuses the current cache on the second run without re-extraction", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-reuse-"));
  const fixture = createSeaFixture({});
  const options = win32Options(fixture, storageRoot);
  try {
    const first = await ensureSeaPayswapBrokerPeerHelper(options);
    const firstStat = await stat(first[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] as string);

    const second = await ensureSeaPayswapBrokerPeerHelper(options);
    const secondStat = await stat(second[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] as string);

    assert.deepEqual(second, first);
    assert.equal(secondStat.ino, firstStat.ino);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("operator env wins: any of the two keys suppresses injection and extraction", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-operator-"));
  const fixture = createSeaFixture({});
  try {
    for (const operatorEnv of [
      {
        [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: "C:/operator/helper.exe",
        [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: "1".repeat(64),
      },
      { [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: "C:/operator/helper.exe" },
      { [PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]: "1".repeat(64) },
      { [PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]: "  " },
    ]) {
      const result = await ensureSeaPayswapBrokerPeerHelper({
        ...win32Options(fixture, storageRoot),
        env: operatorEnv,
      });
      assert.deepEqual(result, {});
    }

    const cacheRoot = join(storageRoot, "cache", "payswap_broker_peer");
    await assert.rejects(readdir(cacheRoot), /ENOENT/u);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("helper:null and absent manifest records never inject", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-null-"));
  const nullFixture = createSeaFixture({
    manifestText: JSON.stringify({ helper: null, target: "win-x64", version: 1 }),
  });
  const absentFixture = createSeaFixture({ omitManifest: true });
  try {
    assert.deepEqual(
      await ensureSeaPayswapBrokerPeerHelper(win32Options(nullFixture, storageRoot)),
      {},
    );
    assert.deepEqual(
      await ensureSeaPayswapBrokerPeerHelper(win32Options(absentFixture, storageRoot)),
      {},
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("refuses a manifest whose target does not match the running platform/arch", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-target-"));
  const wrongArchFixture = createSeaFixture({
    manifestText: JSON.stringify({
      helper: { binaryName: HELPER_BINARY_NAME, sha256: helperSha256, size: helperBytes.byteLength },
      target: "win-arm64",
      version: 1,
    }),
  });
  const malformedTargetFixture = createSeaFixture({
    manifestText: JSON.stringify({
      helper: null,
      target: "not-a-sea-target",
      version: 1,
    }),
  });
  try {
    assert.deepEqual(
      await ensureSeaPayswapBrokerPeerHelper(win32Options(wrongArchFixture, storageRoot)),
      {},
    );
    assert.deepEqual(
      await ensureSeaPayswapBrokerPeerHelper(win32Options(malformedTargetFixture, storageRoot)),
      {},
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("rejects invalid manifest shapes with an honest no-injection", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-shape-"));
  const helperRecord = {
    binaryName: HELPER_BINARY_NAME,
    sha256: helperSha256,
    size: helperBytes.byteLength,
  };
  const invalidManifests = [
    // version 不是 1
    JSON.stringify({ helper: helperRecord, target: "win-x64", version: 2 }),
    // 缺 helper 键（闭形状）
    JSON.stringify({ target: "win-x64", version: 1 }),
    // 闭形状之外的未知键
    JSON.stringify({ extra: 1, helper: helperRecord, target: "win-x64", version: 1 }),
    JSON.stringify({
      helper: { ...helperRecord, note: "extra" },
      target: "win-x64",
      version: 1,
    }),
    // digest 非 64-hex
    JSON.stringify({
      helper: { ...helperRecord, sha256: "z".repeat(64) },
      target: "win-x64",
      version: 1,
    }),
    JSON.stringify({
      helper: { ...helperRecord, sha256: helperSha256.toUpperCase() },
      target: "win-x64",
      version: 1,
    }),
    // size 非法
    JSON.stringify({ helper: { ...helperRecord, size: -1 }, target: "win-x64", version: 1 }),
    JSON.stringify({ helper: { ...helperRecord, size: 1.5 }, target: "win-x64", version: 1 }),
    // binaryName 非裸文件名
    JSON.stringify({
      helper: { ...helperRecord, binaryName: "../evil.exe" },
      target: "win-x64",
      version: 1,
    }),
    JSON.stringify({
      helper: { ...helperRecord, binaryName: "" },
      target: "win-x64",
      version: 1,
    }),
    // 非 object
    "null",
    "[]",
    "not-json",
  ];

  try {
    for (const manifestText of invalidManifests) {
      const fixture = createSeaFixture({ manifestText });
      assert.deepEqual(
        await ensureSeaPayswapBrokerPeerHelper(win32Options(fixture, storageRoot)),
        {},
        `expected no injection for manifest: ${manifestText}`,
      );
    }
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("size or hash mismatch of the extracted bytes leads to no injection and no cache install", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-mismatch-"));
  const tamperedFixture = createSeaFixture({
    tamperBinary: () => Buffer.from("tampered-helper-bytes"),
  });
  const truncatedFixture = createSeaFixture({
    tamperBinary: (bytes) => bytes.subarray(0, 4),
  });
  const missingAssetFixture = createSeaFixture({});
  missingAssetFixture.rawAssets.clear();

  try {
    for (const fixture of [tamperedFixture, truncatedFixture, missingAssetFixture]) {
      assert.deepEqual(
        await ensureSeaPayswapBrokerPeerHelper(win32Options(fixture, storageRoot)),
        {},
      );
    }

    const cacheRoot = join(storageRoot, "cache", "payswap_broker_peer");
    await assert.rejects(readdir(cacheRoot), /ENOENT/u);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("cache-marker currency: a corrupt cache is repaired on the next run", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-repair-"));
  const fixture = createSeaFixture({});
  const options = win32Options(fixture, storageRoot);
  try {
    const first = await ensureSeaPayswapBrokerPeerHelper(options);
    const binaryPath = first[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY] as string;
    await writeFile(binaryPath, "corrupt");
    const repaired = await ensureSeaPayswapBrokerPeerHelper(options);
    assert.deepEqual(await readFile(binaryPath), helperBytes);
    assert.equal(
      repaired[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY],
      helperSha256,
    );

    // 非法 marker（陈旧记录）同样触发重抽取
    await chmod(binaryPath, 0o644);
    await writeFile(
      join(storageRoot, "cache", "payswap_broker_peer", "win-x64", helperSha256, ".zcode-payswap-broker-peer-helper.json"),
      "{}",
    );
    await ensureSeaPayswapBrokerPeerHelper(options);
    assert.deepEqual(await readFile(binaryPath), helperBytes);
    assert.notEqual((await stat(binaryPath)).mode & 0o111, 0);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("concurrent first runs converge without temporary cache residue", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-race-"));
  const fixture = createSeaFixture({});
  const options = win32Options(fixture, storageRoot);
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureSeaPayswapBrokerPeerHelper(options)),
    );
    for (const result of results.slice(1)) assert.deepEqual(result, results[0]);

    const entries = await collectEntries(join(storageRoot, "cache", "payswap_broker_peer"));
    assert.equal(
      entries.some((entry) => entry.includes(".tmp-")),
      false,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("honors ZCODE_STORAGE_DIR as the cache root override", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-sea-broker-peer-storage-"));
  const overrideRoot = join(storageRoot, "override-storage");
  const fixture = createSeaFixture({});
  try {
    const result = await ensureSeaPayswapBrokerPeerHelper({
      arch: "x64",
      env: { ZCODE_STORAGE_DIR: overrideRoot },
      platform: "win32",
      sea: fixture.sea,
    });
    assert.ok(result[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]?.startsWith(overrideRoot));
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

async function collectEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    entries.push(path);
    if (entry.isDirectory()) entries.push(...(await collectEntries(path)));
  }
  return entries;
}
