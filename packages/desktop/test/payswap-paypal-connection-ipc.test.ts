/**
 * PaySwap P3 provider half —— PayPal client-credentials 流经**真实桌面 IPC 链**
 * 的端到端证明（ADR-P2-2 Decision 4 连接通道 + P3 client-credentials 形态）。
 *
 * 与 `payswap-account-connection-ipc.test.ts`（Stripe 面）同款装配纪律 —— 这里
 * 钉住的是 PayPal 面在窗口真实 IPC 路径上的行为：
 * 1. **connect 凭据对经通道** → connected AS DATA（mode = 显式声明 test）；凭据
 *    对按两个 PSP 槽（client-id + client-secret）落真实键 store（safeStorage
 *    键仓包装 + 派生 AES 密文）—— 记录 store 与凭据 store 零明文。
 * 2. **校验拒绝经通道**：缺 clientId / 缺 mode → `validation_failed` AS DATA，
 *    零 store 触达（拒绝先于任何写入）。
 * 3. **refresh 经通道** → 真实 token 交换（注入 apiClient double：POST
 *    {sandbox}/v1/oauth2/token + Basic 凭据对）→ `verified`（providerAccountId
 *    = 官方 app_id）AS DATA —— PayPal 官方身份面经窗口 IPC 链成立。
 * 4. **revoke 经通道** → 两个槽全部清除（撤销必证实清除经通道成立）。
 */

import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import type { PayswapConnectionRpcResponse } from "@zcode/shared/payswap";
import {
  installDesktopPayswapConnections,
  PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL,
} from "../src/main/payswap/index.js";
import { afterAll, describe, expect, it, vi } from "vitest";

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

const CLIENT_ID = "AXe2payswapTestIdClient";
const CLIENT_SECRET = "EXe2payswapTestSecret" + "9".repeat(52);
const APP_ID = "APP-80W284485P519522T";
const ACCESS_TOKEN = "A21.e2eAccessToken" + "1".repeat(48);
const TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
const TRUSTED_URL = "http://localhost:5173/index.html?workspace=w1";

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// doubles（与 Stripe 面同款装配纪律）
// ---------------------------------------------------------------------------

type FakeIpcMain = Pick<IpcMain, "handle" | "removeHandler"> & {
  handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>;
};

function fakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
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

