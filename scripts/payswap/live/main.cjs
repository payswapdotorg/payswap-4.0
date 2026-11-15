#!/usr/bin/env node
/**
 * PaySwap P2 live 对话面 harness —— 生产装配的 live 实证（仓控重建版）。
 *
 * 这是 PR #33 登记的 `live-harness-main.cjs` 的仓库内重建：真实 law 模块经
 * `build-live-harness.mjs` 从源码 tsup 编译为 CJS bundle（`.live-harness/
 * harness-bundle.cjs`），本入口在 **真实 Electron main 进程** 内组装生产拓扑：
 *
 *   真 safeStorage 键仓（真 OS 钥匙串后端 —— Linux gnome_libsecret）
 *     → 真桌面受监督运行时（accountRuntimeWiring：warmup 现读 + 单写者账户服务）
 *     → 真 MessageChannelMain 桥铸造（accountReaderBridgeEntry 的 port1 serve +
 *        port2 转移面）
 *     → 真法则客户端（shared account-reader-bridge 的 zod 双端校验 + 有界时限）
 *
 * 步骤（与 2026-11-14 登记证据 live-conversational-evidence.json 同名同序）：
 *   1. safeStorage 后端 = 真实 OS 钥匙串后端（非 basic_text）
 *   2. app-ready warmup：PSP 键可从真钥匙串获得
 *   3. 真实受限键 connect → connected
 *   4. at-rest：连接记录 store 含 connection、永不含键明文
 *   5. at-rest：凭据 store 含 connection id、永不含键明文
 *   6. refresh 打真 api.stripe.com → verified + 真 providerAccountId（acct_*）
 *   7. 桥铸造产出真 MessageChannelMain 转移面
 *   8. 对话面 overview 经真桥两跳形态应答（连接在列）
 *   9. 直连服务 getOverviewData（get_account_overview 的 detail 面）
 *  10.（重建新增）对话面 detail 经真桥两跳形态 —— 第 9 步的桥形态同源结局
 *
 * 步骤 9/10 的 lawful 结局闭集：账户未激活（capabilities 空）→ typed
 * `read_back_unavailable` 拒绝（fail-closed —— roadmap「typed refusals where
 * unconfigured」条款）；账户邮箱验证激活后 → `kind:"detail"` 四类别数据。
 * RESULT_HARNESS=0 当且仅当全部步骤 ok（即四类别数据落地）；拒绝边界 = 1。
 *
 * 短路语义（2026-11-15 架构师评审跟进）：**异常短路**（任一步意外失败即止，
 * 与登记证据的 abort-on-first-failure 语义一致）；**设计内 typed 拒绝不短
 * 路** —— 步骤 9 拒绝时步骤 10（桥形态 detail）照常执行：拒绝边界必须同时
 * 以直连与桥两种形态登记，桥形态的执行不得以直连形态成功为前提。
 *
 * ESM/CJS 语义记录（架构师 2026-11-15 裁决的执行侧）：生产源码的
 * `createRequire(import.meta.url)`（services 包，"type":"module"）是合法 ESM
 * 形态，**不是生产缺陷** —— CJS bundle 化产生的 `import.meta` 空对象 shim 是
 * harness 打包侧问题，由 build 脚本的 bundle 后处理修补（bundle 内单点 sed，
 * 永不改生产源码）。node:sqlite 同理：bundle 化把 `node:sqlite` 改写成
 * `sqlite` 说明符，由本入口的 resolve 钩子映射到 throws-on-use stub（P2
 * 账户流不触碰 session DB；stub 只在真被使用时才响亮失败）。
 *
 * 运行（live 验收 VM 内；完整配方见 scripts/payswap/live/README.md）：
 *   node scripts/payswap/live/build-live-harness.mjs
 *   electron --password-store=gnome-libsecret --no-sandbox \
 *     scripts/payswap/live/main.cjs
 *
 * 环境变量：
 *   ZCODE_E2E_STRIPE_LIVE_KEY   真实受限只读测试键（rk_test_*）—— 必需
 *   ZCODE_PAYSWAP_LIVE_SCRATCH  草稿根目录（缺省 packages/desktop/.live-harness/run）
 *   ZCODE_PAYSWAP_LIVE_OUT_DIR  证据输出目录（缺省 packages/desktop/.live-harness/out）
 *   ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND  期望的 safeStorage 后端名（缺省按平台：
 *                               linux=gnome_libsecret / darwin=keychain / win32=dpapi）
 */

