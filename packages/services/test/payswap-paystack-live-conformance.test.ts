/**
 * PaySwap P3 provider half —— Paystack test-mode LIVE conformance（真实
 * api.paystack.co 网络）。`ZCODE_PAYSWAP_PAYSTACK_TEST_KEY` 缺席时整组跳过：
 * CI / 电池保持零网络；live 腿只在操作者经 env 供给 test 秘钥时运行（键绝不
 * 入库、绝不入日志、绝不入证据 —— 证据只落结局状态形状）。
 *
 * 被钉住的验收行（每行都是 P3 只读契约的真实 API 证明）：
 * 1. **connect**：真实 sk_test 秘钥 → connected（mode test）—— connect 零网络
 *    触达（与单元电池同一装配行为）。
 * 2. **身份缺口行**：真实键 refreshEvidence → 真实 200 + status:true 封套 →
 *    typed `refused`（read_back_unavailable），状态保持 connected —— Paystack
 *    无官方自身份端点，凭据有效也绝不伪造身份（诚实纪律的真实 API 行）。
 * 3. **概览门（fail-closed）**：getOverviewData 的验证读同款身份缺口 → refused，
 *    四类别永不回答 —— 概览 detail 面在身份缺口 provider 上诚实拒绝。
 * 4. **数据面真实读**：数据端口持真实秘钥直读真实 API —— balance /
 *    payment_objects（GET /transaction）/ customers（GET /customer）= ok 投影
 *    （PII redaction-by-construction：customers 只落 customer_code + created）；
 *    disputes = pinned typed unavailable（官方条目无顶层 amount/currency/reason）。
 * 5. **安全行**：伪造 test 秘钥 refresh → 真实 401 → expired（唯一 expiry 证据
 *    —— 吊销/轮换的键被检出）。
 * 6. **at-rest**：连接记录 store 永不携带秘钥材料。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPaystackAccountDataReadPort,
  createPayswapAccountRuntime,
  setDataBaseDir,
} from "@zcode/services/node";
import { PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY } from "@zcode/shared/payswap";
import { afterAll, describe, expect, it } from "vitest";

const LIVE_KEY = (process.env.ZCODE_PAYSWAP_PAYSTACK_TEST_KEY ?? "").trim();
const BOGUS_KEY = `sk_test_${"0".repeat(40)}`;

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

(LIVE_KEY ? describe : describe.skip)(
  "payswap paystack test-mode LIVE conformance (real api.paystack.co; env-provisioned key only)",
  () => {
    it("pins the four acceptance rows against the real Paystack API", async () => {
      const dir = await mkdtemp(join(tmpdir(), "payswap-p3-paystack-live-"));
      createdDirs.push(dir);
      setDataBaseDir(dir);
      const connectionsPath = join(dir, "payswap-connections.json");
      // 真实运行时：无 apiClient 注入（缺省 = globalThis.fetch + 超时执行）、
      // 真实 api.paystack.co 基址（缺省）、store 落临时目录（用后即删）。
      // host-env 键 = Gate E2 解包键（合成 64 字符，与单元电池同款 —— legacy
      // 凭据文件在临时目录，用后即删；这不是 provider 秘钥）。
      const runtime = createPayswapAccountRuntime({
        env: { [PAYSWAP_PSP_CREDENTIAL_SECRET_ENV_KEY]: "d".repeat(64) },
        resolveStorePath: () => connectionsPath,
      });

      // ---- 行 1：connect（零网络触达；mode 由前缀推导）----
      const connected = await runtime.accountService.connect({
        providerId: "paystack",
        operatorSecret: LIVE_KEY,
      });
      expect(connected.kind).toBe("connected");
      if (connected.kind !== "connected") return;
      expect(connected.connection.providerId).toBe("paystack");
      expect(connected.connection.mode).toBe("test");
      const connectionId = connected.connection.connectionId;

      // ---- 行 2：身份缺口（真实 200 = typed refused；状态不变）----
      const gapRow = await runtime.accountService.refreshEvidence({ connectionId });
      expect(gapRow.kind).toBe("refused");
      if (gapRow.kind === "refused") {
        expect(gapRow.refusal.code).toBe("read_back_unavailable");
      }
      const afterGap = await runtime.accountService.listConnections();
      const gapConnection = afterGap.find((c) => c.connectionId === connectionId);
      expect(gapConnection?.status).toBe("connected");

      // ---- 行 3：概览门 fail-closed（四类别在身份缺口 provider 上不回答）----
      const overviewRow = await runtime.accountService.getOverviewData({ connectionId });
      expect(overviewRow.kind).toBe("refused");
      if (overviewRow.kind === "refused") {
        expect(overviewRow.refusal.code).toBe("read_back_unavailable");
      }

      // ---- 行 4：数据面真实读（端口直读真实 API；PII redaction-by-construction）----
      const dataPort = createPaystackAccountDataReadPort({});
      const baseInput = {
        providerId: "paystack",
        mode: "test",
        secretKind: "api-key",
      } as const;

      const balanceRow = await dataPort({ ...baseInput, secret: LIVE_KEY, category: "balance" });
      expect(balanceRow.status).toBe("ok");
      if (balanceRow.status === "ok") {
        const balance = balanceRow.data as { available: unknown[]; pending: unknown[] };
        expect(Array.isArray(balance.available)).toBe(true);
        expect(Array.isArray(balance.pending)).toBe(true);
      }

      const transactionsRow = await dataPort({
        ...baseInput,
        secret: LIVE_KEY,
        category: "payment_objects",
      });
      expect(transactionsRow.status).toBe("ok");
      if (transactionsRow.status === "ok") {
        expect(Array.isArray(transactionsRow.data)).toBe(true);
      }

      // customers：真实数据行只落 customer_code + created（email/name/phone
      // 绝不读取 —— 即便 provider 返回了它们）。
      const customersRow = await dataPort({ ...baseInput, secret: LIVE_KEY, category: "customers" });
      expect(customersRow.status).toBe("ok");
      if (customersRow.status === "ok") {
        for (const row of customersRow.data) {
          expect(Object.keys(row).sort()).toEqual(["created", "description", "id"]);
        }
      }

      // disputes：pinned typed unavailable（官方条目无顶层 amount/currency/reason
      // —— redacted dispute schema 不容伪造；官方检索日期在案）。
      const disputesRow = await dataPort({ ...baseInput, secret: LIVE_KEY, category: "disputes" });
      expect(disputesRow.status).toBe("unavailable");

      // ---- 行 5：安全行（伪造键 → 真实 401 → expired）----
      const bogus = await runtime.accountService.connect({
        providerId: "paystack",
        operatorSecret: BOGUS_KEY,
      });
      expect(bogus.kind).toBe("connected");
      if (bogus.kind !== "connected") return;
      const bogusId = bogus.connection.connectionId;
      const expiredRow = await runtime.accountService.refreshEvidence({ connectionId: bogusId });
      expect(expiredRow.kind).toBe("expired");
      const afterExpiry = await runtime.accountService.listConnections();
      expect(afterExpiry.find((c) => c.connectionId === bogusId)?.status).toBe("expired");

      // ---- 行 6：at-rest（记录 store 永不携带秘钥材料）----
      const rawConnections = await readFile(connectionsPath, "utf-8");
      expect(rawConnections.includes(LIVE_KEY)).toBe(false);
      expect(rawConnections.includes(BOGUS_KEY)).toBe(false);
    });
  },
);
