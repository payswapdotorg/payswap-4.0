/**
 * PaySwap P1.7 —— 交易授权 grant 与受信 Class-B 批准（addendum §1.3/§1.6/§1.7；
 * N1–N17 的法则级臂；playbook work package P1.7）。
 *
 * 法则（normative）：
 * - §1.3：grant 绑定完整 tuple（principal/source/recipient/amount/purpose/route/
 *   fees/fx/expiry），digest = canonical JSON 的 SHA-256；呈现操作与绑定 tuple 的
 *   任何实质偏差（amount+1 minor unit、不同 recipient、多一 leg、更高费上限）=
 *   typed 拒绝 authorization_mismatch，绝不 best-effort 执行。
 * - §1.3/§1.4：grant 只能经 host 渲染授权卡（Class B）→ host account service →
 *   ledger（单一写者）这条路径铸造；ledger 序列 host 分配；单一铸造入口持实例
 *   nonce —— 伪造 mint / 他人 ledger 的 mint → unauthorized_mint，ledger 不动。
 * - N1–N9：每个旁路上下文（yolo/guarded confirm/session allow rule/allowedTools/
 *   workflow amend/subagent-yolo/automation）只能沉默 Layer-1 提示，没有一个能
 *   铸 grant —— enforcement seam 对全部上下文一律 authorization_required；
 *   上下文只是审计注记，永不改变裁决（context 不变性）。
 * - N2/N10–N12：呈现了 authorizationId 但 unknown/expired/consumed/偏差 →
 *   authorization_mismatch（拒绝码两枚：无呈现 = authorization_required；呈现而
 *   不获授权 = authorization_mismatch —— 审计 reason 区分 forged/expired/
 *   consumed/deviation）。
 * - §1.6.0：授权卡 payload 由 host 代码从 proposal 记录派生 —— 展示值与记录值
 *   byte-equal（N14）；payload schema **不含** plugin/tool 自报 display 字段
 *   （permission prompt 的有意 delta），未知键拒绝。
 * - §1.6.2 item 1：challenge = 256-bit CSPRNG，一次性、绑定单一 pending proposal
 *   与签发卡实例，随 proposal 过期；重放（已消耗/过期/他人 proposal 的 challenge）
 *   → 拒绝（N15）；teardown 失效后的陈旧重放 → challenge_invalidated（N18 法则臂）。
 * - §1.6.2 item 3：desktop 发送者三检 —— expected webContents、main frame、
 *   trusted application origin；zcode-sandbox://（插件沙箱）与 ui://（插件资源）
 *   origin 一律拒绝（N13/N16）。
 * - §1.6.2 item 4 + N26/N17/N8：plugin-UI 回调路径（mcp/uiCallTool 形状 / ui://
 *   交互）与模型文本不是批准事件 —— 分类器拒绝，无 grant 路径存在。
 *
 * 本套件是法则级（纯 shared 模块；desktop 卡实例 bearer）。服务端生产边界
 * （真实 /ws + 真实 channel：N28/N29/N30/N31/N41 的批准路径臂 + §1.6.2 item 5c
 * 暴露策略）在 packages/server/test/payswap-approval.test.ts。
 */

import {
  canonicalJsonStringify,
  classifyPayswapApprovalEventInput,
  createPayswapApprovalFlow,
  createPayswapCardInstanceChallengeStore,
  createPayswapGrantLedger,
  buildPayswapAuthorizationCardPayload,
  evaluatePayswapApprovalSender,
  evaluatePayswapTupleBinding,
  payswapAuthorizationCardPayloadSchema,
  payswapAuthorizationTupleSchema,
  payswapTupleDigest,
  payswapTupleDisplayProjection,
  PAYSWAP_BYPASS_INVOCATION_CONTEXTS,
  PAYSWAP_INVOCATION_CONTEXTS,
  PAYSWAP_UNAUTHORIZED_MINT_CODE,
  type PayswapApprovalFlow,
  type PayswapAuthorizationTuple,
  type PayswapGrantLedgerHandle,
} from "@zcode/shared/payswap";
import { afterEach, describe, expect, it } from "vitest";

/** 可控时钟（法则的时间臂全走它）。 */
function controlledClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const TRUSTED_APP_ORIGIN = "app://zcode-shell/index.html";

