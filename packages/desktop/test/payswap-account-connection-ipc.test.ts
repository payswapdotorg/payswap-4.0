/**
 * PaySwap P2.2（ADR-P2-2 Decision 4，slice 7）—— 桌面连接通道装配
 * （`packages/desktop/src/main/payswap/accountConnectionIpc.ts` +
 * `desktopPayswapBootstrap.installDesktopPayswapConnections`）的装配级证明。
 *
 * 被测法则（模块文件头）：
 * - 通道注册（ipcMain.handle 结构面）+ unregister；
 * - 真实事件形状 → 法则三检（主框架引用相等 + 受信 origin 现读）；
 * - 全链路：IPC 请求 → 受监督运行时（slice 6）→ 真实账户服务 → 真实凭据/连接
 *   store（at-rest 无明文）；
 * - 无键 fail-safe 装配：connect 得到 Gate E2 typed 拒绝**作数据**（ok:true +
 *   refused 结果 —— 连接 UI 呈现 typed 拒绝的 Gate E2 E2E 条款 riding 本通道）；
 * - 通道失败闭集经注册处理体的映射（malformed_request / internal_error）。
 *
 * 法则级的另一级（闭集 schema、三检矩阵、秘密单向性）住
 * `apps/zcode-cli/packages/bootstrap/tests/payswap-account-connection-rpc.test.ts`。
 *
 * 装配级：真实 account service + 真实 psp 键 store（safeStorage double）+ 真实
 * 凭据/连接 store（临时目录 + setDataBaseDir 隔离）；ipcMain 与主窗口 URL 来源
 * 注入；Electron 模块面 mock（desktopPayswapBootstrap 的其余装配不在本套件范围）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { setDataBaseDir } from "@zcode/services/node";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import type {
  PayswapConnectionRpcResponse,
  PayswapConnectionRpcServiceFace,
} from "@zcode/shared/payswap";
import {
  installDesktopPayswapConnections,
  installPayswapDesktopConnectionIpc,
  PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL,
} from "../src/main/payswap/index.js";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  },
  webContents: { fromId: () => undefined },
}));

const TEST_SECRET = `sk_test_${"e5f6a7b8".repeat(6)}`;
const TRUSTED_URL = "http://localhost:5173/index.html?workspace=w1";

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------

type FakeIpcMain = Pick<IpcMain, "handle" | "removeHandler"> & {
  handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>;
};

function fakeIpcMain(): FakeIpcMain {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, payload: unknown) => unknown
  >();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
}

/** 主框架事件 double（senderFrame 与 sender.mainFrame 同一对象 —— Electron 语义）。 */
function mainFrameEvent(frameUrl: string): IpcMainInvokeEvent {
  const mainFrame = { url: frameUrl };
  return { sender: { id: 7, mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

function subFrameEvent(frameUrl: string): IpcMainInvokeEvent {
  const mainFrame = { url: frameUrl };
  return {
    sender: { id: 7, mainFrame },
    senderFrame: { url: frameUrl },
  } as unknown as IpcMainInvokeEvent;
}

/** safeStorage double：可用性与 Linux 后端可编程；加解密为恒等（真实键 store 走完整落盘路径）。 */
function safeStorageDouble(
  available: () => boolean,
  backend: () => string = () => "gnome_libsecret",
) {
  return {
    isEncryptionAvailable: available,
    getSelectedStorageBackend: backend,
    encryptString: (plain: string) => Buffer.from(plain, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  };
}

function zeroCallApiClient(): ApiClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(input: string | URL, _init?: ApiRequestInit): Promise<Response> {
      calls.push(String(input));
      throw new Error("unexpected transport call");
    },
  };
}

async function invoke(
  ipcMain: FakeIpcMain,
  event: IpcMainInvokeEvent,
  payload: unknown,
): Promise<PayswapConnectionRpcResponse> {
  const handler = ipcMain.handlers.get(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL);
  if (handler === undefined) throw new Error("connection channel not registered");
  return (await handler(event, payload)) as PayswapConnectionRpcResponse;
}

// ---------------------------------------------------------------------------
// IPC 模块（fake 服务面 —— 通道注册/三检/闭集的装配半）
// ---------------------------------------------------------------------------

describe("payswap desktop connection ipc (ADR-P2-2 Decision 4, slice 7) — the wiring module", () => {
  it("registers the channel, forwards to the host law, and unregisters", async () => {
    const ipcMain = fakeIpcMain();
    const service: PayswapConnectionRpcServiceFace = {
      async connect() {
        throw new Error("not reached");
      },
      async revoke() {
        throw new Error("not reached");
      },
      async refreshEvidence() {
        throw new Error("not reached");
      },
      async listConnections() {
        return [];
      },
    };
    const registration = installPayswapDesktopConnectionIpc({
      ipcMain,
      getMainWindowFrameUrl: () => TRUSTED_URL,
      getAccountService: async () => service,
    });
    expect(ipcMain.handlers.has(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL)).toBe(true);

    const response = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), { op: "list" });
    expect(response).toEqual({ ok: true, op: "list", result: [] });

    const denied = await invoke(
      ipcMain,
      subFrameEvent(TRUSTED_URL),
      { op: "list" },
    );
    expect(denied.ok).toBe(false);

    registration.unregister();
    expect(ipcMain.handlers.has(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 入口装配（真实受监督运行时 + 真实 store 的全链路）
// ---------------------------------------------------------------------------

async function assembleConnections(
  options?: { safeStorageAvailable?: () => boolean; safeStorageBackend?: () => string },
) {
  const dir = await mkdtemp(join(tmpdir(), "payswap-connections-ipc-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  const ipcMain = fakeIpcMain();
  const apiClient = zeroCallApiClient();
  const installation = installDesktopPayswapConnections({
    getMainWindowFrameUrl: () => TRUSTED_URL,
    ipcMain,
    // 平台显式 linux：后端政策是 Linux-only 查询 —— 装配级测试不受宿主平台影响。
    platform: "linux",
    safeStorage: safeStorageDouble(
      options?.safeStorageAvailable ?? (() => true),
      options?.safeStorageBackend ?? (() => "gnome_libsecret"),
    ),
    keyStoreDependencies: {
      resolveKeyStorePath: () => join(dir, "payswap-psp-safe-storage-key"),
      readFile: async (path) => {
        try {
          return await readFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      writeFile: async (path, data) => {
        await writeFile(path, data, { mode: 0o600 });
      },
    },
    runtimeDependencies: {
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      apiClient,
      mintConnectionId: () => "77777777-7777-4777-8777-777777777777",
    },
  });
  return { installation, ipcMain, dir, apiClient };
}

describe("payswap desktop connections installation (ADR-P2-2 Decision 4, slice 7) — the full chain", () => {
  it("connect over the channel lands at-rest ciphertext and lists the projection (zero transport calls)", async () => {
    const { installation, ipcMain, dir, apiClient } = await assembleConnections();
    const connected = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
      displayName: "ci fixtures",
    });
    expect(connected).toEqual({
      ok: true,
      op: "connect",
      result: {
        kind: "connected",
        connection: {
          connectionId: "77777777-7777-4777-8777-777777777777",
          providerId: "stripe",
          mode: "test",
          displayName: "ci fixtures",
          status: "connected",
        },
      },
    });
    // connect/list 是纯本地操作 —— 零 transport 触达（Stripe 面只在 refresh/detail）。
    expect(apiClient.calls).toHaveLength(0);

    const listed = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), { op: "list" });
    expect(listed.ok).toBe(true);
    if (listed.ok && Array.isArray(listed.result)) {
      expect(listed.result).toHaveLength(1);
      expect(listed.result[0]?.status).toBe("connected");
    }

    // at-rest：连接记录无秘密；凭据 store（CLI 数据根 basis —— getAppConfigDir）是密文。
    const connectionStore = await readFile(join(dir, "payswap-connections.json"), "utf8");
    expect(connectionStore).not.toContain(TEST_SECRET);
    const credentialsStore = await readFile(
      join(dir, ".zcode", "v2", "credentials.json"),
      "utf8",
    );
    expect(credentialsStore).not.toContain(TEST_SECRET);
    expect(credentialsStore).toContain("77777777-7777-4777-8777-777777777777");

    // 单写者面共享：registration 的服务与 runtime.getRuntime 是同一实例（键状态未变）。
    expect((await installation.runtime.getRuntime()).accountService).toBeDefined();
    expect(installation.runtime.runtimeRebuilds).toBeGreaterThanOrEqual(1);
  });

  it("no-key fail-safe assembly: connect answers the Gate E2 typed refusal AS DATA through the channel", async () => {
    const { ipcMain } = await assembleConnections({ safeStorageAvailable: () => false });
    const response = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    // Gate E2 的 UI 条款：typed 拒绝经通道作数据呈现（ok:true + refused —— 非 internal_error）。
    expect(response.ok).toBe(true);
    if (response.ok) {
      const result = response.result as { kind: string; refusal?: { code: string } };
      expect(result.kind).toBe("refused");
      expect(result.refusal?.code).toBe("PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE");
    }
  });

  it("Gate E2 backend policy (linux basic_text, available=true): connect answers the typed storage refusal AS DATA; at-rest stays zero-write (refusal precedes every write)", async () => {
    // 架构师评审 Blocker A 的装配级臂：isEncryptionAvailable() === true 但后端是
    // basic_text（硬编码密码 —— 非 OS 钥匙串）→ 与不可用同判。拒绝先于任何写：
    // 键文件、凭据 store、连接记录全部缺席。
    const { ipcMain, dir } = await assembleConnections({
      safeStorageAvailable: () => true,
      safeStorageBackend: () => "basic_text",
    });
    const response = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      const result = response.result as { kind: string; refusal?: { code: string } };
      expect(result.kind).toBe("refused");
      expect(result.refusal?.code).toBe("PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE");
    }
    // at-rest 零写：键文件与两个 store 都不建（拒绝先于记录/密文写）。
    await expect(readFile(join(dir, "payswap-psp-safe-storage-key"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "payswap-connections.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, ".zcode", "v2", "credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects subframe senders and malformed payloads through the registered handler", async () => {
    const { ipcMain } = await assembleConnections();
    const denied = await invoke(ipcMain, subFrameEvent(TRUSTED_URL), { op: "list" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unauthorized_origin");

    const malformed = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), { op: "destroy" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe("malformed_request");
  });

  it("maps a failing store write to internal_error (record-write failure compensates and rethrows)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "payswap-connections-ipc-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    // 阻塞文件：store 路径的父目录是个普通文件 → mkdir ENOTDIR（atomic write 会建目录，
    // 缺席目录不失败 —— 法则级事实；用文件占位才能注入写失败）。
    await writeFile(join(dir, "blocker"), "not a directory", { mode: 0o600 });
    const ipcMain = fakeIpcMain();
    const internalErrors: unknown[] = [];
    installDesktopPayswapConnections({
      getMainWindowFrameUrl: () => TRUSTED_URL,
      ipcMain,
      platform: "linux",
      safeStorage: safeStorageDouble(() => true),
      keyStoreDependencies: {
        resolveKeyStorePath: () => join(dir, "payswap-psp-safe-storage-key"),
        readFile: async () => null,
        writeFile: async () => {},
      },
      runtimeDependencies: {
        resolveStorePath: () => join(dir, "blocker", "payswap-connections.json"),
        apiClient: zeroCallApiClient(),
        mintConnectionId: () => "77777777-7777-4777-8777-777777777777",
      },
      onInternalError: (error) => internalErrors.push(error),
    });
    const response = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe("internal_error");
    expect(internalErrors).toHaveLength(1);
    // 补偿行：记录写失败后不留孤儿 PSP 密文（键名从凭据 store 消失 —— 密文本体永不入断言）。
    const credentialPath = join(dir, ".zcode", "v2", "credentials.json");
    let credentialRaw = "";
    try {
      credentialRaw = await readFile(credentialPath, "utf8");
    } catch {
      credentialRaw = "";
    }
    expect(credentialRaw).not.toContain("payswap:psp:");
  });
});