"use strict";

const { join, resolve } = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const { app, safeStorage } = require("electron");

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BUNDLE_PATH = join(REPO_ROOT, "packages", "desktop", ".live-harness", "harness-bundle.cjs");
const SQLITE_STUB_PATH = join(__dirname, "sqlite-stub.cjs");

const LIVE_KEY = (process.env.ZCODE_E2E_STRIPE_LIVE_KEY || "").trim();
const SCRATCH = process.env.ZCODE_PAYSWAP_LIVE_SCRATCH
  ? resolve(process.env.ZCODE_PAYSWAP_LIVE_SCRATCH)
  : join(REPO_ROOT, "packages", "desktop", ".live-harness", "run");
const OUT_DIR = process.env.ZCODE_PAYSWAP_LIVE_OUT_DIR
  ? resolve(process.env.ZCODE_PAYSWAP_LIVE_OUT_DIR)
  : join(REPO_ROOT, "packages", "desktop", ".live-harness", "out");

const EXPECTED_BACKEND =
  process.env.ZCODE_PAYSWAP_LIVE_EXPECT_BACKEND ||
  (process.platform === "linux"
    ? "gnome_libsecret"
    : process.platform === "darwin"
      ? "keychain"
      : "dpapi");

// ---------------------------------------------------------------------------
// 环境前置（顺序敏感）
// ---------------------------------------------------------------------------

// services paths.ts 在模块加载期快照 ZCODE_DATA_BASE_DIR —— 必须先于 bundle
// require 设置（跨 bundle 实例一致的 store 落点：<scratch>/data/.zcode/v2）。
const DATA_BASE_DIR = join(SCRATCH, "data");
process.env.ZCODE_DATA_BASE_DIR = DATA_BASE_DIR;

// electron app 的 userData（键仓文件落点）隔离到草稿目录。
app.setPath("userData", join(SCRATCH, "electron-user-data"));

// node:sqlite → throws-on-use stub（bundle 化的说明符改写修补；P2 账户流不触
// session DB —— stub 只在真被使用时才响亮失败，load-time 零影响）。
const nativeResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
  if (request === "sqlite" || request === "node:sqlite") {
    return SQLITE_STUB_PATH;
  }
  return nativeResolveFilename.call(this, request, ...rest);
};

// ---------------------------------------------------------------------------
// 证据记录（与登记工件同格式）
// ---------------------------------------------------------------------------

/** @type {{harness: string, startedAt: string, steps: Array<{name: string, ok: boolean, detail: unknown}>, failedAt?: string}} */
const evidence = {
  harness: "payswap-p2-live-conversational",
  startedAt: new Date().toISOString(),
  steps: [],
};

/** 设计内 typed 拒绝的步骤失败标记（区别于异常：detail 保留结构化 refusal，
 * 与登记证据「ok:false + refusal detail」同形 —— 异常路径才走 {error} 形态）。 */
const STEP_REFUSED = Symbol("payswap.live.stepRefused");

/**
 * 记录并执行一步；意外失败（异常）时记录 failedAt，由调用方短路返回（与
 * 登记证据的 abort-on-first-failure 语义一致）。回调可返回
 * `{ [STEP_REFUSED]: detail }` 标记设计内拒绝（记录 ok:false + 结构化
 * detail，不按异常处理 —— 调用方据 refused 决定是否继续后续步骤）。
 * @returns {Promise<{ok: boolean, refused: boolean}>} 该步结局（refused=true
 *   表示设计内 typed 拒绝：已登记，但不是意外失败）。
 */
