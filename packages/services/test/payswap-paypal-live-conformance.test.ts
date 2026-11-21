/**
 * PaySwap P3 provider half —— PayPal sandbox LIVE conformance（真实
 * api-m.sandbox.paypal.com 网络）。`ZCODE_PAYSWAP_PAYPAL_SANDBOX_CLIENT_ID` /
 * `ZCODE_PAYSWAP_PAYPAL_SANDBOX_SECRET` 缺席时整组跳过：CI / 电池保持零网络；
 * live 腿只在操作者经 env 供给 sandbox 凭据对时运行（凭据绝不入库、绝不入日志、
 * 绝不入证据 —— 证据只落结局状态形状）。
 *
 * 被钉住的验收行（每行都是 P3 只读契约的真实 API 证明）：
 * 1. **connect**：client-credentials 凭据对（clientId + client secret + 声明
 *    mode）→ connected（mode test）—— connect 零网络触达。
 * 2. **verified 行**：真实 token 交换（POST /v1/oauth2/token，Basic 凭据对）
 *    → 200 + app_id → read-back `verified`（providerAccountId = 官方 app_id
 *    —— PayPal 有官方身份事实源，恢复行成立），状态 connected。
 * 3. **概览 detail**：getOverviewData 验证读通过 → 四类别真实读：
 *    - balance → ok（available 数组；ISO 4217 指数钉住，字符串数学无浮点）；
 *    - payment_objects → ok（GET /v1/reporting/transactions，必填窗口）；
 *    - customers → refused（unsupported_operation —— 官方无列表端点，
 *      provider 缺席事实）；
 *    - disputes → ok（GET /v1/customer/disputes）。
 * 4. **安全行**：伪造 secret 对 → 真实 401（token 端点）→ expired（唯一
 *    expiry 证据）。
 * 5. **at-rest**：连接记录 store 永不携带凭据材料。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPayswapAccountRuntime, setDataBaseDir } from "@zcode/services/node";
import { PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY } from "@zcode/shared/payswap";
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

      // ---- 行 2：verified 行（真实 token 交换 + 官方 app_id 身份）----
      const verifiedRow = await runtime.accountService.refreshEvidence({ connectionId });
      expect(verifiedRow.kind).toBe("verified");
      if (verifiedRow.kind === "verified") {
        expect(typeof verifiedRow.providerAccountId).toBe("string");
        expect(verifiedRow.providerAccountId.length).toBeGreaterThan(0);
        expect(verifiedRow.connection.status).toBe("connected");
      }
      const afterVerify = await runtime.accountService.listConnections();
      expect(afterVerify.find((c) => c.connectionId === connectionId)?.status).toBe("connected");

      // ---- 行 3：概览 detail（验证读通过 → 四类别真实读）----
      const detail = await runtime.accountService.getOverviewData({ connectionId });
      expect(detail.kind).toBe("detail");
      if (detail.kind !== "detail") return;
      expect(detail.connection.status).toBe("connected");

      const balance = detail.data.balance;
      expect(balance.status).toBe("ok");
      if (balance.status === "ok") {
        const balanceData = balance.data as { available: unknown[]; pending: unknown[] };
        expect(Array.isArray(balanceData.available)).toBe(true);
        expect(Array.isArray(balanceData.pending)).toBe(true);
      }

      const transactions = detail.data.payment_objects;
      expect(transactions.status).toBe("ok");
      if (transactions.status === "ok") {
        expect(Array.isArray(transactions.data)).toBe(true);
      }

      const customers = detail.data.customers;
      expect(customers.status).toBe("refused");
      if (customers.status === "refused") {
        expect(customers.refusal.code).toBe("unsupported_operation");
      }

      const disputes = detail.data.disputes;
      expect(disputes.status).toBe("ok");
      if (disputes.status === "ok") {
        expect(Array.isArray(disputes.data)).toBe(true);
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