/** §1.3 合法 tuple 固定样本（law 级；生产 tuple 由 P4/P6 状态组装）。 */
function sampleTuple(overrides: Partial<PayswapAuthorizationTuple> = {}): PayswapAuthorizationTuple {
  const base: PayswapAuthorizationTuple = {
    principal: "human-a",
    source: { connectionId: "conn_1", accountId: "acct_1AB" },
    recipient: { recipientId: "rcp_77", evidenceRef: "evd:readback:0001" },
    amount: { value: "125.50", currency: "USD" },
    purpose: "invoice_settlement",
    route: {
      legs: [
        {
          legId: "leg-1",
          provider: "stripe",
          recipientId: "rcp_77",
          amount: "125.50",
          currency: "USD",
          idempotencyKey: "idem-leg-1",
        },
      ],
    },
    fees: { maxTotalFees: "2.75" },
    fx: { rateFloor: "1.0000", rateSource: "trace-2026-11", expiresAt: 1_500_000 },
    expiresAt: 2_000_000,
  };
  return { ...base, ...overrides };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** desktop 卡实例流（law 级默认装置：ledger + 卡实例 challenge 存储 + flow）。 */
function createCardInstanceFlow(options: { now: () => number } = { now: () => 1_000_000 }) {
  const ledgerHandle = createPayswapGrantLedger({ now: options.now });
  const challengeStore = createPayswapCardInstanceChallengeStore({ now: options.now });
  const flow = createPayswapApprovalFlow({
    now: options.now,
    challengePort: challengeStore,
    ledger: ledgerHandle.ledger,
    minter: ledgerHandle.minter,
    trustedAppOrigins: [TRUSTED_APP_ORIGIN],
  });
  return { ledgerHandle, challengeStore, flow };
}

/** 签发一张卡并解析之的完整正向路径 helper（各拒绝行复用其产物）。 */
async function issueAndApproveCard(flow: PayswapApprovalFlow, tuple: PayswapAuthorizationTuple) {
  const issued = flow.issueProposal({
    tuple,
    workspaceId: "ws-a",
    target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
  });
  if (issued.status !== "issued") {
    throw new Error(`fixture issuance failed: ${JSON.stringify(issued)}`);
  }
  const verdict = flow.resolveApproval({
    event: {
      proposalId: issued.proposal.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision: "approve",
    },
    sender: {
      kind: "desktop_frame",
      webContentsId: 7,
      isMainFrame: true,
      frameUrl: TRUSTED_APP_ORIGIN,
    },
  });
  return { issued, verdict };
}

afterEach(() => {
  // 法则级套件无进程资源；占位保持与其它套件同构。
});

// ---------------------------------------------------------------------------
// §1.3 tuple —— schema、digest、绑定法则
// ---------------------------------------------------------------------------

describe("P1.7 authorization tuple (§1.3)", () => {
  it("accepts a well-formed tuple and rejects unknown keys (strict)", () => {
    const parsed = payswapAuthorizationTupleSchema.parse(sampleTuple());
    expect(parsed.principal).toBe("human-a");

    const withUnknownKey = { ...sampleTuple(), authorizationId: "hack-1" };
    expect(() => payswapAuthorizationTupleSchema.parse(withUnknownKey)).toThrow();

    const withCardDisplay = { ...sampleTuple(), display: { amount: "0.01" } };
    expect(() => payswapAuthorizationTupleSchema.parse(withCardDisplay)).toThrow();
  });

  it("rejects malformed money shapes (non-decimal amount, bad currency, empty legs)", () => {
    expect(() =>
      payswapAuthorizationTupleSchema.parse(
        sampleTuple({ amount: { value: "125.5001e2", currency: "USD" } }),
      ),
    ).toThrow();
    expect(() =>
      payswapAuthorizationTupleSchema.parse(
        sampleTuple({ amount: { value: "-1", currency: "USD" } }),
      ),
    ).toThrow();
    expect(() =>
      payswapAuthorizationTupleSchema.parse(sampleTuple({ amount: { value: "1", currency: "usd" } })),
    ).toThrow();
    expect(() => payswapAuthorizationTupleSchema.parse(sampleTuple({ route: { legs: [] } }))).toThrow();
    expect(() =>
      payswapAuthorizationTupleSchema.parse(
        sampleTuple({ fees: { maxTotalFees: "cheap" } }),
      ),
    ).toThrow();
  });

  it("digest is stable, canonical (key-order independent), and collision-sensitive", () => {
    const tuple = sampleTuple();
    expect(payswapTupleDigest(tuple)).toBe(payswapTupleDigest(deepClone(tuple)));
    // 键序无关：canonical JSON 键排序（顶层键逆序重建同值 tuple）。
    const shuffled: PayswapAuthorizationTuple = {
      expiresAt: tuple.expiresAt,
      fx: tuple.fx,
      fees: tuple.fees,
      route: tuple.route,
      purpose: tuple.purpose,
      amount: tuple.amount,
      recipient: tuple.recipient,
      source: tuple.source,
      principal: tuple.principal,
    };
    expect(payswapTupleDigest(shuffled)).toBe(payswapTupleDigest(tuple));
    // 任何实质字段变化 → 不同 digest。
    expect(payswapTupleDigest(sampleTuple({ purpose: "other_purpose" }))).not.toBe(
      payswapTupleDigest(tuple),
    );
    expect(
      payswapTupleDigest(sampleTuple({ amount: { value: "125.51", currency: "USD" } })),
    ).not.toBe(payswapTupleDigest(tuple));
  });

  it("binding law: exact match passes; every material deviation mismatches (N10 law)", () => {
    const bound = sampleTuple();
    expect(evaluatePayswapTupleBinding(bound, deepClone(bound))).toEqual({ status: "match" });

    // amount +1 minor unit。
    const amountDeviation = deepClone(bound);
    amountDeviation.amount = { value: "125.51", currency: "USD" };
    expect(evaluatePayswapTupleBinding(bound, amountDeviation)).toMatchObject({
      status: "mismatch",
      firstDeviation: "amount",
    });

    // 不同 recipient。
    const recipientDeviation = deepClone(bound);
    recipientDeviation.recipient = { recipientId: "rcp_EVIL", evidenceRef: "evd:readback:0001" };
    expect(evaluatePayswapTupleBinding(bound, recipientDeviation).status).toBe("mismatch");

    // 多一 leg。
    const extraLeg = deepClone(bound);
    extraLeg.route = {
      legs: [
        ...bound.route.legs,
        {
          legId: "leg-2",
          provider: "stripe",
          recipientId: "rcp_77",
          amount: "0.01",
          currency: "USD",
          idempotencyKey: "idem-leg-2",
        },
      ],
    };
    expect(evaluatePayswapTupleBinding(bound, extraLeg).status).toBe("mismatch");

    // 更高费上限。
    const feeDeviation = deepClone(bound);
    feeDeviation.fees = { maxTotalFees: "2.76" };
    expect(evaluatePayswapTupleBinding(bound, feeDeviation).status).toBe("mismatch");

    // 不同 purpose / source / principal / expiry。
    expect(
      evaluatePayswapTupleBinding(bound, sampleTuple({ purpose: "other_purpose" })).status,
    ).toBe("mismatch");
    expect(
      evaluatePayswapTupleBinding(
        bound,
        sampleTuple({ source: { connectionId: "conn_2", accountId: "acct_1AB" } }),
      ).status,
    ).toBe("mismatch");
    expect(
      evaluatePayswapTupleBinding(bound, sampleTuple({ principal: "human-b" })).status,
    ).toBe("mismatch");
    expect(
      evaluatePayswapTupleBinding(bound, sampleTuple({ expiresAt: 2_000_001 })).status,
    ).toBe("mismatch");
  });
});

// ---------------------------------------------------------------------------
// §1.3/§1.4 grant ledger —— 单一铸造路径 + enforcement seam（N1–N12 法则臂）
// ---------------------------------------------------------------------------

describe("P1.7 grant ledger — the single mint path and the enforcement seam (§1.3/§1.4)", () => {
  it("mints only through the ledger-paired minter with host-allocated ids and sequences", () => {
    const clock = controlledClock();
    const handle = createPayswapGrantLedger({ now: clock.now });
    const tuple = sampleTuple();
    const first = handle.ledger.appendApprovedGrant(
      handle.minter.mintApprovedGrant({
        tuple,
        tupleDigest: payswapTupleDigest(tuple),
        principal: tuple.principal,
        workspaceId: "ws-a",
        approvedRole: "approver",
        issuedAt: clock.now(),
      }),
    );
    const second = handle.ledger.appendApprovedGrant(
      handle.minter.mintApprovedGrant({
        tuple,
        tupleDigest: payswapTupleDigest(tuple),
        principal: tuple.principal,
        workspaceId: "ws-a",
        approvedRole: "approver",
        issuedAt: clock.now(),
      }),
    );
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.authorizationId).not.toBe(second.authorizationId);
    expect(first.tupleDigest).toBe(payswapTupleDigest(tuple));
    expect(first.approvedRole).toBe("approver");
  });

  it("rejects forged mints and mints minted by another ledger instance (unauthorized_mint)", () => {
    const clock = controlledClock();
    const handle = createPayswapGrantLedger({ now: clock.now });
    const other = createPayswapGrantLedger({ now: clock.now });
    const tuple = sampleTuple();

    // 手工伪造的 mint（无 brand/nonce）。
    const forged = {
      tuple,
      tupleDigest: payswapTupleDigest(tuple),
      principal: tuple.principal,
      workspaceId: "ws-a",
      issuedAt: clock.now(),
    } as unknown as Parameters<typeof handle.ledger.appendApprovedGrant>[0];
    expect(() => handle.ledger.appendApprovedGrant(forged)).toThrow(PAYSWAP_UNAUTHORIZED_MINT_CODE);

    // 另一 ledger 实例的 minter 铸的 mint（nonce 不配对）。
    const foreign = other.minter.mintApprovedGrant({
      tuple,
      tupleDigest: payswapTupleDigest(tuple),
      principal: tuple.principal,
      workspaceId: "ws-a",
      issuedAt: clock.now(),
    });
    expect(() => handle.ledger.appendApprovedGrant(foreign)).toThrow(PAYSWAP_UNAUTHORIZED_MINT_CODE);
    expect(handle.ledger.records()).toHaveLength(0);
  });

  it("N1, N3–N7, N9 law: every bypass context without a grant refuses authorization_required", () => {
    const clock = controlledClock();
    const handle = createPayswapGrantLedger({ now: clock.now });
    const tuple = sampleTuple();
    // 上下文集完整存在（N1 yolo、N3 guarded、N4 allow rule、N5 allowedTools、
    // N6 workflow amend、N7 subagent、N9 automation —— §1.1 的全部旁路路径）。
    expect(PAYSWAP_BYPASS_INVOCATION_CONTEXTS).toEqual(
      expect.arrayContaining([
        "yolo_session",
        "guarded_confirm",
        "session_allow_rule",
        "allowed_tools",
        "workflow_amend",
        "subagent_yolo_parent",
        "automation_run",
      ]),
    );
    for (const context of PAYSWAP_INVOCATION_CONTEXTS) {
      const verdict = handle.ledger.authorizeOperation({
        presentedTuple: tuple,
        invocationContext: context,
      });
      expect(verdict).toMatchObject({ status: "refused", code: "authorization_required" });
    }
    // 拒绝审计记录了上下文（被观察、但永不授权）。
    const audit = handle.ledger.refusalAudit();
    expect(audit).toHaveLength(PAYSWAP_INVOCATION_CONTEXTS.length);
    for (const entry of audit) {
      expect(entry.code).toBe("authorization_required");
      expect(PAYSWAP_INVOCATION_CONTEXTS).toContain(entry.invocationContext);
    }
  });

  it("N2 law: presented-but-invalid authorizationId refuses authorization_mismatch (forged/expired/consumed)", () => {
    const clock = controlledClock();
    const handle = createPayswapGrantLedger({ now: clock.now });
    const tuple = sampleTuple();

    // 伪造（unknown id）。
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: "forged-id",
        presentedTuple: tuple,
        invocationContext: "yolo_session",
      }),
    ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "grant_unknown" });

    // 过期 grant。
    const expiredGrant = handle.ledger.appendApprovedGrant(
      handle.minter.mintApprovedGrant({
        tuple,
        tupleDigest: payswapTupleDigest(tuple),
        principal: tuple.principal,
        workspaceId: "ws-a",
        issuedAt: clock.now(),
      }),
    );
    clock.advance(tuple.expiresAt - clock.now() + 1);
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: expiredGrant.authorizationId,
        presentedTuple: tuple,
        invocationContext: "yolo_session",
      }),
    ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "grant_expired" });

    // 已消耗 grant。
    const consumedGrant = handle.ledger.appendApprovedGrant(
      handle.minter.mintApprovedGrant({
        tuple,
        tupleDigest: payswapTupleDigest(tuple),
        principal: tuple.principal,
        workspaceId: "ws-a",
        issuedAt: clock.now(),
      }),
    );
    const firstUse = handle.ledger.authorizeOperation({
      authorizationId: consumedGrant.authorizationId,
      presentedTuple: tuple,
      invocationContext: "interactive_default",
    });
    expect(firstUse.status).toBe("authorized");
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: consumedGrant.authorizationId,
        presentedTuple: tuple,
        invocationContext: "interactive_default",
      }),
    ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "grant_consumed" });
  });

  it("context invariance: the invocation context never changes the verdict (N1–N9's core)", () => {
    const clock = controlledClock();
    const tuple = sampleTuple();
    const mint = (handle: PayswapGrantLedgerHandle) =>
      handle.ledger.appendApprovedGrant(
        handle.minter.mintApprovedGrant({
          tuple,
          tupleDigest: payswapTupleDigest(tuple),
          principal: tuple.principal,
          workspaceId: "ws-a",
          issuedAt: clock.now(),
        }),
      );
    // 同一法则输入在 yolo（最敌意上下文）与 interactive 下同样授权 —— 上下文不是输入；
    // 无 grant 时同样在全部上下文拒绝（上面 N1–N9 行已穷举，此处断言授权不变性）。
    for (const context of ["yolo_session", "interactive_default"] as const) {
      const fresh = createPayswapGrantLedger({ now: clock.now });
      const freshGrant = mint(fresh);
      expect(
        fresh.ledger.authorizeOperation({
          authorizationId: freshGrant.authorizationId,
          presentedTuple: tuple,
          invocationContext: context,
        }).status,
      ).toBe("authorized");
    }
    // 偏差 tuple 同样在全部上下文拒绝（上下文不软化 mismatch）。
    const deviated = deepClone(tuple);
    deviated.amount = { value: "125.51", currency: "USD" };
    for (const context of ["yolo_session", "interactive_default"] as const) {
      const fresh = createPayswapGrantLedger({ now: clock.now });
      const freshGrant = mint(fresh);
      expect(
        fresh.ledger.authorizeOperation({
          authorizationId: freshGrant.authorizationId,
          presentedTuple: deviated,
          invocationContext: context,
        }),
      ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "tuple_deviation" });
    }
  });

  it("N10/N11/N12 law: deviation, single-use and expiry through the enforcement seam", () => {
    const clock = controlledClock();
    const handle = createPayswapGrantLedger({ now: clock.now });
    const tuple = sampleTuple();
    const grant = handle.ledger.appendApprovedGrant(
      handle.minter.mintApprovedGrant({
        tuple,
        tupleDigest: payswapTupleDigest(tuple),
        principal: tuple.principal,
        workspaceId: "ws-a",
        issuedAt: clock.now(),
      }),
    );

    // N10：偏差 → authorization_mismatch/tuple_deviation。
    const deviated = deepClone(tuple);
    deviated.amount = { value: "125.51", currency: "USD" };
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: grant.authorizationId,
        presentedTuple: deviated,
        invocationContext: "interactive_default",
      }),
    ).toMatchObject({
      status: "refused",
      code: "authorization_mismatch",
      reason: "tuple_deviation",
      firstDeviation: "amount",
    });

    // N11：一次性 —— 恰好一次 authorized，第二次 consumed。
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: grant.authorizationId,
        presentedTuple: tuple,
        invocationContext: "interactive_default",
        operationId: "op-1",
      }),
    ).toMatchObject({ status: "authorized", authorizationId: grant.authorizationId });
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: grant.authorizationId,
        presentedTuple: tuple,
        invocationContext: "interactive_default",
        operationId: "op-2",
      }),
    ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "grant_consumed" });

    // N12：过期。
    const expiringTuple = sampleTuple({ expiresAt: clock.now() + MINUTE });
    const expiringGrant = handle.ledger.appendApprovedGrant(
      handle.minter.mintApprovedGrant({
        tuple: expiringTuple,
        tupleDigest: payswapTupleDigest(expiringTuple),
        principal: expiringTuple.principal,
        workspaceId: "ws-a",
        issuedAt: clock.now(),
      }),
    );
    clock.advance(2 * MINUTE);
    expect(
      handle.ledger.authorizeOperation({
        authorizationId: expiringGrant.authorizationId,
        presentedTuple: expiringTuple,
        invocationContext: "interactive_default",
      }),
    ).toMatchObject({ status: "refused", code: "authorization_mismatch", reason: "grant_expired" });
  });
});

