/**
 * PaySwap P1.6 —— 服务端 operator-principal 模型（addendum §1.6.3 items 1–9；
 * N29/N30/N31/N32/N40/N41 的法则级臂；handoff work package 5）。
 *
 * 法则（§1.6.3，normative）：
 * - item 1/8：operator 凭据 = `pso_v1_<base64url(32B CSPRNG)>`；注册表只存 sha256
 *   digest（keyed lookup + 常时比较）；明文只在 provision/rotate 时一次性返回。
 * - item 2：principal 是 stable server-assigned id —— 同一凭据重连解析到同一 principal；
 *   `server-ws-*` 连接 id 永不是 principal。
 * - item 6/8：rotation 有限 grace（默认 24h）——窗口内新旧皆有效、旧凭据使用带审计
 *   标记；窗口结束旧凭据 revoked，其铸的 session 关闭、pending challenge 失效。
 *   revocation 立即生效（principal 域：该 operator 的 sessions 全部撤销 + challenges
 *   全部失效）。session 携带有界生命周期（默认 15min）。
 * - item 3/6 + N29/N30：challenge 一次性、绑定 (purpose/proposal, 签发 session 的
 *   principal)；他人 session 解析 = principal_mismatch（impersonation 拒绝，challenge
 *   不消耗）；已撤销/过期 session 的解析拒绝。
 * - item 5/9 + N31/N41：角色是 (operator, workspace/ledger) 绑定，非全局 —— 无
 *   approver 角色或未绑定目标 workspace 的 approve 动作在服务边界拒绝。
 * - item 4 + N32：client-supplied operator id 永不是身份；payload 声明**其它**
 *   principal → 拒绝请求；声明自己/不声明 → 忽略（身份仍由凭据解析）。
 * - item 7 + N40：两级握手顺序法则 —— level-1 失败时 operator 凭据**不被读取**；
 *   level-2 一切失败（unknown/revoked/rotated_out/格式错）归一为单一 generic
 *   `operator_authentication_failed`（对调用方不可区分，防枚举）。
 *
 * 本套件是法则级（纯 shared 模块）；服务端生产边界（真实 HTTP/WS）行在
 * packages/server/test/payswap-operator-auth.test.ts。
 */

import { createHash } from "node:crypto";
import {
  evaluatePayswapOperatorUpgrade,
  evaluatePayswapPrincipalClaim,
  mintPayswapOperatorCredential,
  parsePayswapOperatorCredential,
  PAYSWAP_OPERATOR_AUTH_FAILED_CODE,
  PAYSWAP_OPERATOR_TOKEN_PREFIX,
  verifyPayswapOperatorCredentialDigests,
  type PayswapOperatorRegistry,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";
import { createPayswapOperatorRegistry } from "@zcode/shared/payswap";

/** 可控时钟（法则的时间臂全走它）。 */
function controlledClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
    now: () => now,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

afterEach(() => {
  // 无全局状态：registry 全部局部构造。
});

describe("P1.6 operator credentials (§1.6.3 item 8)", () => {
  it("mints pso_v1_ credentials over 32 bytes of CSPRNG output with sha256 digests", () => {
    const minted = mintPayswapOperatorCredential();
    expect(minted.token.startsWith(PAYSWAP_OPERATOR_TOKEN_PREFIX)).toBe(true);
    // base64url(32B) = 43 chars，无 padding。
    const body = minted.token.slice(PAYSWAP_OPERATOR_TOKEN_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(minted.digest).toBe(
      createHash("sha256").update(minted.token, "utf8").digest("hex"),
    );
    const second = mintPayswapOperatorCredential();
    expect(second.token).not.toBe(minted.token);
    expect(second.digest).not.toBe(minted.digest);
  });

  it("parses only well-formed credentials and digests malformed ones (shape gate)", () => {
    const minted = mintPayswapOperatorCredential();
    const parsed = parsePayswapOperatorCredential(minted.token);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.digest).toBe(minted.digest);
    }
    expect(parsePayswapOperatorCredential("not_a_pso_token").ok).toBe(false);
    expect(parsePayswapOperatorCredential("pso_v1_short").ok).toBe(false);
    expect(parsePayswapOperatorCredential("pso_v1_bad+chars?xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").ok).toBe(false);
  });

  it("compares digests in constant time: equal true, different false", () => {
    const a = mintPayswapOperatorCredential();
    const b = mintPayswapOperatorCredential();
    expect(verifyPayswapOperatorCredentialDigests(a.digest, a.digest)).toBe(true);
    expect(verifyPayswapOperatorCredentialDigests(a.digest, b.digest)).toBe(false);
  });
});

