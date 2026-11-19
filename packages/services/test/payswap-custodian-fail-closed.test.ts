/**
 * ADR-P2-3 fail-closed custodian 装配（A3 法则）的 services 侧证明。
 *
 * 被测法则（runtime.ts credentialCustody 法则 + accountService revoke 臂）：
 * 1. **custodian-required + 托管缺席 = typed 拒绝，绝不 legacy 回退**：connect
 *    以 `custodian_unavailable` 拒绝；数据目录不出现任何 enc:v1 凭据痕迹
 *   （结构保证 —— refusing port 无 legacy 写路径可触达）。
 * 2. **custodian-required + 桥在位 = 密钥只入托管**：save = push（桥收到操作员
 *    秘密）；读面经标记路由 transport（桥收到允许的 GET 路径）；revoke = drop；
 *    数据目录同样零 enc:v1 痕迹。
 * 3. **撤销诚实性**：drop 失败 → revoke = typed `custodian_unavailable` 拒绝，
 *    记录已是 revoked（法则 4 先标后删）—— 绝不把未证实的清除伪装成成功。
 * 4. **delete-only legacy 通道**：refusing port 的 delete 转发调用方注入的删除
 *    （撤销清理 + 策略前残留清理），load/save 永不触达。
 * 5. **legacy 政策 = 既有行为不变**（缺省装配照常写 legacy 凭据 store）。
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustodianRequiredRefusingCredentialPort,
  createPayswapAccountRuntime,
  createPayswapCustodianUnavailableError,
  setDataBaseDir,
} from "@zcode/services/node";
import type { PayswapCustodianBridge } from "@zcode/services/node";
import { afterAll, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"a1b2c3d4".repeat(6)}`;

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "payswap-custodian-fc-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  return dir;
}

/** 递归扫描目录内任一文件是否含 enc:v1 —— 「无 legacy 凭据痕迹」的证据面。 */
async function dirContainsEncV1(dir: string): Promise<boolean> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const p = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      try {
        const content = await readFile(p, "utf8");
        if (content.includes("enc:v1")) return true;
      } catch {
        // 二进制/不可读文件跳过（enc:v1 凭据文件是 JSON 文本）
      }
    }
  }
  return false;
}

interface RecordingBridge extends PayswapCustodianBridge {
  pushedKeys: string[];
  fetchedPaths: string[];
  dropped: number;
  failPushWith: Error | null;
  failDropWith: Error | null;
}

function recordingBridge(): RecordingBridge {
  const bridge: RecordingBridge = {
    pushedKeys: [],
    fetchedPaths: [],
    dropped: 0,
    failPushWith: null,
    failDropWith: null,
    async push(key: string) {
      if (bridge.failPushWith !== null) throw bridge.failPushWith;
      bridge.pushedKeys.push(key);
    },
    async get(path: string) {
      bridge.fetchedPaths.push(path);
      if (path.startsWith("/v1/account")) {
        return {
          status: 200,
          body: JSON.stringify({
            id: "acct_1QxCustodian",
            object: "account",
            capabilities: { card_payments: "active" },
            requirements: { currently_due: [], past_due: [], disabled_reason: null },
          }),
        };
      }
      if (path.startsWith("/v1/balance")) {
        return {
          status: 200,
          body: JSON.stringify({ object: "balance", available: [], pending: [] }),
        };
      }
      return { status: 200, body: JSON.stringify({ object: "list", data: [] }) };
    },
    async drop() {
      if (bridge.failDropWith !== null) throw bridge.failDropWith;
      bridge.dropped += 1;
    },
  };
  return bridge;
}

