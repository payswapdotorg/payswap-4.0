import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import type { McpServerConfig, McpStdioServerConfig } from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY, ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY } from "@zcode/shared";
import {
  buildZCodeToolEnvPassthroughEnv,
  getCapturedPayswapBrokerCredentials,
  readCapturedPayswapBrokerCredentials,
  readZCodeToolEnvPassthroughEnv,
  resetCapturedPayswapBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnvInPlace,
  shouldCaptureZCodeToolEnvPassthroughKey,
} from "@zcode/shared";
import {
  canonicalJsonStringify,
  createPayswapInstanceRegistry,
  exportPublicKeyBase64,
  mintBrokerBootState,
  parsePublicKeyBase64,
  PAYSWAP_BROKER_ENV_KEYS,
  PAYSWAP_BROKER_HOST_ID_ENV_KEY,
  PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY,
  PAYSWAP_BROKER_SOCKET_ENV_KEY,
  PAYSWAP_BROKER_TOKEN_ENV_KEY,
  PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  requestLineDigest,
  signResponseEnvelope,
  verifyResponseEnvelope,
  type PayswapBrokerCredentialTuple,
  type PayswapBrokerEnvelope,
  type PayswapBrokerOp,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import { describe, expect, it } from "vitest";
import { injectPayswapBrokerMcpServers, resolveTrustedOfficialPayswapServerNames } from "../src/mcp-config.js";

/**
 * PaySwap P1.2 Step 2 —— 五键凭据组 / Ed25519 启动签名 / 实例注册表 / 受信注入
 * 的对抗性测试（契约 w2-01 §4、§6.4、§6.5、§10、§12.1；ADR-1；playbook §4.2 RED-first）。
 *
 * 纪律（§6.5(6)，binding）：本文件的对抗行先于实现代码落盘（RED），实现提交（GREEN）
 * 必须逐行转绿；伪造 / 篡改 / 重放 / 跨实例 / 跨 host-boot / 未签名 / 超限 —— 每一行
 * 单独成行，失败原因机器可读且互不相同。
 *
 * 测试对象的家（§6.4(5)）：`packages/shared/src/payswap/` 是 canonical JSON、信封签名/
 * 验签的唯一共享实现 —— host 与 child 用同一份代码，两份实现漂移即违约。
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const BOOT_OBJECT = mintBrokerBootState();

function mintTuple(overrides: Partial<PayswapBrokerCredentialTuple> = {}): PayswapBrokerCredentialTuple {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    socket: `/tmp/payswap-broker-${randomBytes(8).toString("hex")}/broker.sock`,
    token: randomBytes(32).toString("hex"),
    instanceId: randomUUID(),
    hostId: randomUUID(),
    verifyKeyBase64: exportPublicKeyBase64(publicKey),
    ...overrides,
  };
}

function tupleAsEnv(tuple: PayswapBrokerCredentialTuple): Record<string, string> {
  return {
    [PAYSWAP_BROKER_SOCKET_ENV_KEY]: tuple.socket,
    [PAYSWAP_BROKER_TOKEN_ENV_KEY]: tuple.token,
    [PAYSWAP_BROKER_INSTANCE_ID_ENV_KEY]: tuple.instanceId,
    [PAYSWAP_BROKER_HOST_ID_ENV_KEY]: tuple.hostId,
    [PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY]: tuple.verifyKeyBase64,
  };
}

function makeAttempt(seq = 1, op: PayswapBrokerOp = "compile_intent") {
  const instanceId = randomUUID();
  const request = {
    instanceId,
    seq,
    op,
    params: { description: "pay invoice INV-1", amount: 1200, currency: "USD" },
    token: randomBytes(32).toString("hex"),
    sessionId: "session-1",
  };
  return { instanceId, seq, op, sentLine: JSON.stringify(request) };
}

type Attempt = ReturnType<typeof makeAttempt>;

function childMaterial(boot = BOOT_OBJECT): { hostId: string; verifyKeyBase64: string } {
  return { hostId: boot.hostId, verifyKeyBase64: exportPublicKeyBase64(boot.keyPair.publicKey) };
}

function signForAttempt(
  attempt: Attempt,
  boot = BOOT_OBJECT,
  response: { ok: true; seq: number; data: unknown } | {
    ok: false;
    seq: number;
    error: { code: string; message: string; retryable: boolean };
  } = { ok: true, seq: attempt.seq, data: { kind: "ok", data: { answer: 42 } } },
) {
  return signResponseEnvelope(
    {
      instanceId: attempt.instanceId,
      seq: attempt.seq,
      op: attempt.op,
      requestDigest: requestLineDigest(attempt.sentLine),
      response,
    },
    boot.keyPair.privateKey,
    boot.hostId,
  );
}

/** 用真实私钥手工签署任意信封（模拟持有签名钥但违反绑定字段的 host/攻击者）。 */
function forgeSignedLine(envelope: PayswapBrokerEnvelope, privateKey: KeyObject): string {
  const signature = sign(null, Buffer.from(canonicalJsonStringify(envelope), "utf8"), privateKey).toString("base64");
  return JSON.stringify({ envelope, signature });
}

function validEnvelopeFor(attempt: Attempt, boot = BOOT_OBJECT): PayswapBrokerEnvelope {
  return {
    v: 1,
    hostInstanceId: boot.hostId,
    instanceId: attempt.instanceId,
    seq: attempt.seq,
    op: attempt.op,
    requestDigest: requestLineDigest(attempt.sentLine),
    response: { ok: true, seq: attempt.seq, data: { kind: "ok", data: { answer: 42 } } },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 确定性 LCG（属性测试可复现）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// canonical JSON（RFC 8785 / JCS，契约 §6.4(5)）
// ---------------------------------------------------------------------------

describe("payswap canonical JSON (RFC 8785 / JCS, contract §6.4(5))", () => {
  it("sorts object keys recursively in UTF-16 code-unit order", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonStringify({ z: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] })).toBe(
      '{"a":[{"x":2,"y":1}],"z":{"c":2,"d":1}}',
    );
    // UTF-16 码元序：ü (U+00FC) 排在 € (U+20AC) 之前。
    expect(canonicalJsonStringify({ "€": 1, "ü": 2 })).toBe('{"ü":2,"€":1}');
    // 键序不同的同值对象 → 同一 canonical 形式（host/child 双侧一致性的根基）。
    expect(canonicalJsonStringify({ x: 1, y: 2 })).toBe(canonicalJsonStringify({ y: 2, x: 1 }));
  });

  it("serializes numbers per ECMAScript JSON semantics and strings per JCS escaping", () => {
    expect(canonicalJsonStringify({ a: 1, b: -0, c: 1e21, d: 0.5 })).toBe('{"a":1,"b":0,"c":1e+21,"d":0.5}');
    expect(canonicalJsonStringify("a\"b\\c\nd\u0001e")).toBe('"a\\"b\\\\c\\nd\\u0001e"');
    expect(canonicalJsonStringify([null, true, false])).toBe("[null,true,false]");
    expect(canonicalJsonStringify({})).toBe("{}");
    expect(canonicalJsonStringify([])).toBe("[]");
  });

  it("is round-trip stable: canonical(parse(canonical(x))) === canonical(x) over generated envelopes and nested params", () => {
    const rand = lcg(0x5eed);
    const ops: PayswapBrokerOp[] = [
      "compile_intent",
      "check_eligibility",
      "discover_routes",
      "request_authorization",
      "get_execution_status",
      "get_account_overview",
    ];
    const randomString = () => {
      const alphabet = ["a", "Z", "0", "é", "ü", "€", "𝕏", "\n", "\"", "\\", " ", "\u0001"];
      let out = "";
      const length = Math.floor(rand() * 12);
      for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
      return out;
    };
    const randomValue = (depth: number): unknown => {
      const pick = Math.floor(rand() * 8);
      if (pick === 0) return null;
      if (pick === 1) return rand() > 0.5;
      if (pick === 2) return Math.floor(rand() * 1e6);
      if (pick === 3) return rand();
      if (pick === 4) return randomString();
      if (pick === 5 && depth < 3) {
        const length = Math.floor(rand() * 4);
        const items: unknown[] = [];
        for (let i = 0; i < length; i++) items.push(randomValue(depth + 1));
        return items;
      }
      // 对象：故意用乱序键注入。GREEN 侧 harness 修正（实现无关）：原对象分支无 depth
      // 上限，分支过程超临界（每个对象节点平均 3 个子值 × 3/8 再入对象 ≈ 1.125 > 1），
      // LCG 种子 0x5eed 下第 9 次迭代必然栈溢出 —— 生成器自身不终止，任何实现都无法
      // 转绿。与数组分支同为 depth < 3 封顶后，性质断言（300 信封、乱序嵌套键、往返
      // 稳定）保持不变。
      if (depth >= 3) return randomString();
      const length = Math.floor(rand() * 5) + 1;
      const record: Record<string, unknown> = {};
      for (let i = 0; i < length; i++) record[randomString() + i] = randomValue(depth + 1);
      return record;
    };

    for (let iteration = 0; iteration < 300; iteration++) {
      const envelope = {
        v: 1,
        hostInstanceId: randomUUID(),
        instanceId: rand() > 0.3 ? randomUUID() : null,
        seq: rand() > 0.3 ? Math.floor(rand() * 1000) + 1 : null,
        op: rand() > 0.3 ? ops[Math.floor(rand() * ops.length)] : null,
        requestDigest: randomBytes(32).toString("hex"),
        response:
          rand() > 0.5
            ? { ok: true, seq: Math.floor(rand() * 1000) + 1, data: randomValue(0) }
            : {
                ok: false,
                seq: Math.floor(rand() * 1000) + 1,
                error: {
                  code: ["unauthorized", "request_invalid", "internal_error"][Math.floor(rand() * 3)],
                  message: randomString() || "m",
                  retryable: rand() > 0.5,
                },
              },
      };
      const canonical = canonicalJsonStringify(envelope);
      expect(canonicalJsonStringify(JSON.parse(canonical))).toBe(canonical);
    }
  });

  it("rejects non-finite numbers, undefined, BigInt, symbols, and functions", () => {
    expect(() => canonicalJsonStringify(Infinity)).toThrow();
    expect(() => canonicalJsonStringify(-Infinity)).toThrow();
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow();
    expect(() => canonicalJsonStringify(undefined)).toThrow();
    expect(() => canonicalJsonStringify(BigInt(1))).toThrow();
    expect(() => canonicalJsonStringify(Symbol("x"))).toThrow();
    expect(() => canonicalJsonStringify(() => {})).toThrow();
    expect(() => canonicalJsonStringify({ a: undefined })).toThrow();
    expect(() => canonicalJsonStringify([1, undefined, 2])).toThrow();
    expect(() => canonicalJsonStringify({ nested: { deep: [Number.POSITIVE_INFINITY] } })).toThrow();
    // 非 JSON 类型（Date 等类实例）无法确定性序列化 —— 拒绝（JCS 输入是 I-JSON）。
    expect(() => canonicalJsonStringify({ at: new Date(0) })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// host-boot identity（§6.5(1)、ADR-1）
// ---------------------------------------------------------------------------

describe("payswap broker boot identity (contract §6.5(1), ADR-1)", () => {
  it("mints a per-boot state: UUID v4 host id, Ed25519 key pair, mkdtemp-style private endpoint path", () => {
    const boot = mintBrokerBootState();
    expect(boot.hostId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(boot.keyPair.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(boot.keyPair.publicKey.asymmetricKeyType).toBe("ed25519");
    // §3.4：per-boot 路径不可预测（mkdtemp 式私有目录模式下的 socket 路径，本步只铸路径）。
    expect(boot.endpointPath).toContain("payswap-broker-");
    expect(boot.endpointPath.length).toBeLessThan(108);
  });

  it("exports and parses the raw 32-byte RFC 8032 public key (base64 round-trip)", () => {
    const base64 = exportPublicKeyBase64(BOOT_OBJECT.keyPair.publicKey);
    expect(Buffer.from(base64, "base64")).toHaveLength(32);
    const parsed = parsePublicKeyBase64(base64);
    expect(parsed.asymmetricKeyType).toBe("ed25519");
    expect(exportPublicKeyBase64(parsed)).toBe(base64);
    expect(() => parsePublicKeyBase64(Buffer.from("too-short", "utf8").toString("base64"))).toThrow();
  });

  it("mints a fresh key, id, and path per boot (rotation every boot, ADR-1)", () => {
    const other = mintBrokerBootState();
    expect(other.hostId).not.toBe(BOOT_OBJECT.hostId);
    expect(other.endpointPath).not.toBe(BOOT_OBJECT.endpointPath);
    expect(exportPublicKeyBase64(other.keyPair.publicKey)).not.toBe(
      exportPublicKeyBase64(BOOT_OBJECT.keyPair.publicKey),
    );
  });
});

// ---------------------------------------------------------------------------
// sign/verify 模块（§6.4/§6.5 —— 对抗核心，§6.5(4) 每行必测）
// ---------------------------------------------------------------------------

describe("payswap signed response envelope (contract §6.4/§6.5, adversarial rows)", () => {
  it("happy path: host signs, child verifies, body returned (§6.5(3) all pass)", () => {
    const attempt = makeAttempt();
    const signed = signForAttempt(attempt);
    const result = verifyResponseEnvelope(
      JSON.stringify(signed),
      attempt,
      childMaterial(),
    );
    expect(result).toEqual({ ok: true, body: signed.envelope.response });
  });

  it("fabricated: signed by a different (attacker) key pair → rejected", () => {
    const attempt = makeAttempt();
    const attacker = mintBrokerBootState();
    const forged = signForAttempt(attempt, attacker); // 攻击者用自己的 boot key 签
    const result = verifyResponseEnvelope(JSON.stringify(forged), attempt, childMaterial());
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("modified post-signing: every envelope field mutation and signature-byte mutation → rejected", () => {
    const attempt = makeAttempt();
    const line = JSON.stringify(signForAttempt(attempt));
    const mutations: Array<[string, (envelope: Record<string, unknown>, signed: Record<string, unknown>) => void]> = [
      ["hostInstanceId", (envelope) => { envelope.hostInstanceId = randomUUID(); }],
      ["instanceId", (envelope) => { envelope.instanceId = randomUUID(); }],
      ["seq", (envelope) => { envelope.seq = (envelope.seq as number) + 1; }],
      ["op", (envelope) => { envelope.op = "discover_routes"; }],
      ["requestDigest", (envelope) => { envelope.requestDigest = "0".repeat(64); }],
      ["response body", (envelope) => { envelope.response = { ok: true, seq: attempt.seq, data: { tampered: true } }; }],
      ["response inner seq", (envelope) => {
        const response = envelope.response as { ok: true; seq: number; data: unknown };
        response.seq = attempt.seq + 1;
      }],
      ["signature bytes", (_envelope, signed) => {
        signed.signature = Buffer.from("attacker-forged-signature", "utf8").toString("base64");
      }],
    ];
    for (const [label, mutate] of mutations) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const envelope = parsed.envelope as Record<string, unknown>;
      mutate(envelope, parsed);
      const result = verifyResponseEnvelope(JSON.stringify(parsed), attempt, childMaterial());
      // 签名覆盖整个 canonical 信封：任何篡改都先死在 (a) 签名验证（§6.5(4) 第 2 行）。
      expect(result, `mutation: ${label}`).toEqual({ ok: false, reason: "signature_invalid" });
    }
  });

  it("replayed against a different in-flight attempt (same key, valid signature) → rejected", () => {
    const attempt = makeAttempt(7, "compile_intent");
    const line = JSON.stringify(signForAttempt(attempt));
    // 同一实例内另一个 in-flight attempt：seq / op / 发送字节任一不同都必须拒绝。
    const differentSeq = { ...attempt, seq: 8 };
    expect(verifyResponseEnvelope(line, differentSeq, childMaterial())).toEqual({
      ok: false,
      reason: "sequence_mismatch",
    });
    const differentOp = { ...attempt, op: "discover_routes" as PayswapBrokerOp };
    expect(verifyResponseEnvelope(line, differentOp, childMaterial())).toEqual({
      ok: false,
      reason: "operation_mismatch",
    });
    const differentSentLine = { ...attempt, sentLine: `${attempt.sentLine.slice(0, -2)}, "x":1}` };
    expect(verifyResponseEnvelope(line, differentSentLine, childMaterial())).toEqual({
      ok: false,
      reason: "request_digest_mismatch",
    });
  });

  it("binding mismatches: version / host / null-bound instance / null seq / null op / wrong digest range / inner body seq → each rejected with a distinct reason", () => {
    const attempt = makeAttempt();
    const privateKey = BOOT_OBJECT.keyPair.privateKey;

    // v:2 —— 未知版本 fail-closed（§6.5(3b)）。
    const futureVersion = { ...validEnvelopeFor(attempt), v: 2 };
    expect(verifyResponseEnvelope(forgeSignedLine(futureVersion, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "version_unsupported",
    });

    // host id 绑定不匹配（§6.5(3c)）。
    const otherHost = { ...validEnvelopeFor(attempt), hostInstanceId: randomUUID() };
    expect(verifyResponseEnvelope(forgeSignedLine(otherHost, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "host_instance_mismatch",
    });

    // null-bound 信封（§6.4(3) rev 2a：pre-binding 拒绝不回显 claim）永不满足子进程的绑定。
    const nullInstance = { ...validEnvelopeFor(attempt), instanceId: null };
    expect(verifyResponseEnvelope(forgeSignedLine(nullInstance, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "instance_mismatch",
    });
    const nullSeq = { ...validEnvelopeFor(attempt), seq: null };
    expect(verifyResponseEnvelope(forgeSignedLine(nullSeq, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "sequence_mismatch",
    });
    const nullOp = { ...validEnvelopeFor(attempt), op: null };
    expect(verifyResponseEnvelope(forgeSignedLine(nullOp, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "operation_mismatch",
    });

    // §6.4(2) 字节区间：digest 把结尾换行也算进去 → 不匹配（F4 修正后的精确定义）。
    const wrongRange = {
      ...validEnvelopeFor(attempt),
      requestDigest: sha256Hex(`${attempt.sentLine}\n`),
    };
    expect(verifyResponseEnvelope(forgeSignedLine(wrongRange, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "request_digest_mismatch",
    });

    // §6.4(1)：body 内层 seq ≠ envelope seq —— (3h) 拒绝。
    const innerSeqMismatch = {
      ...validEnvelopeFor(attempt),
      response: { ok: true, seq: attempt.seq + 1, data: {} },
    };
    expect(verifyResponseEnvelope(forgeSignedLine(innerSeqMismatch, privateKey), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "response_body_seq_mismatch",
    });
  });

  it("unsigned: missing signature field / plain JSON body → rejected (no unsigned mode, §6.5(2))", () => {
    const attempt = makeAttempt();
    const envelope = validEnvelopeFor(attempt);
    expect(verifyResponseEnvelope(JSON.stringify(envelope), attempt, childMaterial())).toEqual({
      ok: false,
      reason: "signature_missing",
    });
    expect(
      verifyResponseEnvelope(JSON.stringify({ ok: true, seq: 1, data: {} }), attempt, childMaterial()),
    ).toEqual({ ok: false, reason: "signature_missing" });
  });

  it("oversize received line (> 1 MiB) → rejected before any signature check; host refuses to emit an oversize envelope (§6.4(4))", () => {
    const attempt = makeAttempt();
    // 子进程侧：手工构造超限行（真实 host 的 emission cap 会拒绝签它 —— 见下半段）。
    const oversizeEnvelope = {
      ...validEnvelopeFor(attempt),
      response: { ok: true, seq: attempt.seq, data: "x".repeat(1024 * 1024) },
    };
    const oversizeLine = forgeSignedLine(oversizeEnvelope, BOOT_OBJECT.keyPair.privateKey);
    expect(Buffer.byteLength(oversizeLine, "utf8")).toBeGreaterThan(1024 * 1024);
    expect(verifyResponseEnvelope(oversizeLine, attempt, childMaterial())).toEqual({
      ok: false,
      reason: "response_line_oversize",
    });

    // host 侧 emission cap：序列化行会超 1 MiB 的 body → 签名构造直接拒绝（internal_error 语义）。
    expect(() =>
      signForAttempt(attempt, BOOT_OBJECT, {
        ok: true,
        seq: attempt.seq,
        data: "y".repeat(1024 * 1024),
      }),
    ).toThrow(/1 MiB/);

    // 边界：恰好 1 MiB（含换行前的行字节）允许，+1 拒绝。
    const baseline = signForAttempt(attempt, BOOT_OBJECT, { ok: true, seq: attempt.seq, data: "" });
    const baselineLength = Buffer.byteLength(JSON.stringify(baseline), "utf8");
    const fitsExactly = signForAttempt(attempt, BOOT_OBJECT, {
      ok: true,
      seq: attempt.seq,
      data: "z".repeat(1024 * 1024 - baselineLength),
    });
    expect(Buffer.byteLength(JSON.stringify(fitsExactly), "utf8")).toBe(1024 * 1024);
    expect(
      verifyResponseEnvelope(JSON.stringify(fitsExactly), attempt, childMaterial()).ok,
    ).toBe(true);
    expect(() =>
      signForAttempt(attempt, BOOT_OBJECT, {
        ok: true,
        seq: attempt.seq,
        data: "z".repeat(1024 * 1024 - baselineLength + 1),
      }),
    ).toThrow(/1 MiB/);
  });

  it("previous host boot: envelope signed by boot N's key, child holds boot N+1's material → rejected", () => {
    const previousBoot = mintBrokerBootState();
    const currentBoot = mintBrokerBootState();
    const attempt = makeAttempt();
    // (a)：旧 boot 的签名钥 → 子进程持新 boot 的公钥 → 签名验证失败。
    const staleSigned = signForAttempt(attempt, previousBoot);
    expect(
      verifyResponseEnvelope(JSON.stringify(staleSigned), attempt, childMaterial(currentBoot)),
    ).toEqual({ ok: false, reason: "signature_invalid" });
    // (c)：新 boot 的钥签名但携带旧 boot 的 hostInstanceId → host 绑定失败。
    const staleHostId = { ...validEnvelopeFor(attempt, currentBoot), hostInstanceId: previousBoot.hostId };
    expect(
      verifyResponseEnvelope(
        forgeSignedLine(staleHostId, currentBoot.keyPair.privateKey),
        attempt,
        childMaterial(currentBoot),
      ),
    ).toEqual({ ok: false, reason: "host_instance_mismatch" });
  });

  it("child-side canonicalization failure (non-JCS-serializable number in the received envelope) → full rejection (§6.4(5) rev 2a)", () => {
    const attempt = makeAttempt();
    const envelope = validEnvelopeFor(attempt);
    // 手工写 raw JSON 文本 1e999：JSON.parse 得到 Infinity —— canonicalization 拒绝，
    // 与签名失败同级：整封拒绝（F16）。
    const envelopeText = JSON.stringify(envelope, (key, value) =>
      key === "data" ? "%%POISON%%" : value,
    ).replace('"%%POISON%%"', "1e999");
    const line = `{"envelope":${envelopeText},"signature":"${Buffer.from("whatever").toString("base64")}"}`;
    expect(verifyResponseEnvelope(line, attempt, childMaterial())).toEqual({
      ok: false,
      reason: "envelope_canonicalization_failed",
    });
  });

  it("cross-instance: envelope for instance A presented with instance B's attempt context → rejected (§6.5(3d))", () => {
    const instanceA = makeAttempt();
    const instanceB = makeAttempt();
    const signedForA = signForAttempt(instanceA);
    expect(
      verifyResponseEnvelope(JSON.stringify(signedForA), instanceB, childMaterial()),
    ).toEqual({ ok: false, reason: "instance_mismatch" });
  });

  it("multi-chunk digest equality: host digests the reassembled line, child digests the bytes it wrote — equal (§6.4(2), §6.5(3g))", () => {
    // socket 分多次 write 到达 —— host 对重组后的整行取 digest。
    const part1 = '{"instanceId":"';
    const part2 = randomUUID();
    const part3 = `","seq":1,"op":"compile_intent","params":{"description":"${"x".repeat(3000)}","amount":1200},"token":"${"a".repeat(64)}","sessionId":"session-1"}`;
    const sentLine = part1 + part2 + part3;
    const reassembled = [part1, part2, part3].join("");
    expect(requestLineDigest(reassembled)).toBe(requestLineDigest(sentLine));

    // §6.4(2) 字节区间的函数级钉子：结尾换行不计入（F4）；含换行的 digest 是另一个值。
    expect(requestLineDigest(sentLine)).toBe(requestLineDigest(`${sentLine}\n`));
    expect(requestLineDigest(sentLine)).not.toBe(sha256Hex(`${sentLine}\n`));

    // 完整 sign/verify 在该行上走通。
    const attempt = { instanceId: part2, seq: 1, op: "compile_intent" as PayswapBrokerOp, sentLine };
    const signed = signForAttempt(attempt);
    expect(verifyResponseEnvelope(JSON.stringify(signed), attempt, childMaterial()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// instance registry（§10）
// ---------------------------------------------------------------------------

describe("payswap instance registry (contract §10)", () => {
  function makeEntry(overrides: Partial<PayswapInstanceRegistryEntry> = {}): PayswapInstanceRegistryEntry {
    return {
      instanceId: randomUUID(),
      token: randomBytes(32).toString("hex"),
      childPid: 4242,
      pluginRegistrationIdentity: PAYSWAP_OFFICIAL_PLUGIN_ID,
      workspace: "/tmp/workspace-a",
      sessionScope: "session-a",
      spawnedAt: Date.now(),
      ...overrides,
    };
  }

  it("register → lookup live with the registered entry", () => {
    const registry = createPayswapInstanceRegistry();
    const entry = makeEntry();
    registry.register(entry);
    const found = registry.lookup(entry.instanceId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("live");
    if (found?.status === "live") expect(found.entry).toEqual(entry);
    expect(registry.listLive()).toEqual([entry]);
  });

  it("tombstone(exit) → lookup tombstoned with reason 'exit'; a caller can distinguish (§10.2(1))", () => {
    const registry = createPayswapInstanceRegistry();
    const entry = makeEntry();
    registry.register(entry);
    expect(registry.tombstone(entry.instanceId, "exit")).toBe(true);
    const found = registry.lookup(entry.instanceId);
    expect(found).toEqual({ status: "tombstoned", reason: "exit" });
    // 重复 tombstone 不改写原因（append-only，原因在 tombstone 时一次性设定）。
    expect(registry.tombstone(entry.instanceId, "superseded")).toBe(false);
    expect(registry.lookup(entry.instanceId)).toEqual({ status: "tombstoned", reason: "exit" });
    expect(registry.listLive()).toEqual([]);
  });

  it("revokePluginInstances tombstones every live instance of the plugin with reason 'disabled' (§10.2(2))", () => {
    const registry = createPayswapInstanceRegistry();
    const first = makeEntry();
    const second = makeEntry();
    const otherPlugin = makeEntry({ pluginRegistrationIdentity: "other-plugin@zcode-plugins-official" });
    registry.register(first);
    registry.register(second);
    registry.register(otherPlugin);
    const revoked = registry.revokePluginInstances(PAYSWAP_OFFICIAL_PLUGIN_ID);
    expect(revoked.sort()).toEqual([first.instanceId, second.instanceId].sort());
    expect(registry.lookup(first.instanceId)).toEqual({ status: "tombstoned", reason: "disabled" });
    expect(registry.lookup(second.instanceId)).toEqual({ status: "tombstoned", reason: "disabled" });
    // 其它插件的实例不受影响。
    expect(registry.lookup(otherPlugin.instanceId)?.status).toBe("live");
  });

  it("re-register = new instanceId; append-only — the old entry is never mutated in place (§10.1)", () => {
    const registry = createPayswapInstanceRegistry();
    const original = makeEntry();
    registry.register(original);
    registry.tombstone(original.instanceId, "exit");
    const respawn = makeEntry({ childPid: original.childPid });
    registry.register(respawn);
    expect(respawn.instanceId).not.toBe(original.instanceId);
    const old = registry.lookup(original.instanceId);
    if (old?.status !== "tombstoned") throw new Error("expected tombstoned");
    // 旧条目原封不动。
    expect(old.reason).toBe("exit");
    expect(registry.lookup(respawn.instanceId)?.status).toBe("live");
  });

  it("unknown instance lookup → undefined and creates no state (§10.1)", () => {
    const registry = createPayswapInstanceRegistry();
    const live = makeEntry();
    registry.register(live);
    expect(registry.lookup(randomUUID())).toBeUndefined();
    expect(registry.listLive()).toEqual([live]);
    // tombstone 未知 id 也不创建状态（§10.1：状态只经 register 产生）。
    expect(registry.tombstone(randomUUID(), "exit")).toBe(false);
    expect(registry.listLive()).toEqual([live]);
  });

  it("entries are frozen — mutation attempts throw", () => {
    const registry = createPayswapInstanceRegistry();
    const entry = makeEntry();
    registry.register(entry);
    const found = registry.lookup(entry.instanceId);
    if (found?.status !== "live") throw new Error("expected live");
    expect(() => {
      (found.entry as unknown as { token: string }).token = "leaked";
    }).toThrow();
    expect(() => {
      (registry.listLive()[0] as unknown as { token: string }).token = "leaked";
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runtimeEnv：五键凭据组的 capture / strip / passthrough（§4.3/§4.4）
// ---------------------------------------------------------------------------

describe("payswap broker credential tuple in runtimeEnv (contract §4.3/§4.4)", () => {
  it("complete valid set → tuple returned (all five keys, §4.4(1))", () => {
    const tuple = mintTuple();
    expect(getCapturedPayswapBrokerCredentials(tupleAsEnv(tuple))).toEqual(tuple);
  });

  it("each of the five keys individually missing (complete-minus-one) → snapshot null", () => {
    for (const missing of PAYSWAP_BROKER_ENV_KEYS) {
      const tuple = mintTuple();
      const env = tupleAsEnv(tuple);
      delete env[missing];
      // 半组凭据永不启动（:171-174 纪律的五键推广 —— all-or-nothing）。
      expect(getCapturedPayswapBrokerCredentials(env), `missing ${missing}`).toBeNull();
    }
  });

  it("proper subsets (1 key alone, 2 keys, 4 keys already covered above) → null", () => {
    const tuple = mintTuple();
    const env = tupleAsEnv(tuple);
    expect(getCapturedPayswapBrokerCredentials({ [PAYSWAP_BROKER_TOKEN_ENV_KEY]: tuple.token })).toBeNull();
    expect(
      getCapturedPayswapBrokerCredentials({
        [PAYSWAP_BROKER_TOKEN_ENV_KEY]: tuple.token,
        [PAYSWAP_BROKER_SOCKET_ENV_KEY]: tuple.socket,
      }),
    ).toBeNull();
    expect(getCapturedPayswapBrokerCredentials({})).toBeNull();
  });

  it("invalid shapes (bad token hex / bad UUID / bad base64 key / empty socket) → cleared snapshot (fail-closed)", () => {
    expect(getCapturedPayswapBrokerCredentials(tupleAsEnv(mintTuple({ token: "z".repeat(64) })))).toBeNull();
    expect(getCapturedPayswapBrokerCredentials(tupleAsEnv(mintTuple({ token: "a".repeat(63) })))).toBeNull();
    expect(
      getCapturedPayswapBrokerCredentials(tupleAsEnv(mintTuple({ instanceId: "not-a-uuid" }))),
    ).toBeNull();
    expect(getCapturedPayswapBrokerCredentials(tupleAsEnv(mintTuple({ hostId: "00000000-0000-0000-0000-000000000000" })))).toBeNull();
    expect(
      getCapturedPayswapBrokerCredentials(
        tupleAsEnv(mintTuple({ verifyKeyBase64: Buffer.from("31-bytes-of-attacker-key-material").toString("base64") })),
      ),
    ).toBeNull();
    expect(getCapturedPayswapBrokerCredentials(tupleAsEnv(mintTuple({ socket: "   " })))).toBeNull();
  });

  it("sanitize captures before stripping (CUA precedent): env stripped, snapshot readable", () => {
    const keys = [...PAYSWAP_BROKER_ENV_KEYS] as const;
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    resetCapturedPayswapBrokerCredentialsForTest();
    try {
      const tuple = mintTuple();
      for (const [key, value] of Object.entries(tupleAsEnv(tuple))) process.env[key] = value;
      sanitizeZCodeRuntimeEnvInPlace(process.env);
      for (const key of keys) expect(process.env[key]).toBeUndefined();
      expect(readCapturedPayswapBrokerCredentials()).toEqual(tuple);
    } finally {
      resetCapturedPayswapBrokerCredentialsForTest();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("a partial tuple reaching sanitize clears the captured snapshot (fail-closed, §4.4(1))", () => {
    const keys = [...PAYSWAP_BROKER_ENV_KEYS] as const;
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    resetCapturedPayswapBrokerCredentialsForTest();
    try {
      const tuple = mintTuple();
      const full = tupleAsEnv(tuple);
      for (const [key, value] of Object.entries(full)) process.env[key] = value;
      sanitizeZCodeRuntimeEnvInPlace(process.env);
      expect(readCapturedPayswapBrokerCredentials()).toEqual(tuple);
      // 4/5 键的半组到达 → 快照清空，不得复用另一半。
      delete process.env[PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY];
      for (const key of keys) if (key !== PAYSWAP_BROKER_VERIFY_KEY_ENV_KEY && process.env[key] === undefined) {
        process.env[key] = full[key];
      }
      sanitizeZCodeRuntimeEnvInPlace(process.env);
      expect(readCapturedPayswapBrokerCredentials()).toBeNull();
    } finally {
      resetCapturedPayswapBrokerCredentialsForTest();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("strip: sanitized child env (buildMcpStdioEnv 的核心 sanitize) contains none of the five keys", () => {
    const tuple = mintTuple();
    const sanitized = sanitizeZCodeRuntimeEnv({
      ...tupleAsEnv(tuple),
      SOME_SIBLING_KEY: "keep-me",
    });
    for (const key of PAYSWAP_BROKER_ENV_KEYS) expect(sanitized[key]).toBeUndefined();
    expect(sanitized.SOME_SIBLING_KEY).toBe("keep-me");
  });

  it("tool-env passthrough cannot restore any PAYSWAP_BROKER_* key (§4.3(1) rev 2a — the two-list discipline)", () => {
    const tuple = mintTuple();
    for (const key of PAYSWAP_BROKER_ENV_KEYS) {
      expect(shouldCaptureZCodeToolEnvPassthroughKey(key)).toBe(false);
    }
    // 构建方向：被剔除的键不得进入 passthrough JSON。
    const passthrough = buildZCodeToolEnvPassthroughEnv({ ...tupleAsEnv(tuple), HTTP_PROXY: "http://proxy:8080" });
    const restored = readZCodeToolEnvPassthroughEnv(passthrough);
    expect(restored.HTTP_PROXY).toBe("http://proxy:8080");
    for (const key of PAYSWAP_BROKER_ENV_KEYS) expect(restored[key]).toBeUndefined();
    // 恶意预置的 passthrough JSON 同样被过滤（blocklist 而非仅构建侧遗漏）。
    const hostile = readZCodeToolEnvPassthroughEnv({
      [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({ ...tupleAsEnv(tuple), HTTP_PROXY: "http://x:1" }),
    });
    expect(hostile).toEqual({ HTTP_PROXY: "http://x:1" });
  });
});

// ---------------------------------------------------------------------------
// 受信注入（§4.2，N19）
// ---------------------------------------------------------------------------

describe("payswap trusted injection (contract §4.2, N19)", () => {
  function officialPayswapConfig(): McpServerConfig {
    return {
      type: "stdio",
      command: process.execPath,
      args: ["zcode.cjs", "__zcode-plugin-host", "/cache/payswap/dist/server.mjs"],
      env: { [ZCODE_PLUGIN_ID_ENV_KEY]: PAYSWAP_OFFICIAL_PLUGIN_ID, PAYSWAP_FINANCIAL_WORKSPACE: "true" },
    };
  }

  it("official registration + reference-identical config → all five keys injected (§4.2(1)-(2))", () => {
    const officialConfig = officialPayswapConfig();
    const configuredServers: Record<string, McpServerConfig> = { "plugin:payswap:gateway": officialConfig };
    const pluginServers: Record<string, McpServerConfig> = { "plugin:payswap:gateway": officialConfig };
    const trusted = resolveTrustedOfficialPayswapServerNames(configuredServers, pluginServers);
    expect(trusted).toEqual(new Set(["plugin:payswap:gateway"]));

    const tuple = mintTuple();
    const injected = injectPayswapBrokerMcpServers(configuredServers, tuple, trusted);
    const gateway = injected["plugin:payswap:gateway"];
    if (gateway?.type !== "stdio") throw new Error("expected stdio gateway");
    expect(gateway.env).toEqual({
      ...officialConfig.env,
      ...tupleAsEnv(tuple),
    });
    // 非 stdio 的同名配置不注入（CUA 同款门）。
    const httpOnly: Record<string, McpServerConfig> = {
      other: { type: "http", url: "http://127.0.0.1:1" },
    };
    expect(injectPayswapBrokerMcpServers(httpOnly, tuple, new Set(["other"]))).toBe(httpOnly);
  });

  it("copied config with payswap names/commands/env gets nothing (N19, reference-identity gate)", () => {
    const officialConfig = officialPayswapConfig();
    // 拷贝：同名字段、不同对象身份 —— 用户/项目 override 的形状。
    const copied: McpServerConfig = { ...officialConfig, env: { ...officialConfig.env } };
    const configuredServers: Record<string, McpServerConfig> = { "plugin:payswap:gateway": copied };
    const pluginServers: Record<string, McpServerConfig> = { "plugin:payswap:gateway": officialConfig };
    const trusted = resolveTrustedOfficialPayswapServerNames(configuredServers, pluginServers);
    expect(trusted.size).toBe(0);

    const tuple = mintTuple();
    const injected = injectPayswapBrokerMcpServers(configuredServers, tuple, trusted);
    expect(injected).toBe(configuredServers);
    const gateway = injected["plugin:payswap:gateway"];
    if (gateway?.type !== "stdio") throw new Error("expected stdio gateway");
    for (const key of PAYSWAP_BROKER_ENV_KEYS) expect(gateway.env?.[key]).toBeUndefined();
  });

  it("no credential → nothing injected (spawn-time only)", () => {
    const officialConfig = officialPayswapConfig();
    const configuredServers: Record<string, McpServerConfig> = { "plugin:payswap:gateway": officialConfig };
    const trusted = resolveTrustedOfficialPayswapServerNames(configuredServers, {
      "plugin:payswap:gateway": officialConfig,
    });
    expect(injectPayswapBrokerMcpServers(configuredServers, null, trusted)).toBe(configuredServers);
    expect(injectPayswapBrokerMcpServers(configuredServers, undefined, trusted)).toBe(configuredServers);
  });

  it("injection lands after the strip: official child gets the tuple, siblings get nothing (§4.3(2))", () => {
    const tuple = mintTuple();
    // 模拟生产 spawn 契约：sanitized 基座（buildMcpStdioEnv 的核心）之上 spread config.env。
    const sanitizedBase = sanitizeZCodeRuntimeEnv({ ...tupleAsEnv(tuple), PATH: "/usr/bin:/bin" });
    const officialConfig = officialPayswapConfig();
    const siblingConfig: McpServerConfig = { type: "stdio", command: "node", args: ["other-server.js"] };
    const configuredServers: Record<string, McpServerConfig> = {
      "plugin:payswap:gateway": officialConfig,
      "some-sibling": siblingConfig,
    };
    const trusted = resolveTrustedOfficialPayswapServerNames(configuredServers, {
      "plugin:payswap:gateway": officialConfig,
    });
    const injected = injectPayswapBrokerMcpServers(configuredServers, tuple, trusted);

    const siblingChildEnv = {
      ...sanitizedBase,
      ...((injected["some-sibling"] as McpStdioServerConfig | undefined)?.env ?? {}),
    };
    for (const key of PAYSWAP_BROKER_ENV_KEYS) expect(siblingChildEnv[key]).toBeUndefined();

    const officialChildEnv = {
      ...sanitizedBase,
      ...((injected["plugin:payswap:gateway"] as McpStdioServerConfig | undefined)?.env ?? {}),
    };
    for (const [key, value] of Object.entries(tupleAsEnv(tuple))) {
      expect(officialChildEnv[key]).toBe(value);
    }
    // 兄弟配置对象原样保留（未被动过）。
    expect(injected["some-sibling"]).toBe(siblingConfig);
  });
});