describe("P1.6 operator registry (§1.6.3 items 1/2/8)", () => {
  it("provisions operators with digest-only records and a stable principal id", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      name: "alice",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver", "viewer"] }],
    });
    expect(provisioned.operatorId).toBeTruthy();
    expect(provisioned.token.startsWith(PAYSWAP_OPERATOR_TOKEN_PREFIX)).toBe(true);
    // 稳定 principal：同一凭据反复验证解析到同一 operatorId（item 2 —— reconnect 同一 principal）。
    const first = registry.verifyCredential(provisioned.token);
    const again = registry.verifyCredential(provisioned.token);
    expect(first).toMatchObject({ status: "valid", rotating: false });
    if (first.status === "valid") {
      expect(first.operatorId).toBe(provisioned.operatorId);
    }
    expect(again).toEqual(first);
    // 未知凭据：unknown（无状态泄漏）。
    expect(registry.verifyCredential(`${PAYSWAP_OPERATOR_TOKEN_PREFIX}${"A".repeat(43)}`)).toEqual({
      status: "unknown",
    });
  });

  it("stores no plaintext credential in its serialized state (digest-only storage law)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const rotated = registry.rotateOperatorCredential(provisioned.operatorId);
    const state = registry.serializeState();
    expect(typeof state).toBe("string");
    const serialized = JSON.stringify(JSON.parse(state) as unknown);
    expect(serialized).not.toContain(provisioned.token);
    expect(serialized).not.toContain(rotated.token);
    // digest-only：状态里出现的是 hex digest（64 chars），不是明文 token。
    expect(serialized).not.toMatch(/pso_v1_[A-Za-z0-9_-]{43}/u);
    // 重载后凭据仍验证到同一 principal（持久化 round-trip）。
    const restored = createPayswapOperatorRegistry({ now: clock.now, initialStateJson: state });
    const verdict = restored.verifyCredential(rotated.token);
    expect(verdict).toMatchObject({ status: "valid", operatorId: provisioned.operatorId });
  });
});

