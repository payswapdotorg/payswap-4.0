/**
 * PaySwap P2.2 —— 账户服务的 services 侧证明（deliverable 06 §2.2「PSP account &
 * credential management」；deliverable 05 §5 认证面的存储/撤销/清单一侧）。
 *
 * 被测对象：`createPayswapAccountService`（真实 `createCredentialService` 的 PSP
 * 键级政策 + 真实连接记录 store：原子私有写 + 跨进程文件锁 + strict schema）在
 * Stripe operator-supplied-secret 连接流上的行为：
 *
 * 1. **connect（desktop 行）**：`ZCODE_PAYSWAP_PSP_KEY` 在位 → 秘密经 PSP cipher
 *    落 `payswap:psp:stripe:<connectionId>:api-key`；连接记录（非秘密元数据）落
 *    记录 store；返回状态投影（无秘密字段）。**at-rest 检查**：记录 store 文件
 *    原文不含任何秘密材料；credentials.json 含密文不含明文。
 * 2. **connect fail-closed（§5.2 neither 行）**：无 safeStorage 键且无
 *    `ZCODE_CREDENTIAL_SECRET` → typed 拒绝（code 逐字
 *    `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`）；**拒绝先于任何触盘** ——
 *    credentials.json 与记录 store 均不存在（不是写后清理，是根本没写）。
 * 3. **connect 输入校验**：publishable key（pk_live_）→ `validation_failed`；
 *    未注册 provider → `unsupported_provider`；两者都不产生任何落盘。
 * 4. **revoke（delete-local-only）**：先标 revoked（永不留下失真的 connected），
 *    再删秘密；credentials.json 不再含该键；记录保留 revoked 状态（可审计）；
 *    幂等（重复 revoke 不抛、可补清残留秘密）；未知 connectionId →
 *    `unknown_connection`。
 * 5. **listConnections**：只回状态投影；数组序列化不含任何秘密材料。
 * 6. **补偿**：记录写失败（注入故障）→ 已存秘密被尽力删除（不留孤儿秘密）。
 * 7. **server 行**：`ZCODE_CREDENTIAL_SECRET` 在位 → connect 照常（secret 派生
 *    cipher 通道；§5.2 server 行的必需通道）。
 *
 * 法则级行（schema/模板/投影/模式推导）住 bootstrap 套件
 * `tests/payswap-account-connection.test.ts`。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
  payswapPspSecretCredentialKey,
} from "@zcode/shared/payswap";
import {
  createCredentialService,
  createPayswapAccountService,
  createPayswapConnectionRecordStore,
  setDataBaseDir,
} from "@zcode/services/node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_SECRET = `sk_test_${"a1b2c3d4".repeat(6)}`;
const LIVE_SECRET = `sk_live_${"a1b2c3d4".repeat(6)}`;
const PUBLISHABLE_KEY = `pk_live_${"a1b2c3d4".repeat(6)}`;

const createdDirs: string[] = [];

interface AccountServiceFixture {
  /** fixture 目录（credentials.json 与记录 store 都在里面）。 */
  dir: string;
  /** 凭据 store 原文（at-rest 检查；文件不存在 → null）。 */
  readRawCredentials(): Promise<Record<string, string> | null>;
  /** 连接记录 store 原文（at-rest 检查；文件不存在 → null）。 */
  readRawConnections(): Promise<string | null>;
  /** 组装账户服务（真实 credential service + 真实记录 store）。 */
  build(env: Record<string, string>): ReturnType<typeof createPayswapAccountService>;
}

async function freshFixture(): Promise<AccountServiceFixture> {
  const dir = await mkdtemp(join(tmpdir(), "payswap-p22-account-"));
  createdDirs.push(dir);
  setDataBaseDir(dir);
  const connectionsPath = join(dir, "payswap-connections.json");
  const readRawCredentials = async () => {
    try {
      const raw = await readFile(join(dir, ".zcode", "v2", "credentials.json"), "utf-8");
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return null;
    }
  };
  const readRawConnections = async () => {
    try {
      return await readFile(connectionsPath, "utf-8");
    } catch {
      return null;
    }
  };
  const build = (env: Record<string, string>) => {
    const credentialService = createCredentialService({ env });
    const connectionStore = createPayswapConnectionRecordStore({
      resolveStorePath: () => connectionsPath,
    });
    return createPayswapAccountService({ credentialPort: credentialService, connectionStore });
  };
  return { dir, readRawCredentials, readRawConnections, build };
}

