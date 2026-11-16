/**
 * PaySwap P3 —— PayPal 读回 adapter（doc 06 §2.9 provider 运行时的 PayPal 落地；
 * 事实清单 `docs/payswap/provider-facts/paypal.md` P-1..P-17 + 第三批检索
 * 2026-11-15，检索日期在案）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **端口实现**：client-credentials token mint（P-1，共享步 `oauth2.ts` ——
 *    wire 面单一事实源：HTTP Basic + grant_type=client_credentials；base URL
 *    由模式解析，P-3）。adapter 消费 mint 的证据字段：`app_id`（官方样例响应
 *    逐字在案，`APP-*` 形态）成为 `providerAccountId`（非秘密证据摘要 —— 与
 *    Stripe 的 `acct_*` 同位）。**不消费** access_token/expires_in/nonce：token
 *    只在本次调用内存中存在，端口无缓存无持久化（P-2 的「重用至过期」是运行
 *    时层关切，读回端口每次现铸）。
 * 2. **结局映射（doc 05 §6.4 读回纪律；共享步闭集的直传）**：
 *    - mint ok + 非空 `app_id` → `verified{providerAccountId}`；
 *    - **mint 401 → `auth-failed`**（P-4：sandbox 实测 401 包络
 *      `{"error":"invalid_client","error_description":"Client Authentication
 *      failed"}` —— provider 拒绝凭据，唯一能把连接状态翻到 `expired` 的证据）；
 *    - 其余一切（非 200/401 状态、非 JSON、缺 token/app_id、传输异常、超时）→
 *      `unavailable` —— unknown ≠ expired。
 * 3. **能力证据（doc 04 §1.2 evidence, never claims）**：token 响应的 `scope`
 *    列表（P-2 样例 + P-6 语义「shows all available permissions for your
 *    app」）逐项成为 capabilities（每项 status = active —— 授予清单上没有
 *    inactive/pending 的语义位，不发明）。`requirements` 是 PaySwap 投影的
 *    摘要位：PayPal 已验证读面无 requirements 等价物 → 中性零值编码「无
 *    requirements 读面」（投影语义，不是 PayPal 侧声明）。全有或全无：
 *    scope 缺席/畸形 → 省略 evidence（verified 的认证语义不受影响；概览
 *    detail 面对缺席证据 fail-closed 拒绝）。
 * 4. **装配防线（先于任何网络触达）**：`providerId ≠ "paypal"` / `secrets`
 *    键集 ≠ 恰 [client-id, client-secret] = 装配错误 → 抛出（accountService
 *    映射 typed 拒绝，状态不变 —— 安全且响亮）。
 * 5. **零秘密外泄**：client secret 只进 Basic 头（共享步）；任何 detail/message
 *    操作员可读且零凭据材料；本模块不日志、不持久化、不投影任何秘密。
 * 6. **IO 全注入**：transport 经 `ApiClient`（`@zcode/shared` 既有抽象）；
 *    缺省 = `globalThis.fetch` + AbortController 超时执行（缺省 10 s）。
 */

import type { ApiClient } from "@zcode/shared";
import {
  payswapAccountCapabilityEvidenceSchema,
  type PayswapAccountCapabilityEvidence,
  type PayswapAccountReadBackInput,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
} from "@zcode/shared/payswap";
import {
  createDefaultPayPalApiClient,
  mintPayPalAccessToken,
} from "./oauth2.js";

/** 缺省读回超时（用户面验证读回 —— 悬挂端点必须被切断，永不无限等待）。 */
const DEFAULT_READ_BACK_TIMEOUT_MS = 10_000;

export interface PayswapPayPalReadBackDependencies {
  /** HTTP transport（缺省 = globalThis.fetch + AbortController 超时执行）。 */
  apiClient?: ApiClient;
  /** 读回超时（缺省 10 s；随 init 传递给 transport —— 执行归实现）。 */
  timeoutMs?: number;
  /**
   * API 基 URL 覆盖（缺省 = 规格的 per-mode base URL，P-3；真连线/超时行可
   * 指向本地服务 —— tokenPath 仍取规格）。
   */
  apiBaseOverride?: string;
}

