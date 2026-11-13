import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME,
  PAYSWAP_BROKER_PEER_HELPER_MANIFEST_FILE_NAME,
  payswapBrokerPeerHelperSourceRoot,
  preparePayswapBrokerPeerHelper,
  resolvePayswapBrokerPeerHelperPlan,
} from "../scripts/prepare-payswap-broker-peer-helper.mjs";

/**
 * PaySwap P1 —— ADR-15 D15.1/D15.2 的宿主半边行（POSIX 可跑，fake 编译器）：
 *
 * 单一 CLI 持有 prepare 纪律（apps/zcode-cli/packages/cli/scripts/
 * prepare-payswap-broker-peer-helper.mjs）必须与 gates-windows 的 csc 编译纪律
 * 逐字节同源（/nologo /optimize+ /target:exe /platform:<arch> /warnaserror+
 * /win32manifest:app.manifest /reference:System.Core.dll）；staging 落位
 * packages/desktop/bundled-tools/<platformKey>/payswap-broker-peer/（runtime-tools
 * 同一根）；manifest v1（version/target/helper{binaryName,sha256,size}|null）。
 *
 * 纪律行（D15.1/D15.2，playbook §5(5)：fake 不转绿平台行 —— 平台行在
 * gates-windows 上对真实 csc 产物重跑 §5.3 套件）：
 *   - win 目标 + win32 宿主：编译（fake csc 记录 argv，断言精确 flag 集）→
 *     binary+manifest 成对 staging，digest 由编译产物计算；
 *   - win 目标 + win32 宿主 + 无编译器：大声失败（拒绝静默降级出货），且不落
 *     任何 manifest；
 *   - arm64 只经显式 ZCODE_CSC_PATH（Roslyn override），缺省拒绝；
 *   - darwin/linux 目标（P1 刻意 no-op）与外国宿主交叉构建：helper:null 显式
 *     缺席记录，构建不失败；
 *   - 重新 staging 清除陈旧 pair（stale pair 不存活）。
 */

const NATIVE_SOURCE_FILES = {
  "Program.cs": "// fake payswap broker peer helper source (host-half row)\n",
  "app.manifest": "<?xml version=\"1.0\"?>\n<assembly />\n",
};

async function createFakeRepositoryRoot(directory) {
  const root = join(directory, "root");
  const sourceRoot = join(root, "apps/zcode-cli/native/payswap-broker-peer-windows");
  await mkdir(sourceRoot, { recursive: true });
  for (const [name, contents] of Object.entries(NATIVE_SOURCE_FILES)) {
    await writeFile(join(sourceRoot, name), contents);
  }
  return root;
}