afterAll(async () => {
  setDataBaseDir(null);
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("payswap account service (P2.2) — connect", () => {
  let fixture: AccountServiceFixture;

  beforeEach(async () => {
    fixture = await freshFixture();
  });

  it("desktop 行：连接成功 —— 秘密落 PSP 键、记录落 store、投影无秘密、at-rest 双检查", async () => {
    const service = fixture.build({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) });
    const result = await service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
      displayName: "Stripe (test)",
    });
    expect(result.kind).toBe("connected");
    if (result.kind !== "connected") return;
    expect(result.connection).toEqual({
      connectionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      ),
      providerId: "stripe",
      mode: "test",
      displayName: "Stripe (test)",
      status: "connected",
    });

    // at-rest 检查 1：credentials.json 有 PSP 键密文、无明文。
    const credentials = await fixture.readRawCredentials();
    const pspKey = payswapPspSecretCredentialKey("stripe", result.connection.connectionId, "api-key");
    expect(credentials?.[pspKey]).toBeDefined();
    expect(credentials?.[pspKey]).not.toContain(TEST_SECRET);
    // at-rest 检查 2：连接记录 store 原文不含任何秘密材料（非秘密元数据 store）。
    const connectionsRaw = await fixture.readRawConnections();
    expect(connectionsRaw).toContain(result.connection.connectionId);
    expect(connectionsRaw).not.toContain(TEST_SECRET);
    expect(connectionsRaw).not.toContain(pspKey);
  });

  it("模式推导进记录：sk_live_ → mode live（第二个连接、独立 connectionId）", async () => {
    const service = fixture.build({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) });
    const first = await service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    const second = await service.connect({
      providerId: "stripe",
      operatorSecret: LIVE_SECRET,
    });
    expect(first.kind).toBe("connected");
    expect(second.kind).toBe("connected");
    if (first.kind !== "connected" || second.kind !== "connected") return;
    expect(first.connection.mode).toBe("test");
    expect(second.connection.mode).toBe("live");
    expect(second.connection.connectionId).not.toBe(first.connection.connectionId);
  });

  it("fail-closed（neither 行）：typed 拒绝且拒绝先于任何触盘（两 store 均不存在）", async () => {
    const service = fixture.build({});
    const result = await service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(result).toEqual({
      kind: "refused",
      refusal: {
        code: "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
        message: expect.any(String),
      },
    });
    // 拒绝先于任何落盘：credentials.json 与记录 store 都根本不存在。
    expect(await fixture.readRawCredentials()).toBeNull();
    expect(await fixture.readRawConnections()).toBeNull();
  });

  it("输入校验：publishable key → validation_failed；未注册 provider → unsupported_provider；均不落盘", async () => {
    const service = fixture.build({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) });

    const badKey = await service.connect({
      providerId: "stripe",
      operatorSecret: PUBLISHABLE_KEY,
    });
    expect(badKey).toEqual({
      kind: "refused",
      refusal: { code: "validation_failed", message: expect.any(String) },
    });

    const unknownProvider = await service.connect({
      providerId: "not-a-psp",
      operatorSecret: TEST_SECRET,
    });
    expect(unknownProvider).toEqual({
      kind: "refused",
      refusal: { code: "unsupported_provider", message: expect.any(String) },
    });

    expect(await fixture.readRawCredentials()).toBeNull();
    expect(await fixture.readRawConnections()).toBeNull();
  });

  it("server 行：ZCODE_CREDENTIAL_SECRET 在位 → connect 照常（secret 派生通道）", async () => {
    const service = fixture.build({ ZCODE_CREDENTIAL_SECRET: "server-secret-manager-material-000" });
    const result = await service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
    });
    expect(result.kind).toBe("connected");
    const credentials = await fixture.readRawCredentials();
    expect(Object.keys(credentials ?? {}).length).toBe(1);
  });
});