async function step(name, operation) {
  try {
    const detail = await operation();
    if (detail && typeof detail === "object" && detail[STEP_REFUSED] !== undefined) {
      evidence.steps.push({ name, ok: false, detail: detail[STEP_REFUSED] });
      evidence.failedAt = name;
      console.log(`[live-harness] refused ${name}`);
      return { ok: false, refused: true };
    }
    evidence.steps.push({ name, ok: true, detail: detail === undefined ? {} : detail });
    console.log(`[live-harness] ok    ${name}`);
    return { ok: true, refused: false };
  } catch (error) {
    // 错误消息消毒：真实键永不进证据/日志（字符串替换而非丢弃，保留可诊断性）。
    const message = String(error && error.message ? error.message : error);
    const sanitized = LIVE_KEY ? message.split(LIVE_KEY).join("<redacted-live-key>") : message;
    evidence.steps.push({ name, ok: false, detail: { error: sanitized } });
    evidence.failedAt = name;
    console.error(`[live-harness] FAIL  ${name}: ${sanitized}`);
    return { ok: false, refused: false };
  }
}

/** at-rest 秘密纪律断言（错误消息零键材料）。 */
function assertNoLiveSecret(material, label) {
  if (typeof material === "string" && LIVE_KEY && material.includes(LIVE_KEY)) {
    throw new Error(`${label}: at-rest 材料含真实键明文（法则：永不落明文）`);
  }
}