async function createFakeCscCompiler(directory, logPath) {
  const fakeCscPath = join(directory, "fake-csc.mjs");
  await writeFile(
    fakeCscPath,
    [
      "#!/usr/bin/env node",
      "import { mkdirSync, writeFileSync } from \"node:fs\";",
      "import { dirname, join, resolve } from \"node:path\";",
      "const args = process.argv.slice(2);",
      "// 调用记录写在本脚本旁（无 env 依赖 —— prepare 把 ZCODE_CSC_PATH 之外的 env 不透传给编译器）。",
      "writeFileSync(",
      "  join(dirname(resolve(process.argv[1])), \"csc-invocation.json\"),",
      "  JSON.stringify({ args, cwd: process.cwd() }, null, 2),",
      ");",
      "const outArg = args.find((argument) => argument.startsWith(\"/out:\"));",
      "const target = resolve(process.cwd(), outArg.slice(\"/out:\".length));",
      "mkdirSync(dirname(target), { recursive: true });",
      "writeFileSync(target, \"fake-payswap-broker-peer-helper-bytes\");",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeCscPath, 0o755);
  return fakeCscPath;
}

const readStagedManifest = async (root, target) => {
  const plan = resolvePayswapBrokerPeerHelperPlan({ root, target });
  return JSON.parse(await readFile(plan.manifestPath, "utf8"));
};

test("resolves every staging plan onto the runtime-tools bundled-tools root", () => {
  const root = "/repo";
  assert.deepEqual(
    ["win-x64", "win-arm64"].map((target) => {
      const plan = resolvePayswapBrokerPeerHelperPlan({ root, target });
      return [target, plan.platformKey, plan.outputDir];
    }),
    [
      [
        "win-x64",
        "win32-x64",
        "/repo/packages/desktop/bundled-tools/win32-x64/payswap-broker-peer",
      ],
      [
        "win-arm64",
        "win32-arm64",
        "/repo/packages/desktop/bundled-tools/win32-arm64/payswap-broker-peer",
      ],
    ],
  );
});

test("compiles a win target on a win32 host with exactly the CI-gates csc discipline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-"));
  const root = await createFakeRepositoryRoot(directory);
  const cscLogPath = join(directory, "csc-invocation.json");
  const fakeCscPath = await createFakeCscCompiler(directory, cscLogPath);

  try {
    const result = await preparePayswapBrokerPeerHelper({
      env: { ZCODE_CSC_PATH: fakeCscPath },
      hostPlatform: "win32",
      root,
      target: "win-x64",
    });

    const plan = resolvePayswapBrokerPeerHelperPlan({ root, target: "win-x64" });
    assert.equal(result.helperPath, plan.binaryPath);
    const stagedBytes = Buffer.from("fake-payswap-broker-peer-helper-bytes");
    assert.deepEqual(await readFile(plan.binaryPath), stagedBytes);

    const manifest = await readStagedManifest(root, "win-x64");
    assert.deepEqual(manifest, {
      helper: {
        binaryName: PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME,
        sha256: createHash("sha256").update(stagedBytes).digest("hex"),
        size: stagedBytes.byteLength,
      },
      target: "win-x64",
      version: 1,
    });

    // 编译产物先落在 native/<project>/out/（gates-windows 旧编译位、平台套件
    // fallback 路径），再拷贝进 staging —— 打包产物与被证明产物同字节。
    const sourceRoot = payswapBrokerPeerHelperSourceRoot(root);
    const builtPath = join(sourceRoot, "out", PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME);
    assert.deepEqual(await readFile(builtPath), stagedBytes);

    const invocation = JSON.parse(await readFile(cscLogPath, "utf8"));
    assert.deepEqual(invocation.args, [
      "/nologo",
      "/optimize+",
      "/target:exe",
      "/platform:x64",
      "/warnaserror+",
      "/win32manifest:app.manifest",
      "/reference:System.Core.dll",
      `/out:out/${PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME}`,
      "Program.cs",
    ]);
    assert.equal(invocation.cwd, sourceRoot);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("compiles win-arm64 only through an explicit Roslyn ZCODE_CSC_PATH override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-arm64-"));
  const root = await createFakeRepositoryRoot(directory);
  const cscLogPath = join(directory, "csc-invocation.json");
  const fakeCscPath = await createFakeCscCompiler(directory, cscLogPath);

  try {
    await assert.rejects(
      preparePayswapBrokerPeerHelper({
        env: {},
        hostPlatform: "win32",
        root,
        target: "win-arm64",
      }),
      /arm64.*ZCODE_CSC_PATH|ZCODE_CSC_PATH.*arm64/us,
    );

    const result = await preparePayswapBrokerPeerHelper({
      env: { ZCODE_CSC_PATH: fakeCscPath },
      hostPlatform: "win32",
      root,
      target: "win-arm64",
    });
    assert.ok(result.helperPath);
    const invocation = JSON.parse(await readFile(cscLogPath, "utf8"));
    assert.deepEqual(
      invocation.args.filter((argument) => argument.startsWith("/platform:")),
      ["/platform:arm64"],
    );
    const manifest = await readStagedManifest(root, "win-arm64");
    assert.equal(manifest.target, "win-arm64");
    assert.equal(manifest.helper.binaryName, PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("fails loudly when a win32-host build cannot find the compiler and stages no manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-loud-"));
  const root = await createFakeRepositoryRoot(directory);

  try {
    await assert.rejects(
      preparePayswapBrokerPeerHelper({
        env: {},
        hostPlatform: "win32",
        root,
        target: "win-x64",
      }),
      /csc\.exe|compiler/us,
    );

    const plan = resolvePayswapBrokerPeerHelperPlan({ root, target: "win-x64" });
    // 大声失败 ≠ 帮 null 记录：绝不为 win32 本机构建伪造显式缺席（D15.1）。
    await assert.rejects(readFile(plan.manifestPath), /ENOENT/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("stages the explicit helper:null manifest for darwin and linux targets without compiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-noop-"));
  const root = await createFakeRepositoryRoot(directory);
  const cscLogPath = join(directory, "csc-invocation.json");
  const fakeCscPath = await createFakeCscCompiler(directory, cscLogPath);

  try {
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      const result = await preparePayswapBrokerPeerHelper({
        env: { ZCODE_CSC_PATH: fakeCscPath },
        hostPlatform: "win32",
        root,
        target,
      });
      assert.deepEqual(result.manifest, {
        target,
        helper: null,
        version: 1,
      });
      assert.equal(result.helperPath, null);
    }

    // P1 刻意 no-op：即使宿主有编译器也不得触碰它（darwin 打包是 P9 递延）。
    await assert.rejects(readFile(cscLogPath), /ENOENT/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("stages helper:null for a foreign-host win cross-build instead of failing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-foreign-"));
  const root = await createFakeRepositoryRoot(directory);
  const cscLogPath = join(directory, "csc-invocation.json");
  const fakeCscPath = await createFakeCscCompiler(directory, cscLogPath);

  try {
    for (const hostPlatform of ["linux", "darwin"]) {
      const result = await preparePayswapBrokerPeerHelper({
        env: { ZCODE_CSC_PATH: fakeCscPath },
        hostPlatform,
        root,
        target: "win-x64",
      });
      assert.deepEqual(result.manifest, {
        target: "win-x64",
        helper: null,
        version: 1,
      });
      assert.equal(result.helperPath, null);

      const plan = resolvePayswapBrokerPeerHelperPlan({ root, target: "win-x64" });
      assert.deepEqual(await readdir(plan.outputDir), [
        PAYSWAP_BROKER_PEER_HELPER_MANIFEST_FILE_NAME,
      ]);
    }
    await assert.rejects(readFile(cscLogPath), /ENOENT/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("restaging sweeps stale pairs so a stale binary never survives a null record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-sweep-"));
  const root = await createFakeRepositoryRoot(directory);

  try {
    const plan = resolvePayswapBrokerPeerHelperPlan({ root, target: "darwin-x64" });
    await mkdir(plan.outputDir, { recursive: true });
    await writeFile(join(plan.outputDir, PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME), "stale");
    await writeFile(
      plan.manifestPath,
      JSON.stringify({
        helper: { binaryName: PAYSWAP_BROKER_PEER_HELPER_BINARY_NAME, sha256: "0".repeat(64), size: 5 },
        target: "darwin-x64",
        version: 1,
      }),
    );

    await preparePayswapBrokerPeerHelper({
      env: {},
      hostPlatform: "darwin",
      root,
      target: "darwin-x64",
    });

    assert.deepEqual(await readdir(plan.outputDir), [
      PAYSWAP_BROKER_PEER_HELPER_MANIFEST_FILE_NAME,
    ]);
    const manifest = await readStagedManifest(root, "darwin-x64");
    assert.equal(manifest.helper, null);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects unsupported targets and missing native sources loudly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-payswap-peer-prepare-invalid-"));
  const root = await createFakeRepositoryRoot(directory);

  try {
    await assert.rejects(
      preparePayswapBrokerPeerHelper({
        env: {},
        hostPlatform: "win32",
        root,
        target: "win-ia32",
      }),
      /Unsupported SEA target/u,
    );

    const sourcelessRoot = join(directory, "sourceless-root");
    await mkdir(join(sourcelessRoot, "apps/zcode-cli/native"), { recursive: true });
    await assert.rejects(
      preparePayswapBrokerPeerHelper({
        env: {},
        hostPlatform: "win32",
        root: sourcelessRoot,
        target: "win-x64",
      }),
      /Program\.cs|app\.manifest/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