function mainFrameEvent(frameUrl: string): IpcMainInvokeEvent {
  const mainFrame = { url: frameUrl };
  return { sender: { id: 7, mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
}

function safeStorageDouble(available: () => boolean) {
  return {
    isEncryptionAvailable: available,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (plain: string) => Buffer.from(plain, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
  };
}

/** PayPal token 交换 double：记录 wire 形状并回答封套（或 401 —— 编程式）。 */
function paypalTokenApiClient(
  mode: () => "ok" | "unauthorized",
): ApiClient & { calls: Array<{ url: string; auth: string; body: string }> } {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  return {
    calls,
    async request(input: string | URL, init?: ApiRequestInit): Promise<Response> {
      const headers = init?.headers;
      let auth = "";
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        auth = headers.get("Authorization") ?? "";
      } else if (Array.isArray(headers)) {
        auth = (headers.find(([n]) => n.toLowerCase() === "authorization") ?? ["", ""])[1] ?? "";
      } else if (headers && typeof headers === "object") {
        const record = headers as Record<string, string>;
        for (const [name, value] of Object.entries(record)) {
          if (name.toLowerCase() === "authorization") auth = value;
        }
      }
      calls.push({ url: String(input), auth, body: typeof init?.body === "string" ? init.body : "" });
      if (mode() === "unauthorized") {
        return new Response(JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({ scope: "https://uri.paypal.com/services/invoicing", access_token: ACCESS_TOKEN, token_type: "Bearer", app_id: APP_ID, expires_in: 32400 }),
        { status: 200 },
      );
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

async function assembleConnections(apiClient: ApiClient) {
  const dir = await mkdtemp(join(tmpdir(), "payswap-paypal-ipc-"));
  createdDirs.push(dir);
  const { setDataBaseDir } = await import("@zcode/services/node");
  setDataBaseDir(dir);
  const ipcMain = fakeIpcMain();
  const installation = installDesktopPayswapConnections({
    getMainWindowFrameUrl: () => TRUSTED_URL,
    ipcMain,
    platform: "linux",
    safeStorage: safeStorageDouble(() => true),
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
      mintConnectionId: () => "88888888-8888-4888-8888-888888888888",
    },
  });
  return { installation, ipcMain, dir };
}

describe("payswap paypal connection ipc (P3 provider half) — the client-credentials flow through the real desktop channel", () => {
  it("connect pair over the channel lands both PSP slots and lists the projection; validation refusals answer AS DATA with zero store writes", async () => {
    const { installation, ipcMain, dir } = await assembleConnections(
      paypalTokenApiClient(() => "ok"),
    );

    // 校验拒绝行：缺 mode → validation_failed AS DATA；零 store 触达。
    const noMode = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
    });
    expect(noMode.ok).toBe(true);
    if (noMode.ok && noMode.op === "connect" && noMode.result.kind === "refused") {
      expect(noMode.result.refusal.code).toBe("validation_failed");
    } else {
      throw new Error("expected validation_failed AS DATA for the missing mode");
    }

    // 校验拒绝行：缺 clientId → validation_failed AS DATA；零 store 触达。
    const noId = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      mode: "test",
    });
    expect(noMode.ok).toBe(true);
    if (noId.ok && noId.op === "connect" && noId.result.kind === "refused") {
      expect(noId.result.refusal.code).toBe("validation_failed");
    } else {
      throw new Error("expected validation_failed AS DATA for the missing clientId");
    }
    const credentialsBefore = await readFile(join(dir, ".zcode", "v2", "credentials.json"), "utf8")
      .catch(() => "");
    expect(credentialsBefore).not.toContain(CLIENT_SECRET);
    expect(credentialsBefore).not.toContain(CLIENT_ID);

    // connect 凭据对经通道 → connected AS DATA（mode 显式声明）。
    const connected = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
      mode: "test",
      displayName: "PayPal sandbox app",
    });
    expect(connected).toEqual({
      ok: true,
      op: "connect",
      result: {
        kind: "connected",
        connection: {
          connectionId: "88888888-8888-4888-8888-888888888888",
          providerId: "paypal",
          mode: "test",
          displayName: "PayPal sandbox app",
          status: "connected",
        },
      },
    });

    const listed = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), { op: "list" });
    expect(listed.ok).toBe(true);
    if (listed.ok && Array.isArray(listed.result)) {
      expect(listed.result).toHaveLength(1);
      expect(listed.result[0]?.providerId).toBe("paypal");
      expect(listed.result[0]?.status).toBe("connected");
    }

    // at-rest：凭据对按两个 PSP 槽落真实键 store（client-id + client-secret）；
    // 记录 store 与凭据 store 零明文。
    const credentialsStore = await readFile(join(dir, ".zcode", "v2", "credentials.json"), "utf8");
    expect(credentialsStore).toContain("88888888-8888-4888-8888-888888888888");
    expect(credentialsStore).toContain("client-id");
    expect(credentialsStore).toContain("client-secret");
    expect(credentialsStore).not.toContain(CLIENT_SECRET);
    expect(credentialsStore).not.toContain(CLIENT_ID);
    const connectionStore = await readFile(join(dir, "payswap-connections.json"), "utf8");
    expect(connectionStore).not.toContain(CLIENT_SECRET);
    expect(connectionStore).not.toContain(CLIENT_ID);
    expect(installation.runtime.runtimeRebuilds).toBeGreaterThanOrEqual(1);
  });

  it("refresh over the channel performs the real token exchange and answers verified{app_id} AS DATA; revoke clears both slots", async () => {
    const apiClient = paypalTokenApiClient(() => "ok");
    const { ipcMain, dir } = await assembleConnections(apiClient);
    const connected = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
      mode: "test",
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok || connected.op !== "connect" || connected.result.kind !== "connected") {
      throw new Error("expected connected");
    }
    const connectionId = connected.result.connection.connectionId;

    // refresh 经通道：真实 token 交换（sandbox 端点 + Basic 凭据对 + form grant）。
    const refreshed = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "refresh",
      connectionId,
    });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok && refreshed.op === "refresh" && refreshed.result.kind === "verified") {
      expect(refreshed.result.providerAccountId).toBe(APP_ID);
      expect(refreshed.result.connection.status).toBe("connected");
    } else {
      throw new Error("expected verified AS DATA through the channel");
    }

    // wire 形状：恰一次触达、官方 token 端点、Basic 凭据对、form grant。
    expect(apiClient.calls).toHaveLength(1);
    expect(apiClient.calls[0]?.url).toBe(TOKEN_URL);
    expect(apiClient.calls[0]?.auth.startsWith("Basic ")).toBe(true);
    const basic = Buffer.from(apiClient.calls[0]?.auth.slice(6) ?? "", "base64").toString("utf8");
    expect(basic).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);
    expect(apiClient.calls[0]?.body).toContain("grant_type=client_credentials");

    // revoke 经通道：两个槽全部清除（撤销必证实清除经通道成立）。注意：撤销
    // 与其 at-rest 断言必须在第二个装配（安全行）改变全局 data basis 之前完成
    // —— 凭据文件按当前 basis 解析（生产恰一个 basis；测试中两个装配各自
    // setDataBaseDir）。
    const revoked = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "revoke",
      connectionId,
    });
    expect(revoked.ok).toBe(true);
    if (revoked.ok && revoked.op === "revoke" && revoked.result.kind === "revoked") {
      expect(revoked.result.connection.status).toBe("revoked");
    } else {
      throw new Error("expected revoked AS DATA");
    }
    const credentialsAfter = await readFile(join(dir, ".zcode", "v2", "credentials.json"), "utf8");
    expect(credentialsAfter.includes("88888888-8888-4888-8888-888888888888:client-id")).toBe(false);
    expect(credentialsAfter.includes("88888888-8888-4888-8888-888888888888:client-secret")).toBe(false);

    // 安全行：401（轮换/吊销的凭据对）→ expired AS DATA —— 唯一 expiry 证据。
    const failingClient = paypalTokenApiClient(() => "unauthorized");
    const second = await assembleConnections(failingClient);
    const bogus = await invoke(second.ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "paypal",
      operatorSecret: CLIENT_SECRET,
      clientId: CLIENT_ID,
      mode: "test",
    });
    expect(bogus.ok).toBe(true);
    if (!bogus.ok || bogus.op !== "connect" || bogus.result.kind !== "connected") {
      throw new Error("expected bogus connection to connect (verification happens at refresh)");
    }
    const expired = await invoke(second.ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "refresh",
      connectionId: bogus.result.connection.connectionId,
    });
    expect(expired.ok).toBe(true);
    if (expired.ok && expired.op === "refresh" && expired.result.kind === "expired") {
      expect(expired.result.connection.status).toBe("expired");
    } else {
      throw new Error("expected expired AS DATA for the 401 refresh");
    }
  });
});