describe("P1.6 rotation, revocation, sessions (§1.6.3 item 6/8; N40 语义)", () => {
  it("keeps both credentials valid during the grace window and rotates the old one out after it", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now, rotationGraceMs: 24 * HOUR });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    clock.advance(MINUTE);
    const rotated = registry.rotateOperatorCredential(provisioned.operatorId);
    // 窗口内：新旧皆有效；旧的带 rotating 审计标记（item 8 —— 每次旧凭据认证发审计记录）。
    expect(registry.verifyCredential(provisioned.token)).toMatchObject({
      status: "valid",
      rotating: true,
      operatorId: provisioned.operatorId,
    });
    expect(registry.verifyCredential(rotated.token)).toMatchObject({
      status: "valid",
      rotating: false,
    });
    // 窗口结束：旧凭据 rotated_out（N40 credential-level 臂）。
    clock.advance(24 * HOUR);
    expect(registry.verifyCredential(provisioned.token)).toEqual({ status: "rotated_out" });
    expect(registry.verifyCredential(rotated.token)).toMatchObject({ status: "valid" });
  });

  it("closes sessions a rotated-out credential minted and invalidates their challenges (sweep)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({
      now: clock.now,
      rotationGraceMs: 24 * HOUR,
      sessionLifetimeMs: 48 * HOUR,
    });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const oldSession = registry.mintSessionForCredential(provisioned.token);
    expect(oldSession).not.toBeNull();
    clock.advance(MINUTE);
    const rotated = registry.rotateOperatorCredential(provisioned.operatorId);
    const newSession = registry.mintSessionForCredential(rotated.token);
    // 窗口结束 + sweep：旧 record 的 session 关闭，新 record 的不受影响。
    clock.advance(24 * HOUR + MINUTE);
    const swept = registry.sweepRotationWindows();
    expect(swept.closedSessions).toContain(oldSession!.sessionId);
    expect(swept.closedSessions).not.toContain(newSession!.sessionId);
    expect(registry.verifySession(oldSession!.sessionId)).not.toMatchObject({ status: "live" });
    expect(registry.verifySession(newSession!.sessionId)).toMatchObject({ status: "live" });
  });

  it("revokes a credential immediately, closing the principal's sessions and invalidating pending challenges", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const session = registry.mintSessionForCredential(provisioned.token);
    expect(session).not.toBeNull();
    const challenge = registry.issueChallenge({
      sessionId: session!.sessionId,
      purpose: "p1.6-law-row",
      expiresAt: clock.now() + HOUR,
    });
    expect(challenge).not.toBeNull();
    // 立即撤销（principal 域）：凭据 refused、sessions 关闭、challenges 失效（item 6/8）。
    const revocation = registry.revokeOperatorCredential(provisioned.recordId);
    expect(registry.verifyCredential(provisioned.token)).toEqual({ status: "revoked" });
    expect(revocation.closedSessions).toContain(session!.sessionId);
    expect(revocation.invalidatedChallenges).toContain(challenge!.challengeId);
    expect(registry.verifySession(session!.sessionId)).not.toMatchObject({ status: "live" });
  });

  it("expires operator sessions after the bounded deployment-configured lifetime", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now, sessionLifetimeMs: 15 * MINUTE });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const session = registry.mintSessionForCredential(provisioned.token);
    expect(registry.verifySession(session!.sessionId)).toMatchObject({ status: "live" });
    clock.advance(15 * MINUTE + 1);
    expect(registry.verifySession(session!.sessionId)).toEqual({ status: "expired" });
    // 未知 session：unknown。
    expect(registry.verifySession("no-such-session")).toEqual({ status: "unknown" });
  });
});