/**
 * 从 token 响应载荷捕获能力证据（P-2/P-6）：`scope` 空格分隔的 URI 列表 →
 * capabilities（全 active —— 授予清单语义）；requirements 中性零值（PayPal
 * 已验证读面无 requirements 面）。全有或全无：畸形/缺席 → null（省略 evidence）。
 */
function captureCapabilityEvidence(body: unknown): PayswapAccountCapabilityEvidence | null {
  const raw = body as { scope?: unknown } | null;
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.scope !== "string" || raw.scope.trim().length === 0) return null;
  const scopes = raw.scope
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (scopes.length === 0) return null;
  const evidence = {
    capabilities: scopes.map((name) => ({ name, status: "active" as const })),
    requirements: {
      disabledReason: null,
      currentlyDueCount: 0,
      pastDueCount: 0,
    },
  };
  const parsed = payswapAccountCapabilityEvidenceSchema.safeParse(evidence);
  return parsed.success ? parsed.data : null;
}

/**
 * 创建真实 PayPal 读回端口（`PayswapAccountReadBackPort` 的 PayPal 实现：
 * client-credentials token mint + 证据字段消费）。结局映射与装配防线见文件头
 * 法则；秘密只经参数入；token 只在共享步的本次调用内存中存在。
 */
export function createPayPalAccountReadBackPort(
  dependencies: PayswapPayPalReadBackDependencies = {},
): PayswapAccountReadBackPort {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_READ_BACK_TIMEOUT_MS;
  const apiClient = dependencies.apiClient ?? createDefaultPayPalApiClient(timeoutMs);

  return async (input: PayswapAccountReadBackInput): Promise<PayswapAccountReadBackOutcome> => {
    // 装配防线：provider/秘密键集路由错配 = 装配错误（fail-closed 抛出，零网络
    // 触达；accountService 映射 typed 拒绝，状态不变）。PayPal 规格恰
    // [client-id, client-secret]。
    if (input.providerId !== "paypal") {
      throw new Error(
        `The PayPal read-back adapter received a request for provider '${input.providerId}'; check the host wiring.`,
      );
    }
    const secretKeys = Object.keys(input.secrets).sort();
    if (
      secretKeys.length !== 2 ||
      secretKeys[0] !== "client-id" ||
      secretKeys[1] !== "client-secret"
    ) {
      throw new Error(
        `The PayPal read-back adapter received secret kinds [${secretKeys.join(", ") || "none"}]; the PayPal contract declares exactly [client-id, client-secret].`,
      );
    }
    const clientId = input.secrets["client-id"] ?? "";
    const clientSecret = input.secrets["client-secret"] ?? "";
    if (!clientId || !clientSecret) {
      throw new Error(
        "The PayPal read-back adapter received an empty client-id or client-secret; check the credential store wiring.",
      );
    }

    // mint（P-1，共享步）：401 → auth-failed（唯一凭据拒绝证据）；unavailable →
    // 同名 unavailable（unknown ≠ expired）；ok → 消费证据字段。
    const mint = await mintPayPalAccessToken(
      { mode: input.mode, clientId, clientSecret },
      { apiClient, timeoutMs, apiBaseOverride: dependencies.apiBaseOverride },
    );
    if (mint.kind === "auth-failed") {
      return { kind: "auth-failed", detail: mint.detail };
    }
    if (mint.kind === "unavailable") {
      return { kind: "unavailable", detail: mint.detail };
    }

    // mint ok：提取 app_id（官方样例响应逐字在案）—— 非秘密证据摘要。
    const raw = mint.body as { app_id?: unknown } | null;
    if (typeof raw !== "object" || raw === null) {
      return {
        kind: "unavailable",
        detail: "The PayPal token read-back returned a malformed body; no account evidence.",
      };
    }
    if (typeof raw.app_id !== "string" || raw.app_id.trim().length === 0) {
      return {
        kind: "unavailable",
        detail: "The PayPal token read-back returned no app id; no account evidence.",
      };
    }
    const providerAccountId = raw.app_id;
    // 能力证据（法则 3）：scope 列表 → capabilities；全有或全无。
    const evidence = captureCapabilityEvidence(mint.body);
    return evidence === null
      ? { kind: "verified", providerAccountId }
      : { kind: "verified", providerAccountId, evidence };
  };
}