describe("payswap account service (P2.2) — revoke and list", () => {
  let fixture: AccountServiceFixture;

  beforeEach(async () => {
    fixture = await freshFixture();
  });

  async function connectOne(
    service: ReturnType<typeof createPayswapAccountService>,
  ): Promise<string> {
    const result = await service.connect({
      providerId: "stripe",
      operatorSecret: TEST_SECRET,
      displayName: "Stripe (test)",
    });
    if (result.kind !== "connected") throw new Error(`connect failed: ${result.kind}`);
    return result.connection.connectionId;
  }

  it("revoke：先标 revoked 再删秘密；幂等；未知 id → unknown_connection", async () => {
    const service = fixture.build({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) });
    const connectionId = await connectOne(service);
    const pspKey = payswapPspSecretCredentialKey("stripe", connectionId, "api-key");
    expect((await fixture.readRawCredentials())?.[pspKey]).toBeDefined();

    const revoked = await service.revoke({ connectionId });
    expect(revoked).toEqual({
      kind: "revoked",
      connection: {
        connectionId,
        providerId: "stripe",
        mode: "test",
        displayName: "Stripe (test)",
        status: "revoked",
      },
    });
    // 秘密已从凭据 store 删除；记录保留 revoked（可审计）。
    expect((await fixture.readRawCredentials())?.[pspKey]).toBeUndefined();
    const connectionsRaw = await fixture.readRawConnections();
    expect(connectionsRaw).toContain('"status": "revoked"');

    // 幂等：重复 revoke 不抛、同投影。
    const again = await service.revoke({ connectionId });
    expect(again).toEqual(revoked);

    const unknown = await service.revoke({ connectionId: "00000000-0000-4000-8000-000000000000" });
    expect(unknown).toEqual({
      kind: "refused",
      refusal: { code: "unknown_connection", message: expect.any(String) },
    });
  });

  it("listConnections：只回状态投影；序列化不含任何秘密材料", async () => {
    const service = fixture.build({ [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) });
    await connectOne(service);
    const second = await service.connect({
      providerId: "stripe",
      operatorSecret: LIVE_SECRET,
      displayName: "Stripe (live)",
    });
    expect(second.kind).toBe("connected");

    const connections = await service.listConnections();
    expect(connections).toHaveLength(2);
    const serialized = JSON.stringify(connections);
    expect(serialized).not.toContain(TEST_SECRET);
    expect(serialized).not.toContain(LIVE_SECRET);
    expect(serialized).not.toContain("payswap:psp:");
    for (const connection of connections) {
      expect(Object.keys(connection).sort()).toEqual(
        ["connectionId", "displayName", "mode", "providerId", "status"].sort(),
      );
    }
  });
});

describe("payswap account service (P2.2) — write-failure compensation", () => {
  it("记录写失败 → 已存秘密被尽力删除（不留孤儿秘密）", async () => {
    const fixture = await freshFixture();
    const credentialService = createCredentialService({
      env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) },
    });
    const realStore = createPayswapConnectionRecordStore({
      resolveStorePath: () => join(fixture.dir, "payswap-connections.json"),
    });
    const failingStore = {
      ...realStore,
      upsert: async () => {
        throw new Error("injected disk-full");
      },
    };
    const service = createPayswapAccountService({
      credentialPort: credentialService,
      connectionStore: failingStore,
    });

    await expect(
      service.connect({ providerId: "stripe", operatorSecret: TEST_SECRET }),
    ).rejects.toThrow("injected disk-full");

    // 补偿：秘密没有留在凭据 store（孤儿秘密 = 无记录的 PSP 密文）。
    const credentials = await fixture.readRawCredentials();
    expect(Object.keys(credentials ?? {}).length).toBe(0);
  });
});
