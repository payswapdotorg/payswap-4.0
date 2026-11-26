/**
 * PaySwap P4 wave 6 —— blockchain constraint tail and wallet association law.
 *
 * This battery pins the remaining eligibility dimensions, fee-cap adjudication,
 * wallet-to-principal association, and the existing no-authority boundary.
 */
import { describe, expect, it } from "vitest";
import {
  payswapWalletAddressControlEvidenceSchema,
  payswapWalletAssociationSchema,
  payswapVerifiedRecipientEvidenceSchema,
  payswapSenderAccountRefSchema,
  payswapParticipantCapabilityEvidenceSchema,
} from "@zcode/shared/payswap";
import {
  createPayswapCapabilityRegistry,
  derivePayswapCapabilityRecord,
  evaluatePayswapEligibility,
  payswapCapabilityRestrictionSchema,
  payswapEligibilityConstraintsSchema,
  type PayswapCapabilityRecord,
  type PayswapEligibilityQuery,
} from "@zcode/services/node";

const NOW = "2026-11-26T12:00:00.000Z";
const DIMENSIONS = ["token", "wallet", "destination", "contractOperation", "feeCap", "finality"] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Restriction = PayswapCapabilityRecord["operations"][number]["restrictions"][number];

function baseRecord(): PayswapCapabilityRecord {
  const registry = createPayswapCapabilityRegistry();
  const record = derivePayswapCapabilityRecord({
    providerId: "stripe",
    connectionId: "conn-tail-1",
    outcome: {
      kind: "verified",
      providerAccountId: "acct_1",
      evidence: {
        capabilities: [
          { name: "card_payments", status: "active" },
          { name: "payouts", status: "active" },
        ],
        requirements: { disabledReason: null, currentlyDueCount: 0, pastDueCount: 0 },
      },
    },
    now: NOW,
  });
  if (record === null) throw new Error("base capability record derivation returned null");
  return registry.declare(record);
}

function withRestrictions(base: PayswapCapabilityRecord, restrictions: readonly Restriction[]): PayswapCapabilityRecord {
  return {
    ...base,
    operations: base.operations.map((operation) =>
      operation.operation === "collections.read"
        ? { ...operation, restrictions: [...operation.restrictions, ...restrictions] }
        : operation,
    ),
  };
}

function eligibilityQuery(constraints: Record<string, string>): PayswapEligibilityQuery {
  return {
    operation: "collections.read",
    connectionId: "conn-tail-1",
    constraints,
  };
}

function walletAssociation() {
  return {
    kind: "wallet-association",
    wallet: {
      address: "0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5",
      chainId: "eip155:1",
    },
    principalId: "principal-1",
    workspaceId: "workspace-1",
    proof: {
      evidenceRef: "evd-wallet-1",
      source: "address-proof-of-control",
      verifiedAt: NOW,
      challengeId: "chal-0001",
    },
    freshnessBoundMs: 3_600_000,
  };
}

