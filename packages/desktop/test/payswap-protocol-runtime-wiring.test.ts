/**
 * PaySwap P3-D —— 协议宿主在**真实 desktop main 受监督运行时**里的装配证明。
 *
 * 被测对象：`desktopPayswapBootstrap.installDesktopPayswapConnections`（生产入口
 * 装配）→ `accountRuntimeWiring.createPayswapDesktopAccountRuntime`（受监督运行时）
 * → `services` 的 `createPayswapProtocolRuntime`（协议宿主）。没有 mock 的协议面、
 * 没有绕过装配的直连 —— law 级行为住 `packages/services/test/
 * payswap-protocol-host.test.ts`，本套件只证明「生产装配出来的就是它」。
 *
 * 被钉住的法则（违反即实现缺陷）：
 * 1. **一个 PaySwap 运行时**：协议宿主住既有的 desktop main 受监督运行时 ——
 *    不另起第二个运行时/注册表。安装面暴露恰一个协议运行时（冻结、同一实例）。
 * 2. **恰装配一次、不随账户运行时重建而重建**：键可用性变化会重建账户运行时
 *    （accountRuntimeWiring 法则 1），协议宿主的 challenge 注册表**不**跟着重建
 *    —— 否则一次钥匙串事件就会静默重置重放状态。
 * 3. **生产装配不发收据**：返回面只有 `protocolHost`（无证据签发能力）—— P3 的
 *    生产宿主对任何协议、任何证据引用都发不出收据。
 * 4. **协议面不触 provider / 不触 PSP 键**：协议操作零 transport 调用、零键仓读取。
 * 5. **Windows 生产组合不受影响**：`credentialCustody: "custodian-required"` +
 *    win32 + 无 custodian 桥 —— 账户 connect fail-closed 拒绝，协议边界照常。
 * 6. **保全**：协议操作不改变账户 reader 路径与连接通道的行为。
 *
 * 装配级：真实受监督运行时 + 真实 psp 键 store（safeStorage double）+ 真实凭据/
 * 连接 store（临时目录 + setDataBaseDir 隔离）；ipcMain 与主窗口 URL 来源注入；
 * Electron 模块面 mock。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { setDataBaseDir } from "@zcode/services/node";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE,
  canonicalJsonStringify,
  type PayswapConnectionRpcResponse,
} from "@zcode/shared/payswap";
import {
  installDesktopPayswapConnections,
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

const TRUSTED_URL = "http://localhost:5173/index.html?workspace=w1";
const TEST_SECRET = `sk_test_${"e5f6a7b8".repeat(6)}`;
const NOW_ISO = "2026-11-22T00:00:00.000Z";
const CHALLENGE_EXPIRES = "2026-11-22T00:10:00Z";

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

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

function safeStorageDouble() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
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

function jcsBase64Url(payload: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJsonStringify(payload));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const MPP_CHALLENGE = {
  id: "ch_desktop_wiring",
  realm: "api.example.com",
  method: "stripe",
  intent: "charge",
  request: jcsBase64Url({
    amount: "1500",
    currency: "usd",
    methodDetails: { networkId: "net_stripe_profile_1", paymentMethodTypes: ["card"] },
  }),
  expires: CHALLENGE_EXPIRES,
};

const X402_PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: "https://api.example.com/premium-data", description: "Access to premium market data" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
  extensions: {},
};

function x402Payment(nonce = "0x" + "f374".repeat(16)) {
  return {
    protocolId: "x402" as const,
    message: {
      x402Kind: "payment-payload" as const,
      payload: {
        x402Version: 2,
        accepted: X402_PAYMENT_REQUIRED.accepts[0],
        payload: {
          signature: "0x" + "2d6a".repeat(32) + "1c",
          authorization: {
            from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            value: "10000",
            validAfter: "1760672089",
            validBefore: "1763672154",
            nonce,
          },
        },
        extensions: {},
      },
    },
  };
}

async function assembleConnections(options?: { custodianRequired?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "payswap-protocol-wiring-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  const ipcMain = fakeIpcMain();
  const apiClient = zeroCallApiClient();
  const clock = { iso: NOW_ISO };
  const keyStoreReads: string[] = [];
  const installation = installDesktopPayswapConnections({
    getMainWindowFrameUrl: () => TRUSTED_URL,
    ipcMain,
    ...(options?.custodianRequired ? { platform: "win32" } : { platform: "linux" }),
    safeStorage: safeStorageDouble(),
    keyStoreDependencies: {
      resolveKeyStorePath: () => join(dir, "payswap-psp-safe-storage-key"),
      readFile: async (path) => {
        keyStoreReads.push(path);
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
      now: () => clock.iso,
      ...(options?.custodianRequired ? { credentialCustody: "custodian-required" as const } : {}),
    },
  });
  return { installation, ipcMain, apiClient, clock, keyStoreReads, dir };
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

describe("payswap desktop protocol runtime wiring (P3-D) — the supervised assembly", () => {
  it("the real desktop entry assembly installs exactly one protocol runtime exposing only the host face (no evidence issuer)", async () => {
    const { installation } = await assembleConnections();
    const protocolRuntime = installation.runtime.protocolRuntime;
    expect(protocolRuntime).toBeDefined();
    expect(Object.isFrozen(protocolRuntime)).toBe(true);
    // 返回面闭集：只有 protocolHost —— 证据签发能力不在任何生产可达面上。
    expect(Object.keys(protocolRuntime)).toEqual(["protocolHost"]);
    expect(installation.runtime.protocolRuntime).toBe(protocolRuntime);
    expect(typeof protocolRuntime.protocolHost.handleInbound).toBe("function");
    expect(typeof protocolRuntime.protocolHost.emitReceipt).toBe("function");
  });

  it("protocol messages are handled through the real runtime: MPP challenge consumed once; malformed, stale, replayed and unsupported refused", async () => {
    const { installation, clock } = await assembleConnections();
    const host = installation.runtime.protocolRuntime.protocolHost;

    await host.issueMppChallenge({ wireChallenge: MPP_CHALLENGE });
    const credential = {
      protocolId: "mpp" as const,
      message: { mppKind: "credential", payload: { challenge: MPP_CHALLENGE, payload: { spt: "spt_abc123" } } },
    };

    const malformed = await host.handleInbound({
      protocolId: "mpp",
      message: { mppKind: "credential", payload: { challenge: { ...MPP_CHALLENGE, request: "%%%" }, payload: { spt: "spt_x" } } },
    });
    expect(malformed.kind).toBe("refused");

    const consumed = await host.handleInbound(credential);
    expect(consumed.kind).toBe("challenge-consumed");
    if (consumed.kind !== "challenge-consumed") return;
    expect(consumed.credential).toBe("unverified");

    const replay = await host.handleInbound(credential);
    expect(replay.kind).toBe("refused");
    if (replay.kind === "refused") expect(replay.refusal.code).toBe("protocol_challenge_consumed");

    // 新 challenge：宿主时钟越过 expires → stale。
    const staleChallenge = { ...MPP_CHALLENGE, id: "ch_desktop_stale" };
    await host.issueMppChallenge({ wireChallenge: staleChallenge });
    clock.iso = "2026-11-22T00:10:00.000Z";
    const stale = await host.handleInbound({
      protocolId: "mpp",
      message: { mppKind: "credential", payload: { challenge: staleChallenge, payload: { spt: "spt_abc123" } } },
    });
    expect(stale.kind).toBe("refused");
    if (stale.kind === "refused") expect(stale.refusal.code).toBe("protocol_challenge_expired");

    const unsupported = await host.handleInbound({
      protocolId: "mpp",
      message: { mppKind: "challenge", payload: { ...MPP_CHALLENGE, method: "hedera" } },
    });
    expect(unsupported.kind).toBe("refused");
    if (unsupported.kind === "refused") expect(unsupported.refusal.code).toBe("protocol_feature_unsupported");

    // x402 同一宿主：402 广告 → 付款单次消费。
      await host.issueX402PaymentRequired({ wirePaymentRequired: X402_PAYMENT_REQUIRED });
      expect((await host.handleInbound(x402Payment())).kind).toBe("challenge-consumed");
    const x402Replay = await host.handleInbound(x402Payment());
    expect(x402Replay.kind).toBe("refused");
    if (x402Replay.kind === "refused") expect(x402Replay.refusal.code).toBe("protocol_challenge_consumed");
  });

  it("the protocol runtime survives account-runtime rebuilds — replay state is not reset by a key-availability change", async () => {
    const { installation, clock } = await assembleConnections();
    const runtime = installation.runtime;
    const host = runtime.protocolRuntime.protocolHost;

    await host.issueMppChallenge({ wireChallenge: MPP_CHALLENGE });
    const credential = {
      protocolId: "mpp" as const,
      message: { mppKind: "credential", payload: { challenge: MPP_CHALLENGE, payload: { spt: "spt_abc123" } } },
    };
    expect((await host.handleInbound(credential)).kind).toBe("challenge-consumed");

    // 账户运行时因键可用性变化重建（首次装配：键不可用 → 可用）。
    const before = runtime.runtimeRebuilds;
    const firstAccountRuntime = await runtime.getRuntime();
    const after = runtime.runtimeRebuilds;
    expect(after).toBeGreaterThanOrEqual(before + 1);

    // 协议运行时仍是同一实例，重放仍被拒。
    expect(runtime.protocolRuntime.protocolHost).toBe(host);
    clock.iso = "2026-11-22T00:05:00.000Z";
    const replay = await runtime.protocolRuntime.protocolHost.handleInbound(credential);
    expect(replay.kind).toBe("refused");
    if (replay.kind === "refused") expect(replay.refusal.code).toBe("protocol_challenge_consumed");
    expect(firstAccountRuntime).toBeDefined();
  });

  it("P3 production posture: the real runtime has no evidence issuer — every protocol refuses every receipt reference, and protocol work performs no provider IO", async () => {
    const { installation, apiClient, keyStoreReads } = await assembleConnections();
    const host = installation.runtime.protocolRuntime.protocolHost;

    for (const protocolId of ["ap2", "x402", "mpp"] as const) {
      const outcome = await host.emitReceipt({ protocolId, evidenceRef: "ledger://evidence/anything" });
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.refusal.code).toBe("protocol_receipt_unavailable");
    }
    await host.issueMppChallenge({ wireChallenge: MPP_CHALLENGE });
    await host.handleInbound(x402Payment());

    // 协议面零 transport 调用、零 PSP 键仓读取（账户运行时保持懒装配）。
    expect(apiClient.calls).toEqual([]);
    expect(keyStoreReads).toEqual([]);
  });

  it("the Windows production composition (custodian-required, win32, no custodian bridge): account connect refuses fail-closed while the protocol boundary is unaffected", async () => {
    const { installation, ipcMain, apiClient } = await assembleConnections({ custodianRequired: true });
    const response = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), {
      op: "connect",
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(response.ok).toBe(true);
    if (!response.ok || response.result.kind !== "refused") throw new Error("expected a typed connect refusal");
    expect(response.result.refusal.code).toBe(PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE);

    const host = installation.runtime.protocolRuntime.protocolHost;
    await host.issueMppChallenge({ wireChallenge: MPP_CHALLENGE });
    const outcome = await host.handleInbound({
      protocolId: "mpp",
      message: { mppKind: "credential", payload: { challenge: MPP_CHALLENGE, payload: { spt: "spt_abc123" } } },
    });
    expect(outcome.kind).toBe("challenge-consumed");
    expect(apiClient.calls).toEqual([]);
  });

  it("preservation: protocol operations leave the account reader path and the connection channel unchanged", async () => {
    const { installation, ipcMain } = await assembleConnections();
    const host = installation.runtime.protocolRuntime.protocolHost;
    await host.issueMppChallenge({ wireChallenge: MPP_CHALLENGE });
    await host.handleInbound(x402Payment());

    const list = await invoke(ipcMain, mainFrameEvent(TRUSTED_URL), { op: "list" });
    expect(list).toEqual({ ok: true, op: "list", result: [] });
    const subframe = await invoke(
      ipcMain,
      { sender: { id: 7, mainFrame: { url: TRUSTED_URL } }, senderFrame: { url: TRUSTED_URL } } as unknown as IpcMainInvokeEvent,
      { op: "list" },
    );
    expect(subframe.ok).toBe(false);

    const accountRuntime = await installation.runtime.getRuntime();
    expect(await accountRuntime.accountOverviewReader()).toEqual([]);
  });
});