describe("P1.6 challenges: single-use, principal-bound (§1.6.3 items 3/6; N29/N30)", () => {
  it("rejects cross-principal resolution as impersonation without consuming the challenge (N29)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const alice = registry.provisionOperator({
      name: "alice",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const bob = registry.provisionOperator({
      name: "bob",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const aliceSession = registry.mintSessionForCredential(alice.token);
    const bobSession = registry.mintSessionForCredential(bob.token);
    const challenge = registry.issueChallenge({
      sessionId: aliceSession!.sessionId,
      purpose: "approval",
      expiresAt: clock.now() + HOUR,
    });
    // operator B 的 session 携正确 secret 解析 A 的 challenge → impersonation 拒绝。
    expect(
      registry.resolveChallenge({
        challengeId: challenge!.challengeId,
        secret: challenge!.secret,
        sessionId: bobSession!.sessionId,
      }),
    ).toEqual({ status: "principal_mismatch" });
    // challenge 未被消耗：A 本人仍可解析（一次性在成功时才消耗）。
    expect(
      registry.resolveChallenge({
        challengeId: challenge!.challengeId,
        secret: challenge!.secret,
        sessionId: aliceSession!.sessionId,
      }),
    ).toEqual({ status: "resolved" });
  });

  it("rejects resolution on revoked and expired sessions; revoked-session challenges were invalidated (N30)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    // 已撤销 session：revocation 级联已把 challenge 标记 invalidated。
    const revokedSession = registry.mintSessionForCredential(provisioned.token);
    const revokedChallenge = registry.issueChallenge({
      sessionId: revokedSession!.sessionId,
      purpose: "approval",
      expiresAt: clock.now() + HOUR,
    });
    registry.revokeOperatorCredential(provisioned.recordId);
    expect(
      registry.resolveChallenge({
        challengeId: revokedChallenge!.challengeId,
        secret: revokedChallenge!.secret,
        sessionId: revokedSession!.sessionId,
      }),
    ).toEqual({ status: "challenge_invalidated" });
    // 新 session 上解析已被级联失效的 challenge：同样拒绝（challenge 失效优先于 principal 匹配）。
    const reProvisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const freshSession = registry.mintSessionForCredential(reProvisioned.token);
    expect(
      registry.resolveChallenge({
        challengeId: revokedChallenge!.challengeId,
        secret: revokedChallenge!.secret,
        sessionId: freshSession!.sessionId,
      }),
    ).not.toEqual({ status: "resolved" });
    // 过期 session（无级联）：session_invalid。
    const longRegistry = createPayswapOperatorRegistry({
      now: clock.now,
      sessionLifetimeMs: 15 * MINUTE,
    });
    const op = longRegistry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const session = longRegistry.mintSessionForCredential(op.token);
    const challenge = longRegistry.issueChallenge({
      sessionId: session!.sessionId,
      purpose: "approval",
      expiresAt: clock.now() + HOUR,
    });
    clock.advance(16 * MINUTE);
    expect(
      longRegistry.resolveChallenge({
        challengeId: challenge!.challengeId,
        secret: challenge!.secret,
        sessionId: session!.sessionId,
      }),
    ).toEqual({ status: "session_invalid" });
  });

  it("enforces single-use, expiry, and secret match on challenge resolution", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const session = registry.mintSessionForCredential(provisioned.token);
    const challenge = registry.issueChallenge({
      sessionId: session!.sessionId,
      purpose: "approval",
      expiresAt: clock.now() + MINUTE,
    });
    // 错 secret：拒绝且不消耗。
    expect(
      registry.resolveChallenge({
        challengeId: challenge!.challengeId,
        secret: "0".repeat(64),
        sessionId: session!.sessionId,
      }),
    ).toEqual({ status: "secret_mismatch" });
    expect(
      registry.resolveChallenge({
        challengeId: challenge!.challengeId,
        secret: challenge!.secret,
        sessionId: session!.sessionId,
      }),
    ).toEqual({ status: "resolved" });
    // 一次性：第二次 resolved 之后再解析 → consumed。
    expect(
      registry.resolveChallenge({
        challengeId: challenge!.challengeId,
        secret: challenge!.secret,
        sessionId: session!.sessionId,
      }),
    ).toEqual({ status: "challenge_consumed" });
    // 过期 challenge。
    const second = registry.issueChallenge({
      sessionId: session!.sessionId,
      purpose: "approval",
      expiresAt: clock.now() + MINUTE,
    });
    clock.advance(2 * MINUTE);
    expect(
      registry.resolveChallenge({
        challengeId: second!.challengeId,
        secret: second!.secret,
        sessionId: session!.sessionId,
      }),
    ).toEqual({ status: "challenge_expired" });
    // 未知 challenge / 非 live session 签发 → null。
    expect(
      registry.issueChallenge({
        sessionId: "no-such-session",
        purpose: "approval",
        expiresAt: clock.now() + MINUTE,
      }),
    ).toBeNull();
    expect(
      registry.resolveChallenge({
        challengeId: "no-such-challenge",
        secret: "x",
        sessionId: session!.sessionId,
      }),
    ).toEqual({ status: "challenge_unknown" });
  });
});