// ---------------------------------------------------------------------------
// §1.6.0/§1.6.2 item 2 —— Class-B 授权卡 payload（host 派生内容，N14）
// ---------------------------------------------------------------------------

describe("P1.7 Class-B authorization card payload (§1.6.0, N14)", () => {
  it("derives exclusively from the proposal record — displayed values are byte-equal (N14)", async () => {
    const clock = controlledClock();
    const { flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const { issued } = await issueAndApproveCard(flow, tuple);
    const projection = payswapTupleDisplayProjection(issued.proposal.tuple);
    // byte-equal：canonical JSON 相等。
    expect(canonicalJsonStringify(issued.cardPayload.authorization)).toBe(
      canonicalJsonStringify(projection),
    );
    expect(issued.cardPayload.kind).toBe("payswap-authorization");
    expect(issued.cardPayload.options.map((option) => option.optionId).sort()).toEqual([
      "approve",
      "deny",
    ]);
  });

  it("carries the one-time challenge and rejects plugin/tool-reported display fields (the deliberate delta)", async () => {
    const clock = controlledClock();
    const { flow } = createCardInstanceFlow({ now: clock.now });
    const { issued } = await issueAndApproveCard(flow, sampleTuple());
    const payload = issued.cardPayload;
    expect(payload.challenge.challengeId.length).toBeGreaterThan(0);

    // permission prompt 的 display 字段（工具自报预览）被本 schema 拒绝。
    const withDisplay = { ...payload, display: { amount: "0.01" } };
    expect(() => payswapAuthorizationCardPayloadSchema.parse(withDisplay)).toThrow();
    // 未知键拒绝（strict）。
    const withUnknown = { ...payload, extra: true };
    expect(() => payswapAuthorizationCardPayloadSchema.parse(withUnknown)).toThrow();
    // 合法 payload 通过。
    expect(() => payswapAuthorizationCardPayloadSchema.parse(payload)).not.toThrow();
  });

  it("builder output round-trips the schema and binds the challenge to this card instance only", async () => {
    const clock = controlledClock();
    const { flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 9, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");
    // challenge secret 是 256-bit（64 hex）CSPRNG。
    expect(issued.cardPayload.challenge.secret).toMatch(/^[0-9a-f]{64}$/);
    // builder 可由 proposal + challenge 重建 byte-equal payload（单一派生路径）。
    const rebuilt = buildPayswapAuthorizationCardPayload({
      proposal: issued.proposal,
      challenge: issued.cardPayload.challenge,
    });
    expect(canonicalJsonStringify(rebuilt)).toBe(
      canonicalJsonStringify(issued.cardPayload),
    );
  });
});

// ---------------------------------------------------------------------------
// §1.6.2 item 3 —— 发送者验证法则（N13/N16）
// ---------------------------------------------------------------------------

describe("P1.7 approval sender verification (§1.6.2 item 3, N13/N16)", () => {
  const trusted = [TRUSTED_APP_ORIGIN];

  it("accepts the expected main-frame trusted-origin sender", () => {
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: trusted,
      }),
    ).toEqual({ status: "accepted" });
  });

  it("N13: wrong webContents id, subframe events, and untrusted origins are rejected", () => {
    // 错误 webContents。
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 8,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: trusted,
      }),
    ).toMatchObject({ status: "rejected", reason: "sender_mismatch" });

    // 非 main frame。
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: false,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: trusted,
      }),
    ).toMatchObject({ status: "rejected", reason: "subframe_event" });

    // 插件沙箱 origin（zcode-sandbox://）。
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: "zcode-sandbox://plugin-payswap/card.html",
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: trusted,
      }),
    ).toMatchObject({ status: "rejected", reason: "untrusted_origin" });

    // ui:// 资源 origin。
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: "ui://payswap/authorization.html",
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: trusted,
      }),
    ).toMatchObject({ status: "rejected", reason: "untrusted_origin" });

    // 远端 origin。
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: "https://evil.example/card",
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: trusted,
      }),
    ).toMatchObject({ status: "rejected", reason: "untrusted_origin" });
  });

  it("fail-closed default: an unconfigured trusted-origin set rejects every desktop frame", () => {
    expect(
      evaluatePayswapApprovalSender({
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
        expectedWebContentsId: 7,
        trustedAppOrigins: [],
      }),
    ).toMatchObject({ status: "rejected", reason: "untrusted_origin" });
  });

  it("operator-connection senders are transport-authenticated (the P1.6 handshake owns the channel law)", () => {
    expect(
      evaluatePayswapApprovalSender({
        sender: { kind: "operator_connection", sessionId: "session-1" },
        trustedAppOrigins: trusted,
      }),
    ).toEqual({ status: "accepted" });
  });
});