async function readTextIfExists(path) {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!LIVE_KEY) {
    throw new Error("ZCODE_E2E_STRIPE_LIVE_KEY 缺席 —— live harness 需要真实受限只读键");
  }
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error(
      `bundle 缺席（${BUNDLE_PATH}）—— 先运行 node scripts/payswap/live/build-live-harness.mjs`,
    );
  }

  await fsp.mkdir(SCRATCH, { recursive: true });
  await fsp.mkdir(OUT_DIR, { recursive: true });

  // 真实 law 模块（bundle 侧 zod 校验/法则全为源码编译产物 —— 非替身）。
  const bundle = require(BUNDLE_PATH);
  const {
    createPayswapPspKeyStore,
    warmupPayswapPspRuntimeEnv,
    createPayswapDesktopAccountRuntime,
    createPayswapReaderBridgePortMinter,
    adaptMessagePortMainToPayswapReaderBridgePort,
    createPayswapReaderBridgeClient,
    getAppConfigDir,
  } = bundle;

  const keyStorePath = join(app.getPath("userData"), "payswap-psp-safe-storage-key");
  const connectionsStorePath = join(getAppConfigDir(), "payswap-connections.json");
  const credentialsStorePath = join(getAppConfigDir(), "credentials.json");

  // 真 safeStorage 键仓（Electron main-only API 的真实实现直接作结构端口）。
  const keyStore = createPayswapPspKeyStore({
    safeStorage,
    platform: process.platform,
    resolveKeyStorePath: () => keyStorePath,
    readFile: async (path) => {
      try {
        return await fsp.readFile(path);
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    writeFile: async (path, data) => {
      await fsp.mkdir(join(path, ".."), { recursive: true });
      await fsp.writeFile(path, data, { mode: 0o600 });
    },
  });

  // 受监督运行时（warmup 现读 + 按需重建 + 单写者账户服务 + 桥服务端）。
  const runtime = createPayswapDesktopAccountRuntime({
    keyStore,
    onWarmupError: (error) => {
      console.warn("[live-harness] warmup error:", error && error.message ? error.message : error);
    },
  });

  /** @type {string | null} */
  let connectionId = null;

  // 步骤 1：后端是真 OS 钥匙串后端（basic_text/unknown = 失败 —— 硬编码密码不是
  // OS 钥匙串保护，live 实证不得在该后端上成立）。
  if (
    !(await step("safeStorage backend is a real OS keychain backend", async () => {
      const backendSelected = safeStorage.getSelectedStorageBackend();
      if (backendSelected !== EXPECTED_BACKEND) {
        throw new Error(
          `safeStorage 后端为 '${backendSelected}'，期望 '${EXPECTED_BACKEND}' —— live 实证要求真实 OS 钥匙串后端（--password-store=gnome-libsecret + org.freedesktop.secrets 在场）`,
        );
      }
      return { backendSelected };
    })).ok
  )
    return finish();

  // 步骤 2：app-ready warmup（键仓首跑生成随机键并经 wrap→unwrap 往返验证）。
  if (
    !(await step("app-ready warmup: PSP key available from the real keyring", async () => {
      const warm = await warmupPayswapPspRuntimeEnv({ keyStore });
      if (!warm.keyAvailable) {
        throw new Error("warmup 后 PSP 键不可用（键仓两级 fail-closed 之一命中 —— 见上方 warn）");
      }
      return { keyAvailable: warm.keyAvailable };
    })).ok
  )
    return finish();

  // 步骤 3：真实受限键 connect（operator-supplied-secret 流；真法则校验格式/模式）。
  if (
    !(await step("connect with the real restricted key lands connected", async () => {
      const accountService = (await runtime.getRuntime()).accountService;
      const result = await accountService.connect({
        providerId: "stripe",
        operatorSecret: LIVE_KEY,
        displayName: "P2 Live Conversational",
      });
      if (result.kind !== "connected") {
        throw new Error(
          `connect 结局 '${result.kind}'${result.kind === "refused" ? ` (${result.refusal.code}: ${result.refusal.message})` : ""} —— 期望 connected`,
        );
      }
      connectionId = result.connection.connectionId;
      return { connectionId, mode: result.connection.mode };
    })).ok
  )
    return finish();

  // 步骤 4/5：at-rest 双 store（含 connection、永不含键明文 —— 直接读文件检查）。
  if (
    !(await step("at-rest: connections store contains the connection, never the key", async () => {
      const connections = await readTextIfExists(connectionsStorePath);
      if (connections === null) throw new Error("connections store 文件缺席（应已写入）");
      if (!connections.includes(connectionId)) throw new Error("connections store 不含 connectionId");
      assertNoLiveSecret(connections, "connections store");
      return {};
    })).ok
  )
    return finish();

  if (
    !(await step("at-rest: credential store contains the connection id, never the key", async () => {
      const credentials = await readTextIfExists(credentialsStorePath);
      if (credentials === null) throw new Error("credentials store 文件缺席（应已写入 PSP 密文）");
      if (!credentials.includes(connectionId)) throw new Error("credentials store 不含 connectionId");
      assertNoLiveSecret(credentials, "credentials store");
      return {};
    })).ok
  )
    return finish();

  // 步骤 6：refresh 打真 api.stripe.com（真 read-back adapter + 全局 fetch）。
  if (
    !(await step("refresh against live api.stripe.com lands verified with the real account id", async () => {
      const accountService = (await runtime.getRuntime()).accountService;
      const result = await accountService.refreshEvidence({ connectionId });
      if (result.kind !== "verified") {
        throw new Error(
          `refresh 结局 '${result.kind}'${result.kind === "refused" ? ` (${result.refusal.code}: ${result.refusal.message})` : ""} —— 期望 verified（真键 + 真网络）`,
        );
      }
      return { kind: result.kind, providerAccountId: result.providerAccountId };
    })).ok
  )
    return finish();

  // 步骤 7/8：真 MessageChannelMain 桥铸造 + 对话面 overview（两跳形态）。
  /** @type {import("electron").MessagePortMain | null} */
  let bridgePort = null;
  if (
    !(await step("bridge mint produces a real MessageChannelMain transfer face", async () => {
      const minter = createPayswapReaderBridgePortMinter(runtime);
      bridgePort = minter();
      if (bridgePort === null) throw new Error("桥铸造返回 null（fail-safe 路径 —— 不应发生）");
      return {};
    })).ok
  )
    return finish();

  if (
    !(await step("conversational overview via the bridge: the connected account is listed", async () => {
      const adapted = adaptMessagePortMainToPayswapReaderBridgePort(bridgePort);
      // 客户端侧 MessagePortMain 面需显式 start() 才开始投递（铸币器只 start 了
      // serve 侧 port1 —— 两跳形态的客户端半是调用方责任）。
      bridgePort.start();
      const client = createPayswapReaderBridgeClient({ port: adapted });
      const overview = await client.accountOverviewReader();
      const ids = overview.map((entry) => entry.connectionId);
      if (!ids.includes(connectionId)) {
        throw new Error(`桥 overview 未列出连接（count=${overview.length}；ids=${ids.join(",")}）`);
      }
      return { count: overview.length };
    })).ok
  )
    return finish();

  // 步骤 9：直连服务 getOverviewData（get_account_overview 的 detail 面）。
  // lawful 闭集：未激活账户 → typed read_back_unavailable（fail-closed，登记于
  // 证据为 ok:false + 结构化 refusal detail —— 与 2026-11-14 登记运行同形）；
  // 激活后 → kind:"detail" 四类别数据（ok:true）。设计内拒绝**不短路**：步骤
  // 10（桥形态）照常执行（2026-11-15 架构师评审跟进）。
  const directDetail = await step("direct service getOverviewData returns real detail", async () => {
    const accountService = (await runtime.getRuntime()).accountService;
    const detail = await accountService.getOverviewData({ connectionId });
    if (detail.kind === "detail") {
      const categories = {};
      for (const [category, outcome] of Object.entries(detail.data)) {
        categories[category] = outcome.status;
      }
      return { kind: "detail", categories };
    }
    if (detail.kind === "refused") {
      // 设计内拒绝：结构化登记（ok:false —— harness 在此边界上以退出码区分）。
      return { [STEP_REFUSED]: { kind: "refused", refusal: detail.refusal } };
    }
    return { [STEP_REFUSED]: { kind: detail.kind } };
  });
  if (!directDetail.ok && !directDetail.refused) return finish();

  // 步骤 10（重建新增）：对话面 detail 经真桥两跳形态 —— 与步骤 9 同源法则的
  // 桥形态结局（「read-only ops run conversationally」条款的 detail 半）。无论
  // 步骤 9 落在数据（激活后）还是设计内拒绝（未激活），本步都执行 —— 拒绝
  // 边界必须同样以桥形态登记，不以直连形态成功为前提。
  await step("conversational detail via the bridge: get_account_overview returns real detail", async () => {
    const adapted = adaptMessagePortMainToPayswapReaderBridgePort(bridgePort);
    bridgePort.start();
    const client = createPayswapReaderBridgeClient({ port: adapted });
    const detail = await client.accountDetailReader(connectionId);
    if (detail.kind === "detail") {
      const categories = {};
      for (const [category, outcome] of Object.entries(detail.data)) {
        categories[category] = outcome.status;
      }
      return { kind: "detail", categories };
    }
    if (detail.kind === "refused") {
      return { [STEP_REFUSED]: { kind: "refused", refusal: detail.refusal } };
    }
    return { [STEP_REFUSED]: { kind: detail.kind } };
  });

  return finish();
}

async function finish() {
  // RESULT 语义：0 = 全部步骤 ok（四类别数据落地）；1 = 任一步未 ok（含设计内
  // 的 typed 拒绝边界 —— 与 2026-11-14 登记运行 RESULT_HARNESS=1 同语义）。
  const allOk = evidence.steps.length > 0 && evidence.steps.every((entry) => entry.ok);
  const resultCode = allOk ? 0 : 1;

  try {
    // at-rest 投影快照（登记工件 payswap-connections-at-rest.json 同源：连接
    // 记录 store 的直接读 —— 无秘密面）。
    const { getAppConfigDir } = require(BUNDLE_PATH);
    const connectionsStorePath = join(getAppConfigDir(), "payswap-connections.json");
    const connectionsText = await readTextIfExists(connectionsStorePath);
    if (connectionsText !== null) {
      await fsp.writeFile(
        join(OUT_DIR, "payswap-connections-at-rest.json"),
        JSON.stringify(JSON.parse(connectionsText), null, 2) + "\n",
      );
    }
    await fsp.writeFile(
      join(OUT_DIR, "live-conversational-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    await fsp.writeFile(join(OUT_DIR, "RESULT-harness.txt"), `RESULT_HARNESS=${resultCode}\n`);
    console.log(`[live-harness] evidence written to ${OUT_DIR}`);
  } catch (error) {
    console.error("[live-harness] evidence write failed:", error && error.message ? error.message : error);
  }

  app.exit(resultCode);
}

process.on("uncaughtException", (error) => {
  const message = String(error && error.message ? error.message : error);
  const sanitized = LIVE_KEY ? message.split(LIVE_KEY).join("<redacted-live-key>") : message;
  console.error("[live-harness] uncaught:", sanitized);
  evidence.steps.push({ name: "uncaught exception", ok: false, detail: { error: sanitized } });
  evidence.failedAt = "uncaught exception";
  finish().finally(() => app.exit(1));
});

app.whenReady().then(main).catch((error) => {
  console.error("[live-harness] main failed:", error && error.message ? error.message : error);
  app.exit(1);
});