describe("P1.6 workspace-scoped roles at the service boundary (§1.6.3 items 5/9; N31/N41)", () => {
  it("refuses the approve action for an operator without the approver role (N31)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const viewerOnly = registry.provisionOperator({
      name: "viewer-only",
      roleBindings: [{ ledgerId: "ws-a", roles: ["viewer", "auditor"] }],
    });
    expect(
      registry.authorizeAction({
        operatorId: viewerOnly.operatorId,
        ledgerId: "ws-a",
        action: "approve",
      }),
    ).toEqual({ status: "role_required" });
    const approver = registry.provisionOperator({
      name: "approver",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    expect(
      registry.authorizeAction({
        operatorId: approver.operatorId,
        ledgerId: "ws-a",
        action: "approve",
      }),
    ).toEqual({ status: "authorized", role: "approver" });
    expect(
      registry.authorizeAction({
        operatorId: "op_unknown",
        ledgerId: "ws-a",
        action: "approve",
      }),
    ).toEqual({ status: "unknown_operator" });
  });

  it("never lets a role bound in workspace A authorize workspace B (N41)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const approverInA = registry.provisionOperator({
      roleBindings: [
        { ledgerId: "ws-a", roles: ["approver"] },
        { ledgerId: "ws-b", roles: ["viewer"] },
      ],
    });
    expect(registry.resolveRoles(approverInA.operatorId, "ws-a")).toEqual(["approver"]);
    expect(registry.resolveRoles(approverInA.operatorId, "ws-b")).toEqual(["viewer"]);
    expect(registry.resolveRoles(approverInA.operatorId, "ws-c")).toEqual([]);
    expect(
      registry.authorizeAction({
        operatorId: approverInA.operatorId,
        ledgerId: "ws-b",
        action: "approve",
      }),
    ).toEqual({ status: "role_required" });
    expect(
      registry.authorizeAction({
        operatorId: approverInA.operatorId,
        ledgerId: "ws-c",
        action: "approve",
      }),
    ).toEqual({ status: "role_required" });
    // 绑定角色只增不改语义：重复 ledgerId 的绑定以先到为准（append-only 纪律）。
    expect(registry.resolveRoles(approverInA.operatorId, "ws-a")).toEqual(["approver"]);
  });
});

