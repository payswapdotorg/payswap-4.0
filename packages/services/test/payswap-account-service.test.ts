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
  type PayswapAccountReadBackInput,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
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

describe("payswap account service (P2.2 slice 2) — refreshEvidence (provider read-back)", () => {
  /**
   * 读回半法则的 services 侧证明（doc 05 §5「final authority is provider
   * read-back」+ §6.4 unknown 结局纪律 + doc 06 §2.2 refreshEvidence）：
   *
   * 1. **verified**：connected 保持（无记录写 —— 状态变更才写）；expired →
   *    connected 恢复行（provider 证据翻回）。端口收到法则形输入（含秘密）。
   * 2. **auth-failed**：connected → expired（唯一的 expiry 证据是 provider 的
   *    拒绝）；已 expired 再 auth-failed → 状态不变（无写）。
   * 3. **unavailable / 传输异常 / 畸形结局**：typed `read_back_unavailable`
   *    拒绝，状态不变（unknown ≠ expired）。
   * 4. **revoked 终态**：不触端口、不读秘密，直回 revoked 投影。
   * 5. **存储 fail-closed / 秘密缺失 / 端口缺席**：typed 拒绝，状态不变。
   * 6. **秘密永不外泄**：端口输入带秘密；全部结果序列化不含秘密材料。
   */

  interface ScriptedPort {
    readBackAccount: PayswapAccountReadBackPort;
    calls: PayswapAccountReadBackInput[];
  }

  /** 脚本化读回端口：记录每次调用，按序回放结局。 */
  function scriptedPort(...outcomes: (PayswapAccountReadBackOutcome | Error)[]): ScriptedPort {
    const calls: PayswapAccountReadBackInput[] = [];
    let cursor = 0;
    return {
      calls,
      readBackAccount: async (input) => {
        calls.push(input);
        const outcome = outcomes[cursor];
        cursor += 1;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
  }

  interface RefreshFixture {
    dir: string;
    readRawConnections(): Promise<string | null>;
    build(
      env: Record<string, string>,
      readBackAccount?: PayswapAccountReadBackPort,
    ): ReturnType<typeof createPayswapAccountService>;
    buildWithCredentialService(
      env: Record<string, string>,
      readBackAccount?: PayswapAccountReadBackPort,
    ): {
      service: ReturnType<typeof createPayswapAccountService>;
      credentialService: ReturnType<typeof createCredentialService>;
    };
  }

  async function freshRefreshFixture(): Promise<RefreshFixture> {
    const dir = await mkdtemp(join(tmpdir(), "payswap-p22-refresh-"));
    createdDirs.push(dir);
    setDataBaseDir(dir);
    const connectionsPath = join(dir, "payswap-connections.json");
    const readRawConnections = async () => {
      try {
        return await readFile(connectionsPath, "utf-8");
      } catch {
        return null;
      }
    };
    const assemble = (env: Record<string, string>, readBackAccount?: PayswapAccountReadBackPort) => {
      const credentialService = createCredentialService({ env });
      const connectionStore = createPayswapConnectionRecordStore({
        resolveStorePath: () => connectionsPath,
      });
      const service = createPayswapAccountService({
        credentialPort: credentialService,
        connectionStore,
        ...(readBackAccount ? { readBackAccount } : {}),
      });
      return { credentialService, connectionStore, service };
    };
    return {
      dir,
      readRawConnections,
      build: (env, readBackAccount) => assemble(env, readBackAccount).service,
      buildWithCredentialService: (env, readBackAccount) => {
        const { credentialService, service } = assemble(env, readBackAccount);
        return { credentialService, service };
      },
    };
  }

  const DESKTOP_ENV = { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "b".repeat(64) } as const;

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

  it("verified on connected：端口收到法则形输入（含秘密）；结果 verified + providerAccountId；状态保持且无记录写（字节不变）", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort({ kind: "verified", providerAccountId: "acct_1A2b3C" });
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);
    const before = await fixture.readRawConnections();

    const result = await service.refreshEvidence({ connectionId });

    // 端口收到恰一次法则形调用：五字段输入（providerId/mode/secretKind/secret）。
    expect(port.calls).toEqual([
      { providerId: "stripe", mode: "test", secretKind: "api-key", secret: TEST_SECRET },
    ]);
    expect(result).toEqual({
      kind: "verified",
      providerAccountId: "acct_1A2b3C",
      connection: {
        connectionId,
        providerId: "stripe",
        mode: "test",
        displayName: "Stripe (test)",
        status: "connected",
      },
    });
    // 状态变更才写：connected 保持 → 记录 store 字节不变。
    expect(await fixture.readRawConnections()).toBe(before);
    // 秘密进端口、永不进结果。
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
    expect(JSON.stringify(result)).not.toContain("payswap:psp:");
  });

  it("auth-failed on connected → expired：记录翻 expired；结果 expired 投影；listConnections 同步", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort({ kind: "auth-failed", detail: "invalid_api_key" });
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "expired",
      connection: {
        connectionId,
        providerId: "stripe",
        mode: "test",
        displayName: "Stripe (test)",
        status: "expired",
      },
    });
    const raw = await fixture.readRawConnections();
    expect(raw).toContain('"status": "expired"');
    expect(JSON.stringify(result)).not.toContain(TEST_SECRET);
    const listed = await service.listConnections();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("expired");
  });

  it("verified on expired → connected 恢复行：provider 证据把 expired 翻回 connected", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort(
      { kind: "auth-failed", detail: "key rolled" },
      { kind: "verified", providerAccountId: "acct_1A2b3C" },
    );
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);

    const first = await service.refreshEvidence({ connectionId });
    expect(first.kind).toBe("expired");
    const second = await service.refreshEvidence({ connectionId });

    expect(second).toEqual({
      kind: "verified",
      providerAccountId: "acct_1A2b3C",
      connection: {
        connectionId,
        providerId: "stripe",
        mode: "test",
        displayName: "Stripe (test)",
        status: "connected",
      },
    });
    const raw = await fixture.readRawConnections();
    expect(raw).toContain('"status": "connected"');
    expect(port.calls).toHaveLength(2);
  });

  it("auth-failed on already-expired：状态不变（记录字节不变），结果 expired", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort(
      { kind: "auth-failed", detail: "invalid_api_key" },
      { kind: "auth-failed", detail: "still invalid" },
    );
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);
    await service.refreshEvidence({ connectionId });
    const before = await fixture.readRawConnections();

    const again = await service.refreshEvidence({ connectionId });

    expect(again.kind).toBe("expired");
    if (again.kind !== "expired") return;
    expect(again.connection.status).toBe("expired");
    expect(await fixture.readRawConnections()).toBe(before);
  });

  it("unavailable → typed read_back_unavailable 拒绝；状态不变（unknown ≠ expired）", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort({ kind: "unavailable", detail: "api.stripe.com unreachable" });
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);
    const before = await fixture.readRawConnections();

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "refused",
      refusal: { code: "read_back_unavailable", message: expect.any(String) },
    });
    expect(await fixture.readRawConnections()).toBe(before);
  });

  it("端口传输异常（ECONNRESET）→ typed read_back_unavailable；状态不变", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort(new Error("fetch failed: ECONNRESET"));
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);
    const before = await fixture.readRawConnections();

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "refused",
      refusal: { code: "read_back_unavailable", message: expect.any(String) },
    });
    expect(await fixture.readRawConnections()).toBe(before);
  });

  it("端口畸形结局（未知 kind）→ fail-closed typed 拒绝；状态不变", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort({ kind: "definitely-not-an-outcome" });
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);
    const before = await fixture.readRawConnections();

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "refused",
      refusal: { code: "read_back_unavailable", message: expect.any(String) },
    });
    expect(await fixture.readRawConnections()).toBe(before);
  });

  it("revoked 终态：不触端口、不读秘密；直回 revoked 投影", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort();
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(service);
    await service.revoke({ connectionId });

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "revoked",
      connection: {
        connectionId,
        providerId: "stripe",
        mode: "test",
        displayName: "Stripe (test)",
        status: "revoked",
      },
    });
    expect(port.calls).toHaveLength(0);
  });

  it("未知 connectionId → unknown_connection 拒绝", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort();
    const service = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);

    const result = await service.refreshEvidence({
      connectionId: "00000000-0000-4000-8000-000000000000",
    });

    expect(result).toEqual({
      kind: "refused",
      refusal: { code: "unknown_connection", message: expect.any(String) },
    });
    expect(port.calls).toHaveLength(0);
  });

  it("存储 fail-closed（neither 行）：load 拒绝 → typed PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE；状态不变；不触端口", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort({ kind: "verified", providerAccountId: "acct_1A2b3C" });
    // 连接时通道在位；refresh 时重建为 neither env（同一数据目录）。
    const seeded = fixture.build({ ...DESKTOP_ENV }, port.readBackAccount);
    const connectionId = await connectOne(seeded);
    const before = await fixture.readRawConnections();
    const degraded = fixture.build({}, port.readBackAccount);

    const result = await degraded.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "refused",
      refusal: {
        code: "PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE",
        message: expect.any(String),
      },
    });
    expect(await fixture.readRawConnections()).toBe(before);
    expect(port.calls).toHaveLength(0);
  });

  it("秘密缺失（out-of-band 删除）：typed read_back_unavailable；状态不变；不触端口", async () => {
    const fixture = await freshRefreshFixture();
    const port = scriptedPort({ kind: "verified", providerAccountId: "acct_1A2b3C" });
    const { service, credentialService } = fixture.buildWithCredentialService(
      { ...DESKTOP_ENV },
      port.readBackAccount,
    );
    const connectionId = await connectOne(service);
    await credentialService.delete(
      payswapPspSecretCredentialKey("stripe", connectionId, "api-key"),
    );
    const before = await fixture.readRawConnections();

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "refused",
      refusal: { code: "read_back_unavailable", message: expect.any(String) },
    });
    expect(await fixture.readRawConnections()).toBe(before);
    expect(port.calls).toHaveLength(0);
  });

  it("端口缺席（无 provider 读回 adapter）→ typed read_back_unavailable；不炸", async () => {
    const fixture = await freshRefreshFixture();
    const service = fixture.build({ ...DESKTOP_ENV });
    const connectionId = await connectOne(service);
    const before = await fixture.readRawConnections();

    const result = await service.refreshEvidence({ connectionId });

    expect(result).toEqual({
      kind: "refused",
      refusal: { code: "read_back_unavailable", message: expect.any(String) },
    });
    expect(await fixture.readRawConnections()).toBe(before);
  });
});