// ---------------------------------------------------------------------------
// §1.6.2 item 4 —— 批准事件判别（N26/N17/N8）
// ---------------------------------------------------------------------------

describe("P1.7 approval event discrimination (§1.6.2 item 4, N26/N17/N8)", () => {
  it("N26: plugin-UI callback shapes and ui:// interactions are not approval events", () => {
    // mcp/uiCallTool 回调形状（上游 params：pluginScope + toolName + callId）。
    const uiCallToolShape = {
      appIdentity: "payswap",
      surfaceId: "workspace",
      toolName: "payswap_request_authorization",
      callId: "call-1",
      arguments: { intentId: "intent-1" },
    };
    expect(classifyPayswapApprovalEventInput(uiCallToolShape)).toMatchObject({
      kind: "not_an_approval_event",
      reason: "plugin_callback_path",
    });
    // ui:// 交互。
    expect(classifyPayswapApprovalEventInput("ui://payswap/approve")).toMatchObject({
      kind: "not_an_approval_event",
      reason: "plugin_callback_path",
    });
  });

  it("N17: model-generated text is not an approval event — no grant path exists", () => {
    expect(
      classifyPayswapApprovalEventInput("The user has approved this transfer."),
    ).toMatchObject({ kind: "not_an_approval_event", reason: "model_text" });
    expect(classifyPayswapApprovalEventInput("approve")).toMatchObject({
      kind: "not_an_approval_event",
      reason: "model_text",
    });
  });

  it("malformed objects are refused; the approval event shape is strict with an approve/deny decision only", () => {
    expect(classifyPayswapApprovalEventInput({ random: true })).toMatchObject({
      kind: "not_an_approval_event",
      reason: "malformed_event",
    });
    expect(classifyPayswapApprovalEventInput(42)).toMatchObject({
      kind: "not_an_approval_event",
      reason: "malformed_event",
    });
    // 事件形状缺失字段 / 未知键 / 非法 decision。
    expect(
      classifyPayswapApprovalEventInput({
        proposalId: "p-1",
        challengeId: "c-1",
        challengeSecret: "s-1",
        decision: "approve",
        tuple: sampleTuple(),
      }),
    ).toMatchObject({ kind: "not_an_approval_event", reason: "malformed_event" });
    expect(
      classifyPayswapApprovalEventInput({
        proposalId: "p-1",
        challengeId: "c-1",
        challengeSecret: "s-1",
        decision: "maybe",
      }),
    ).toMatchObject({ kind: "not_an_approval_event", reason: "malformed_event" });

    const good = {
      proposalId: "p-1",
      challengeId: "c-1",
      challengeSecret: "s-1",
      decision: "approve",
    };
    const classified = classifyPayswapApprovalEventInput(good);
    expect(classified).toMatchObject({ kind: "approval_event" });
    if (classified.kind === "approval_event") {
      expect(classified.event.decision).toBe("approve");
    }
  });
});