describe("payswap chain-tail constraints (P4 wave 6)", () => {
  it("T1: admits exactly the six remaining dimensions and validates feeCap as a nonnegative integer string", () => {
    const constraints = {
      token: "eip155:1/erc20:0xabc",
      wallet: "0x95222290DD7278Aa3Ddd389Cc1E1d165CC4BAfe5",
      destination: "0x1111111111111111111111111111111111111111",
      contractOperation: "transfer",
      feeCap: "0",
      finality: "safe",
    };
    expect(payswapEligibilityConstraintsSchema.safeParse(constraints).success).toBe(true);
    for (const invalid of ["-1", "+1", "1.0", " 1", ""]) {
      expect(payswapEligibilityConstraintsSchema.safeParse({ feeCap: invalid }).success).toBe(false);
    }
    expect(payswapEligibilityConstraintsSchema.safeParse({ network: "mainnet" }).success).toBe(false);
    expect(payswapEligibilityConstraintsSchema.safeParse({ gas: "100" }).success).toBe(false);
  });

  it("T2: adds only dimension-name restriction kinds while preserving rate-limit", () => {
    for (const kind of DIMENSIONS) {
      expect(payswapCapabilityRestrictionSchema.safeParse({ kind, allow: ["x"] }).success).toBe(true);
    }
    expect(payswapCapabilityRestrictionSchema.safeParse({ kind: "rate-limit", note: "historical blocker" }).success).toBe(true);
    for (const kind of ["network", "gas", "contract-operation", "fee-cap"]) {
      expect(payswapCapabilityRestrictionSchema.safeParse({ kind }).success).toBe(false);
    }
  });

  it("T3: refuses each carried dimension when the capability record has no matching structured evidence", () => {
    for (const dimension of DIMENSIONS) {
      const result = evaluatePayswapEligibility({
        query: eligibilityQuery({ [dimension]: dimension === "feeCap" ? "10" : `${dimension}-value` }),
        record: baseRecord(),
        now: NOW,
      });
      expect(result.kind, dimension).toBe("refused");
      if (result.kind === "refused") {
        expect(result.refused.code, dimension).toBe("eligibility_constraint_unevidenced");
        expect(result.refused.message, dimension).toContain(dimension);
      }
    }
  });

  it("T4: applies same-name deny and allow restrictions to every dimension", () => {
    for (const dimension of DIMENSIONS) {
      const value = dimension === "feeCap" ? "15" : `${dimension}-value`;
      const denied = evaluatePayswapEligibility({
        query: eligibilityQuery({ [dimension]: value }),
        record: withRestrictions(baseRecord(), [{ kind: dimension, deny: [value] }]),
        now: NOW,
      });
      expect(denied.kind, `${dimension} deny`).toBe("answer");
      if (denied.kind === "answer") {
        expect(denied.eligible, `${dimension} deny`).toBe(false);
        expect(denied.blockers.some((blocker) => blocker.kind === dimension), `${dimension} blocker`).toBe(true);
      }

      const notAllowed = evaluatePayswapEligibility({
        query: eligibilityQuery({ [dimension]: value }),
        record: withRestrictions(baseRecord(), [{ kind: dimension, allow: ["different-value"] }]),
        now: NOW,
      });
      expect(notAllowed.kind, `${dimension} allow`).toBe("answer");
      if (notAllowed.kind === "answer") {
        expect(notAllowed.eligible, `${dimension} allow`).toBe(false);
        expect(notAllowed.blockers.some((blocker) => blocker.kind === dimension), `${dimension} blocker`).toBe(true);
      }
    }
  });

  it("T5: adjudicates feeCap bounds with BigInt while preserving amount messages", () => {
    const boundedRecord = withRestrictions(baseRecord(), [{ kind: "feeCap", min: "10", max: "20" }]);
    const below = evaluatePayswapEligibility({
      query: eligibilityQuery({ feeCap: "9" }),
      record: boundedRecord,
      now: NOW,
    });
    expect(below.kind).toBe("answer");
    if (below.kind === "answer") {
      expect(below.eligible).toBe(false);
      expect(below.blockers[0]).toMatchObject({ kind: "feeCap" });
      expect(below.blockers[0]?.note).toContain("feeCap=9");
      expect(below.blockers[0]?.note).toContain("below the evidenced minimum 10");
    }

    const above = evaluatePayswapEligibility({
      query: eligibilityQuery({ feeCap: "21" }),
      record: boundedRecord,
      now: NOW,
    });
    expect(above.kind).toBe("answer");
    if (above.kind === "answer") {
      expect(above.eligible).toBe(false);
      expect(above.blockers[0]?.note).toContain("feeCap=21");
      expect(above.blockers[0]?.note).toContain("above the evidenced maximum 20");
    }

    const atBoundaries = evaluatePayswapEligibility({
      query: eligibilityQuery({ feeCap: "10" }),
      record: boundedRecord,
      now: NOW,
    });
    expect(atBoundaries.kind).toBe("answer");
    if (atBoundaries.kind === "answer") expect(atBoundaries.eligible).toBe(true);

    const amountRecord = withRestrictions(baseRecord(), [{ kind: "amount", min: "10", max: "20" }]);
    const amountBelow = evaluatePayswapEligibility({
      query: eligibilityQuery({ amount: "9" }),
      record: amountRecord,
      now: NOW,
    });
    expect(amountBelow.kind).toBe("answer");
    if (amountBelow.kind === "answer") {
      expect(amountBelow.blockers[0]?.note).toBe("amount 9 below the evidenced minimum 10");
    }
  });

  it("T6: binds a canonical wallet address and proof to a principal and workspace", () => {
    expect(payswapWalletAssociationSchema.safeParse(walletAssociation()).success).toBe(true);
    expect(
      payswapWalletAssociationSchema.safeParse({
        ...walletAssociation(),
        wallet: { ...walletAssociation().wallet, chainId: "1" },
      }).success,
    ).toBe(false);
    expect(payswapWalletAssociationSchema.safeParse({ ...walletAssociation(), principalId: "" }).success).toBe(false);
    expect(payswapWalletAssociationSchema.safeParse({ ...walletAssociation(), workspaceId: "" }).success).toBe(false);
  });

  it("T7: rejects permission, allowance, mandate, and key-material fields at every strict boundary", () => {
    for (const field of ["signingPermission", "spendingLimit", "allowance", "mandate", "contractCallAuthorization"]) {
      expect(payswapWalletAssociationSchema.safeParse({ ...walletAssociation(), [field]: true }).success).toBe(false);
      expect(
        payswapWalletAssociationSchema.safeParse({
          ...walletAssociation(),
          wallet: { ...walletAssociation().wallet, [field]: true },
        }).success,
      ).toBe(false);
    }
    for (const field of ["privateKey", "seedPhrase", "mnemonic"]) {
      expect(payswapWalletAssociationSchema.safeParse({ ...walletAssociation(), [field]: "secret" }).success).toBe(false);
      expect(
        payswapWalletAssociationSchema.safeParse({
          ...walletAssociation(),
          proof: { ...walletAssociation().proof, [field]: "secret" },
        }).success,
      ).toBe(false);
    }
  });

  it("T8: keeps wallet association separate from the four evidence families", () => {
    const association = walletAssociation();
    const addressControl = {
      kind: "wallet-address-control",
      wallet: association.wallet,
      proof: association.proof,
      freshnessBoundMs: association.freshnessBoundMs,
    };
    expect(payswapWalletAddressControlEvidenceSchema.safeParse(association).success).toBe(false);
    expect(payswapWalletAssociationSchema.safeParse(addressControl).success).toBe(false);
    expect(payswapVerifiedRecipientEvidenceSchema.safeParse(association).success).toBe(false);
    expect(payswapSenderAccountRefSchema.safeParse(association).success).toBe(false);
    expect(payswapParticipantCapabilityEvidenceSchema.safeParse(association).success).toBe(false);
  });

  it("T9: leaves association as a strict identity/proof record, not an authority or connector surface", () => {
    const parsed = payswapWalletAssociationSchema.parse(walletAssociation());
    expect(parsed).toEqual(walletAssociation());
    expect(parsed).not.toHaveProperty("authorization");
    expect(parsed).not.toHaveProperty("permissions");
    expect(parsed).not.toHaveProperty("allowances");
    expect(payswapWalletAssociationSchema.safeParse({ ...walletAssociation(), connector: "provider" }).success).toBe(false);
  });
});