describe("P1.6 two-level upgrade handshake law (§1.6.3 item 7; N40 泛化)", () => {
  function authedRegistry(): { registry: PayswapOperatorRegistry; token: string } {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    return { registry, token: provisioned.token };
  }

  it("never reads the operator credential when level 1 failed (order law)", () => {
    const { registry, token } = authedRegistry();
    const verdict = evaluatePayswapOperatorUpgrade({
      level1Authorized: false,
      readOperatorCredential: () => {
        throw new Error("level-2 credential must not be read when level 1 failed");
      },
      registry,
    });
    expect(verdict).toEqual({ status: "deployment_unauthorized" });
    // 同一输入里带有效凭据也不改变结论（顺序优先）。
    expect(
      evaluatePayswapOperatorUpgrade({
        level1Authorized: false,
        readOperatorCredential: () => ({ kind: "operator_token", token }),
        registry,
      }),
    ).toEqual({ status: "deployment_unauthorized" });
  });

  it("answers unauthenticated for ordinary clients presenting no operator credential", () => {
    const { registry } = authedRegistry();
    expect(
      evaluatePayswapOperatorUpgrade({
        level1Authorized: true,
        readOperatorCredential: () => undefined,
        registry,
      }),
    ).toEqual({ status: "unauthenticated" });
  });

  it("collapses every invalid operator credential into the single generic operator_authentication_failed (N40)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now, rotationGraceMs: 24 * HOUR });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const rotated = registry.rotateOperatorCredential(provisioned.operatorId);
    clock.advance(24 * HOUR); // 旧凭据 rotated_out
    const verdicts = [
      `${PAYSWAP_OPERATOR_TOKEN_PREFIX}${"B".repeat(43)}`, // unknown
      "garbage", // malformed
      provisioned.token, // rotated_out
    ].map((token) =>
      evaluatePayswapOperatorUpgrade({
        level1Authorized: true,
        readOperatorCredential: () => ({ kind: "operator_token", token }),
        registry,
      }),
    );
    // 撤销臂同形。
    const second = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    registry.revokeOperatorCredential(second.recordId);
    verdicts.push(
      evaluatePayswapOperatorUpgrade({
        level1Authorized: true,
        readOperatorCredential: () => ({ kind: "operator_token", token: second.token }),
        registry,
      }),
    );
    // 过期 session cookie 臂同形。
    const shortClock = controlledClock();
    const shortRegistry = createPayswapOperatorRegistry({
      now: shortClock.now,
      sessionLifetimeMs: MINUTE,
    });
    const shortOp = shortRegistry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const shortSession = shortRegistry.mintSessionForCredential(shortOp.token);
    shortClock.advance(2 * MINUTE);
    verdicts.push(
      evaluatePayswapOperatorUpgrade({
        level1Authorized: true,
        readOperatorCredential: () => ({ kind: "session_cookie", sessionId: shortSession!.sessionId }),
        registry: shortRegistry,
      }),
    );
    for (const verdict of verdicts) {
      expect(verdict).toEqual({ status: "operator_authentication_failed" });
    }
  });

  it("authenticates valid credentials and live session cookies to the stable principal", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const provisioned = registry.provisionOperator({
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const viaToken = evaluatePayswapOperatorUpgrade({
      level1Authorized: true,
      readOperatorCredential: () => ({ kind: "operator_token", token: provisioned.token }),
      registry,
    });
    expect(viaToken).toMatchObject({
      status: "authenticated",
      operatorId: provisioned.operatorId,
    });
    if (viaToken.status === "authenticated") {
      expect(viaToken.sessionId).toBeTruthy();
      // 该 session 是 live 的（升级铸造了它）。
      expect(registry.verifySession(viaToken.sessionId)).toMatchObject({
        status: "live",
        operatorId: provisioned.operatorId,
      });
    }
    // session-cookie 臂：同一 principal，session id 即 cookie 的 id。
    const session = registry.mintSessionForCredential(provisioned.token);
    const viaCookie = evaluatePayswapOperatorUpgrade({
      level1Authorized: true,
      readOperatorCredential: () => ({ kind: "session_cookie", sessionId: session!.sessionId }),
      registry,
    });
    expect(viaCookie).toEqual({
      status: "authenticated",
      operatorId: provisioned.operatorId,
      sessionId: session!.sessionId,
    });
  });

  it("refuses a payload naming a principal other than the authenticated one and ignores the rest (N32)", () => {
    const clock = controlledClock();
    const registry = createPayswapOperatorRegistry({ now: clock.now });
    const alice = registry.provisionOperator({
      name: "alice",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    const bob = registry.provisionOperator({
      name: "bob",
      roleBindings: [{ ledgerId: "ws-a", roles: ["approver"] }],
    });
    // 不声明：ok。
    expect(evaluatePayswapPrincipalClaim(alice.operatorId, undefined)).toEqual({ status: "ok" });
    // 声明自己：ok（字段被忽略，身份仍由凭据解析）。
    expect(evaluatePayswapPrincipalClaim(alice.operatorId, alice.operatorId)).toEqual({ status: "ok" });
    // 声明他人：拒绝（payload 到 principal 无任何代码路径）。
    expect(evaluatePayswapPrincipalClaim(alice.operatorId, bob.operatorId)).toEqual({
      status: "foreign_principal_claim",
    });
    expect(evaluatePayswapPrincipalClaim(alice.operatorId, "op_does_not_exist")).toEqual({
      status: "foreign_principal_claim",
    });
  });
});

describe("P1.6 generic failure code constant (§1.6.3 item 7)", () => {
  it("exposes the single generic operator failure code", () => {
    expect(PAYSWAP_OPERATOR_TOKEN_PREFIX).toBe("pso_v1_");
    expect(PAYSWAP_OPERATOR_AUTH_FAILED_CODE).toBe("operator_authentication_failed");
  });
});