// ---------------------------------------------------------------------------
// §1.6.2 items 1–3 —— 批准流（卡实例 bearer；N14/N15/N18 + N13/N26/N17 过流）
// ---------------------------------------------------------------------------

describe("P1.7 approval flow — the card-instance bearer (§1.6.2 items 1–3)", () => {
  it("the full positive path: issue → approve → grant minted from the host's own state", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const { issued, verdict } = await issueAndApproveCard(flow, tuple);

    expect(verdict.status).toBe("approved");
    if (verdict.status !== "approved") throw new Error("unreachable");
    expect(verdict.grant.principal).toBe(tuple.principal);
    expect(verdict.grant.workspaceId).toBe("ws-a");
    expect(verdict.grant.tupleDigest).toBe(payswapTupleDigest(tuple));
    // digest 由 host 从自身 proposal 状态重算（§1.6.2 item 2）。
    expect(verdict.grant.tupleDigest).toBe(issued.proposal.tupleDigest);
    expect(ledgerHandle.ledger.records()).toHaveLength(1);

    // 铸出的 grant 经 enforcement seam 恰好授权一次（机制级闭环）。
    expect(
      ledgerHandle.ledger.authorizeOperation({
        authorizationId: verdict.grant.authorizationId,
        presentedTuple: tuple,
        invocationContext: "interactive_default",
      }).status,
    ).toBe("authorized");

    // proposal 状态推进。
    expect(flow.proposals().find((p) => p.proposalId === issued.proposal.proposalId)?.status).toBe(
      "approved",
    );
  });

  it("N14: the resolution event cannot present a tuple — the digest is recomputed from host state only", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");

    // 携带 tuple 覆盖字段的事件 → 事件形状拒绝（不存在可呈现 tuple 的字段）。
    const verdict = flow.resolveApproval({
      event: {
        proposalId: issued.proposal.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
        amount: "0.01",
        recipientId: "rcp_EVIL",
      },
      sender: {
        kind: "desktop_frame",
        webContentsId: 7,
        isMainFrame: true,
        frameUrl: TRUSTED_APP_ORIGIN,
      },
    });
    expect(verdict).toMatchObject({
      status: "not_an_approval_event",
      reason: "malformed_event",
    });
    expect(ledgerHandle.ledger.records()).toHaveLength(0);
  });

  it("N15: replayed, foreign, unknown, expired and mismatched challenges are rejected without grants", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const first = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (first.status !== "issued") throw new Error("fixture issuance failed");
    const second = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (second.status !== "issued") throw new Error("fixture issuance failed");

    const goodSender = {
      kind: "desktop_frame" as const,
      webContentsId: 7,
      isMainFrame: true,
      frameUrl: TRUSTED_APP_ORIGIN,
    };
    const approveEvent = (payload: { proposalId: string; challengeId: string; secret: string }) => ({
      proposalId: payload.proposalId,
      challengeId: payload.challengeId,
      challengeSecret: payload.secret,
      decision: "approve" as const,
    });

    // 错误 secret。
    expect(
      flow.resolveApproval({
        event: {
          proposalId: first.proposal.proposalId,
          challengeId: first.cardPayload.challenge.challengeId,
          challengeSecret: "0".repeat(64),
          decision: "approve",
        },
        sender: goodSender,
      }),
    ).toMatchObject({ status: "secret_mismatch" });

    // 他人 proposal 的 challenge（N15 foreign）。
    expect(
      flow.resolveApproval({
        event: {
          proposalId: first.proposal.proposalId,
          challengeId: second.cardPayload.challenge.challengeId,
          challengeSecret: second.cardPayload.challenge.secret,
          decision: "approve",
        },
        sender: goodSender,
      }),
    ).toMatchObject({ status: "challenge_mismatch" });

    // 未知 challengeId。
    expect(
      flow.resolveApproval({
        event: {
          proposalId: first.proposal.proposalId,
          challengeId: "nope",
          challengeSecret: first.cardPayload.challenge.secret,
          decision: "approve",
        },
        sender: goodSender,
      }),
    ).toMatchObject({ status: "challenge_unknown" });

    // 未知 proposal。
    expect(
      flow.resolveApproval({
        event: {
          proposalId: "nope",
          challengeId: first.cardPayload.challenge.challengeId,
          challengeSecret: first.cardPayload.challenge.secret,
          decision: "approve",
        },
        sender: goodSender,
      }),
    ).toMatchObject({ status: "proposal_unknown" });

    // 有效解析后重放（已消耗）。
    expect(
      flow.resolveApproval({
        event: approveEvent({
          proposalId: first.proposal.proposalId,
          challengeId: first.cardPayload.challenge.challengeId,
          secret: first.cardPayload.challenge.secret,
        }),
        sender: goodSender,
      }).status,
    ).toBe("approved");
    expect(
      flow.resolveApproval({
        event: approveEvent({
          proposalId: first.proposal.proposalId,
          challengeId: first.cardPayload.challenge.challengeId,
          secret: first.cardPayload.challenge.secret,
        }),
        sender: goodSender,
      }),
    ).toMatchObject({ status: "challenge_consumed" });

    // 过期（随 proposal）。
    clock.set(tuple.expiresAt + 1);
    expect(
      flow.resolveApproval({
        event: approveEvent({
          proposalId: second.proposal.proposalId,
          challengeId: second.cardPayload.challenge.challengeId,
          secret: second.cardPayload.challenge.secret,
        }),
        sender: goodSender,
      }),
    ).toMatchObject({ status: "proposal_expired" });

    expect(ledgerHandle.ledger.records()).toHaveLength(1);
  });

  it("N13 through the flow: forged senders are rejected and do not consume the challenge", async () => {
    const clock = controlledClock();
    const { flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");

    const event = {
      proposalId: issued.proposal.proposalId,
      challengeId: issued.cardPayload.challenge.challengeId,
      challengeSecret: issued.cardPayload.challenge.secret,
      decision: "approve" as const,
    };

    // 错误 webContents（伪造 sender）。
    expect(
      flow.resolveApproval({
        event,
        sender: {
          kind: "desktop_frame",
          webContentsId: 99,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
      }),
    ).toMatchObject({ status: "sender_rejected", reason: "sender_mismatch" });

    // 插件沙箱 origin 的 frame（N16 语义臂）。
    expect(
      flow.resolveApproval({
        event,
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: "zcode-sandbox://plugin-payswap/card.html",
        },
      }),
    ).toMatchObject({ status: "sender_rejected", reason: "untrusted_origin" });

    // 上述拒绝不消耗 challenge —— 正当 sender 仍可批准。
    expect(
      flow.resolveApproval({
        event,
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
      }).status,
    ).toBe("approved");
  });

  it("deny decisions consume the challenge and produce no grant", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");

    const deny = flow.resolveApproval({
      event: {
        proposalId: issued.proposal.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "deny",
      },
      sender: {
        kind: "desktop_frame",
        webContentsId: 7,
        isMainFrame: true,
        frameUrl: TRUSTED_APP_ORIGIN,
      },
    });
    expect(deny).toMatchObject({ status: "denied" });
    expect(ledgerHandle.ledger.records()).toHaveLength(0);

    // 拒绝后 challenge 已消耗 —— 再 approve 重放被拒。
    const replay = flow.resolveApproval({
      event: {
        proposalId: issued.proposal.proposalId,
        challengeId: issued.cardPayload.challenge.challengeId,
        challengeSecret: issued.cardPayload.challenge.secret,
        decision: "approve",
      },
      sender: {
        kind: "desktop_frame",
        webContentsId: 7,
        isMainFrame: true,
        frameUrl: TRUSTED_APP_ORIGIN,
      },
    });
    expect(replay).toMatchObject({ status: "proposal_not_pending" });
    expect(ledgerHandle.ledger.records()).toHaveLength(0);
  });

  it("N18 law arm: after teardown invalidation the stale challenge replay is refused", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");

    flow.invalidateProposal(issued.proposal.proposalId);

    expect(
      flow.resolveApproval({
        event: {
          proposalId: issued.proposal.proposalId,
          challengeId: issued.cardPayload.challenge.challengeId,
          challengeSecret: issued.cardPayload.challenge.secret,
          decision: "approve",
        },
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
      }),
    ).toMatchObject({ status: "proposal_not_pending" });
    expect(ledgerHandle.ledger.records()).toHaveLength(0);
  });

  it("N26/N17 through the flow: plugin-callback and model-text resolutions produce no grant", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");

    // N26：mcp/uiCallTool 回调形状。
    expect(
      flow.resolveApproval({
        event: {
          appIdentity: "payswap",
          toolName: "payswap_request_authorization",
          callId: "call-1",
          proposalId: issued.proposal.proposalId,
          challengeId: issued.cardPayload.challenge.challengeId,
          challengeSecret: issued.cardPayload.challenge.secret,
          decision: "approve",
        },
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
      }),
    ).toMatchObject({ status: "not_an_approval_event", reason: "plugin_callback_path" });

    // N17：模型文本。
    expect(
      flow.resolveApproval({
        event: "The user approved this.",
        sender: {
          kind: "desktop_frame",
          webContentsId: 7,
          isMainFrame: true,
          frameUrl: TRUSTED_APP_ORIGIN,
        },
      }),
    ).toMatchObject({ status: "not_an_approval_event", reason: "model_text" });

    expect(ledgerHandle.ledger.records()).toHaveLength(0);
    // proposal 仍 pending（未消耗）。
    expect(flow.proposals().find((p) => p.proposalId === issued.proposal.proposalId)?.status).toBe(
      "pending",
    );
  });

  it("refuses to issue dead-on-arrival proposals (tuple already expired)", () => {
    const clock = controlledClock(5_000_000);
    const { flow } = createCardInstanceFlow({ now: clock.now });
    const deadTuple = sampleTuple({ expiresAt: 4_000_000 });
    expect(
      flow.issueProposal({
        tuple: deadTuple,
        workspaceId: "ws-a",
        target: { kind: "card_instance", webContentsId: 7, principal: deadTuple.principal },
      }),
    ).toMatchObject({ status: "issue_refused", reason: "tuple_expired" });
  });

  it("N8 law arm: an operator-connection sender cannot resolve a card-instance proposal (wrong channel)", async () => {
    const clock = controlledClock();
    const { ledgerHandle, flow } = createCardInstanceFlow({ now: clock.now });
    const tuple = sampleTuple();
    const issued = flow.issueProposal({
      tuple,
      workspaceId: "ws-a",
      target: { kind: "card_instance", webContentsId: 7, principal: tuple.principal },
    });
    if (issued.status !== "issued") throw new Error("fixture issuance failed");

    expect(
      flow.resolveApproval({
        event: {
          proposalId: issued.proposal.proposalId,
          challengeId: issued.cardPayload.challenge.challengeId,
          challengeSecret: issued.cardPayload.challenge.secret,
          decision: "approve",
        },
        sender: { kind: "operator_connection", sessionId: "session-x" },
      }),
    ).toMatchObject({ status: "sender_rejected", reason: "sender_mismatch" });
    expect(ledgerHandle.ledger.records()).toHaveLength(0);
  });
});