describe("ADR-P2-3 custodian-required fail-closed assembly (A3)", () => {
  it("connect refuses typed custodian_unavailable when the custodian is absent and writes NO legacy credential trace", async () => {
    const dir = await makeDataDir();
    const runtime = createPayswapAccountRuntime({
      env: {},
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      credentialCustody: "custodian-required",
    });
    const outcome = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("custodian_unavailable");
    }
    // A3.5 法则证据：secured 路径上托管缺席也绝不产生 enc:v1 槽。
    expect(await dirContainsEncV1(dir)).toBe(false);
    // 拒绝先于记录：连接清单为空。
    expect(await runtime.accountService.listConnections()).toEqual([]);
  });

  it("with a bridge, the operator secret goes only to the custodian and reads route through the marker transport", async () => {
    const dir = await makeDataDir();
    const bridge = recordingBridge();
    const runtime = createPayswapAccountRuntime({
      env: {},
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      custodianBridge: bridge,
      credentialCustody: "custodian-required",
    });
    const outcome = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(outcome.kind).toBe("connected");
    expect(bridge.pushedKeys).toEqual([TEST_SECRET]);
    // A3.5 法则证据：custodian 在位时 main 不持明文、不落 enc:v1 槽。
    expect(await dirContainsEncV1(dir)).toBe(false);
    const connections = await runtime.accountService.listConnections();
    expect(connections).toHaveLength(1);
    const connectionId = connections[0]!.connectionId;
    // 读面：标记路由 transport 把允许的 GET 路径交给桥（代理应答重铸 Response）。
    const detail = await runtime.accountService.getOverviewData({ connectionId });
    expect(bridge.fetchedPaths.length).toBeGreaterThan(0);
    expect(bridge.fetchedPaths.every((p) => p.startsWith("/v1/"))).toBe(true);
    expect(detail.kind).not.toBe("refused");
    // revoke：托管清除走 drop。
    const revoked = await runtime.accountService.revoke({ connectionId });
    expect(revoked.kind).toBe("revoked");
    expect(bridge.dropped).toBe(1);
  });

  it("an unconfirmed custody drop makes revoke refuse with custodian_unavailable while the record is already revoked", async () => {
    const dir = await makeDataDir();
    const bridge = recordingBridge();
    const runtime = createPayswapAccountRuntime({
      env: {},
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      custodianBridge: bridge,
      credentialCustody: "custodian-required",
    });
    const connected = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    if (connected.kind !== "connected") throw new Error("connect must succeed in this battery");
    const connectionId = connected.connection.connectionId;
    bridge.failDropWith = createPayswapCustodianUnavailableError(
      "custodian blob deletion could not be verified",
    );
    const revoked = await runtime.accountService.revoke({ connectionId });
    expect(revoked.kind).toBe("refused");
    if (revoked.kind === "refused") {
      expect(revoked.refusal.code).toBe("custodian_unavailable");
    }
    // 法则 4：记录先标 revoked —— 中间态绝无失真 connected；但结果诚实为拒绝。
    const rows = await runtime.accountService.listConnections();
    expect(rows[0]!.status).toBe("revoked");
    // 幂等重撤销在 drop 恢复后补清。
    bridge.failDropWith = null;
    const retried = await runtime.accountService.revoke({ connectionId });
    expect(retried.kind).toBe("revoked");
    expect(bridge.dropped).toBe(1);
  });

  it("a push failure at connect surfaces as a typed refusal and leaves no connection row", async () => {
    const dir = await makeDataDir();
    const bridge = recordingBridge();
    bridge.failPushWith = createPayswapCustodianUnavailableError(
      "custodian push was not confirmed by the service (ok:false)",
    );
    const runtime = createPayswapAccountRuntime({
      env: {},
      resolveStorePath: () => join(dir, "payswap-connections.json"),
      custodianBridge: bridge,
      credentialCustody: "custodian-required",
    });
    const outcome = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).toBe("custodian_unavailable");
    }
    expect(await runtime.accountService.listConnections()).toEqual([]);
    expect(await dirContainsEncV1(dir)).toBe(false);
  });
});

describe("custodian-required refusing credential port (A3 unit)", () => {
  it("load and save always refuse typed; delete forwards to the injected delete-only channel", async () => {
    const deletedKeys: string[] = [];
    const port = createCustodianRequiredRefusingCredentialPort({
      deleteOnlyDelete: async (key) => {
        deletedKeys.push(key);
      },
    });
    await expect(port.load("payswap:psp:stripe:conn:key")).rejects.toMatchObject({
      code: "custodian_unavailable",
    });
    await expect(port.save("payswap:psp:stripe:conn:key", TEST_SECRET)).rejects.toMatchObject({
      code: "custodian_unavailable",
    });
    await port.delete("payswap:psp:stripe:conn:key");
    expect(deletedKeys).toEqual(["payswap:psp:stripe:conn:key"]);
  });
});

describe("legacy custody policy remains the default behavior", () => {
  it("default assembly without a bridge and without env key = legacy Gate E2 typed refusal (unchanged)", async () => {
    const dir = await makeDataDir();
    const runtime = createPayswapAccountRuntime({
      env: {},
      resolveStorePath: () => join(dir, "payswap-connections.json"),
    });
    const outcome = await runtime.accountService.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    // legacy 政策的 fail-closed 在操作面（Gate E2 secure-storage 词汇），不是
    // custodian 词汇 —— 两类失败绝不混同（连接 UI 按 code 分流）。
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.refusal.code).not.toBe("custodian_unavailable");
    }
  });
});
