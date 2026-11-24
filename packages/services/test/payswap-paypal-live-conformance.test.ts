/**
 * PaySwap P3 provider half —— PayPal sandbox LIVE conformance（真实
 * api-m.sandbox.paypal.com 网络）。`ZCODE_PAYSWAP_PAYPAL_SANDBOX_CLIENT_ID` /
 * `ZCODE_PAYSWAP_PAYPAL_SANDBOX_SECRET` 缺席时整组跳过：CI / 电池保持零网络；
 * live 腿只在操作者经 env 供给 sandbox 凭据对时运行（凭据绝不入库、绝不入日志、
 * 绝不入证据 —— 证据只落结局状态形状）。
 *
 * 被钉住的验收行（每行都是 P3 只读契约的真实 API 证明；ADR-P2-1 修订 2026-11-24）：
 * 1. **connect**：client-credentials 凭据对（clientId + client secret + 声明
 *    mode）→ connected（mode test）—— connect 零网络触达。
 * 2. **verified 行**：真实 token 交换（POST /v1/oauth2/token，Basic 凭据对）
 *    → 200 + app_id → read-back `verified`（providerAccountId = 官方 app_id
 *    —— PayPal 有官方身份事实源，恢复行成立）+ typed 能力缺口（官方 REST API
 *    无能力读回面 —— 绝不伪造能力证据），状态 connected。
 * 3. **概览 = 生产路径上的四类别对话读**：getOverviewData（真实 runtime 的读回
 *    路由 + 数据路由）→ detail 携 typed 能力缺口，四类别照读、各自 typed 作答 ——
 *    全新 sandbox 账户的真实空态：balance / payment_objects 的官方封套键
 *    （balances / transaction_details）缺席 → adapter fail-closed typed
 *    unavailable（无伪造空投影；账户携带数据时的 ok 行为已由单元电池钉住）；
 *    disputes 封套在场（items: []）→ ok 空行投影；customers → refused
 *    （unsupported_operation —— 官方无列表端点，provider 缺席事实，零触达）。
 * 4. **安全行**：伪造 secret 对 → 真实 401（token 端点）→ expired（唯一
 *    expiry 证据）。
 * 5. **at-rest**：连接记录 store 永不携带凭据材料。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPayswapAccountRuntime, setDataBaseDir } from "@zcode/services/node";
import {
  PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY,
  payswapAccountOverviewDetailSchema,
} from "@zcode/shared/payswap";
import { afterAll, describe, expect, it } from "vitest";

const LIVE_CLIENT_ID = (process.env.ZCODE_PAYSWAP_PAYPAL_SANDBOX_CLIENT_ID ?? "").trim();
const LIVE_CLIENT_SECRET = (process.env.ZCODE_PAYSWAP_PAYPAL_SANDBOX_SECRET ?? "").trim();
const BOGUS_SECRET = "EXbogus" + "0".repeat(48);

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

(LIVE_CLIENT_ID && LIVE_CLIENT_SECRET ? describe : describe.skip)(
  "payswap paypal sandbox LIVE conformance (real api-m.sandbox.paypal.com; env-provisioned pair only)",
  () => {
    it("pins the four acceptance rows against the real PayPal sandbox API", async () => {
      const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paypal-live-"));
      createdDirs.push(dir);
      setDataBaseDir(dir);
      const connectionsPath = join(dir, "payswap-connections.json");
      // 真实运行时：无 apiClient 注入（缺省 = globalThis.fetch + 超时执行）、
      // 真实 sandbox 基址（shared authSpec pin）、store 落临时目录（用后即删）。
      const runtime = createPayswapAccountRuntime({
        env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "d".repeat(64) },
        resolveStorePath: () => connectionsPath,
      });

      // ---- 行 1：connect（凭据对；零网络触达）----
      const connected = await runtime.accountService.connect({
        providerId: "paypal",
        operatorSecret: LIVE_CLIENT_SECRET,
        clientId: LIVE_CLIENT_ID,
        mode: "test",
      });
      expect(connected.kind).toBe("connected");
      if (connected.kind !== "connected") return;
      expect(connected.connection.providerId).toBe("paypal");
      expect(connected.connection.mode).toBe("test");
      const connectionId = connected.connection.connectionId;

      // ---- 行 2：verified 行（真实 token 交换 + 官方 app_id 身份 + typed 能力缺口）----
      const verifiedRow = await runtime.accountService.refreshEvidence({ connectionId });
      expect(verifiedRow.kind).toBe("verified");
      if (verifiedRow.kind === "verified") {
        expect(typeof verifiedRow.providerAccountId).toBe("string");
        expect((verifiedRow.providerAccountId ?? "").length).toBeGreaterThan(0);
        // PayPal 有官方身份面（app_id）—— 绝不声明身份缺口。
        expect("identityGap" in verifiedRow).toBe(false);
        expect(verifiedRow.connection.status).toBe("connected");
        expect(JSON.stringify(verifiedRow).includes(LIVE_CLIENT_SECRET)).toBe(false);
      }
      const afterVerify = await runtime.accountService.listConnections();
      expect(afterVerify.find((c) => c.connectionId === connectionId)?.status).toBe("connected");

      // ---- 行 3：概览 = 生产路径上的四类别对话读（typed 能力缺口在场 → 类别照读）----
      const overviewRow = await runtime.accountService.getOverviewData({ connectionId });
      expect(overviewRow.kind).toBe("detail");
      if (overviewRow.kind === "detail") {
        expect(overviewRow.capabilityRefusal?.code).toBe("capability_evidence_not_exposed");
        expect("evidence" in overviewRow).toBe(false);
        // 跨进程值：桥两端同一份 strict 法则（含 JSON 往返）。
        expect(payswapAccountOverviewDetailSchema.safeParse(overviewRow).success).toBe(true);
        expect(
          payswapAccountOverviewDetailSchema.safeParse(JSON.parse(JSON.stringify(overviewRow))).success,
        ).toBe(true);

        // 全新 sandbox 账户的真实空态：官方封套的 balances 键缺席 → adapter
        // fail-closed typed unavailable（无伪造空投影）。
        expect(overviewRow.data.balance.status).toBe("unavailable");
        // 同款真实空态：transaction_details 键缺席 → typed unavailable。
        expect(overviewRow.data.payment_objects.status).toBe("unavailable");
        // customers：官方无列表端点 —— 零触达直拒（provider 缺席事实，pin 在案）。
        expect(overviewRow.data.customers.status).toBe("refused");
        if (overviewRow.data.customers.status === "refused") {
          expect(overviewRow.data.customers.refusal.code).toBe("unsupported_operation");
        }
        expect(overviewRow.data.disputes.status).toBe("ok");
        if (overviewRow.data.disputes.status === "ok") {
          expect(Array.isArray(overviewRow.data.disputes.data)).toBe(true);
        }
        expect(JSON.stringify(overviewRow).includes(LIVE_CLIENT_SECRET)).toBe(false);
      }

      // ---- 行 4：安全行（伪造 secret 对 → 真实 401 → expired）----
      const bogus = await runtime.accountService.connect({
        providerId: "paypal",
        operatorSecret: BOGUS_SECRET,
        clientId: LIVE_CLIENT_ID,
        mode: "test",
      });
      expect(bogus.kind).toBe("connected");
      if (bogus.kind !== "connected") return;
      const bogusId = bogus.connection.connectionId;
      const expiredRow = await runtime.accountService.refreshEvidence({ connectionId: bogusId });
      expect(expiredRow.kind).toBe("expired");
      const afterExpiry = await runtime.accountService.listConnections();
      expect(afterExpiry.find((c) => c.connectionId === bogusId)?.status).toBe("expired");

      // ---- 行 5：at-rest（记录 store 永不携带凭据材料）----
      const rawConnections = await readFile(connectionsPath, "utf-8");
      expect(rawConnections.includes(LIVE_CLIENT_SECRET)).toBe(false);
      expect(rawConnections.includes(LIVE_CLIENT_ID)).toBe(false);
      expect(rawConnections.includes(BOGUS_SECRET)).toBe(false);
    });
  },
);
