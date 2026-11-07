/**
 * PaySwap 受控 provider-authorization Browser 流法则（addendum §5.3 Gate E3；
 * playbook P1.8「Browser authorization and preservation」的 E3 切片）。
 *
 * 法则（normative，addendum §5.3 原文三条款决策表）：
 * - **条款 1（模型臂）**：金融模式开（S2 —— 与 E1 hook 门、broker 三码法则同一
 *   `isPayswapFinancialModeActive` 投影，单一实现纪律）时，模型控制的导航到 PSP
 *   API host 一律拒绝（`psp_api_host_blocked`）——「the model never needs direct
 *   PSP HTTP access; that is what the adapters are for」。URL 不可解析 = 无法证明
 *   非 PSP host → fail-closed 拒绝。
 * - **条款 2（host-initiated 臂）**：provider 授权流（OAuth redirect / dashboard
 *   onboarding）只导航到**该 provider** 的官方授权 host 白名单（authSpec 的
 *   authorizeUrl/tokenUrl/rotationUrl 派生，`derivePayswapProviderAuthorizationHosts`），
 *   白名单外一律拒绝（`authorization_host_not_allowed`）—— allowlist，不是
 *   blocklist；空白名单 = 全拒（approval-origin 空受信集同款 fail-closed）。
 *   驱动方是 host account service（deliverable 05 §5），URL 永远不来自模型。
 * - **条款 3（保真臂）**：金融模式关 = 恒放行（与上游完全一致，零回归 —— E1 §5.1
 *   臂 1 同款）；开时非 PSP host 照常放行 —— Browser 行为只按 host 分类变化。
 *
 * host 匹配纪律（与 E1 的权威 id 精确匹配同款）：
 * - **精确 host 等值**，无通配/无后缀/无子域传播（`api.stripe.com.evil.test`、
 *   `xapi.stripe.com` 都不是 `api.stripe.com`）。
 * - **规范化**：小写 + 去单个尾点（`api.stripe.com.` 与 `api.stripe.com` DNS
 *   等价，不得因尾点放行）；端口不参与 host 等值（`api.stripe.com:8443` 仍是
 *   该 host）；userinfo 不参与（`https://evil.test@api.stripe.com/` 的目标是
 *   api.stripe.com，`https://api.stripe.com@evil.test/` 的目标是 evil.test ——
 *   URL 语义，URL 标准解析）。
 *
 * 种子数据（evidence，非发明）：deliverable 04 §195 的 agent 侧网络工具 denylist
 * ——「PaySwap needs the inverse (denylist) for api.stripe.com, api.paystack.co,
 * api-m.paypal.com in agent-driven fetch tools. Design flag for the TL: this
 * denylist is a P1 hardening item」+ §130（api-m.sandbox.paypal.com vs
 * api-m.paypal.com）。数据驱动（`PayswapPspProviderHostRecord[]`，非代码分支）：
 * P2/P3 provider 接入按 deliverable 05 §4 的 dated-evidence 纪律扩表；
 * authorizationHosts P1 为空（P1 无 host-initiated provider flow —— account
 * service 是 P2 落地，空表 = fail-closed 全拒是正确生产行为）。
 *
 * 本模块不依赖 `@zcode/contracts`（依赖方向：zcode-cli 侧包取用本模块，反向
 * 不成立 —— E1 hook-admission 同款纪律）；包装层（bootstrap
 * `src/app/payswap-browser-admission.ts`）负责把法则裁决映射为 Browser 面的
 * typed `navigation_blocked` 错误码。
 */

/**
 * 一个已知 PSP 的 host 记录（数据驱动；deliverable 04/05 的 dated evidence）。
 * `apiHosts` 供模型臂 denylist；`authorizationHosts` 供 host-initiated 臂
 * allowlist（P2 的 authSpec 派生填充）。
 */
export interface PayswapPspProviderHostRecord {
  providerId: string;
  apiHosts: readonly string[];
  authorizationHosts: readonly string[];
}

/**
 * 种子记录（P1）：API host denylist = deliverable 04 §195 记录的三家四 host；
 * authorizationHosts 空（P1 无 provider flow；account service P2 落地时填充）。
 */
export const PAYSWAP_SEED_PSP_PROVIDER_HOSTS: readonly PayswapPspProviderHostRecord[] = [
  { providerId: "stripe", apiHosts: ["api.stripe.com"], authorizationHosts: [] },
  { providerId: "paystack", apiHosts: ["api.paystack.co"], authorizationHosts: [] },
  {
    providerId: "paypal",
    apiHosts: ["api-m.paypal.com", "api-m.sandbox.paypal.com"],
    authorizationHosts: [],
  },
];

/** 准入裁决：放行，或拒绝 + 法则级 typed code + host 回显（不可解析 = null）。 */
export type PayswapBrowserNavigationAdmission =
  | { admitted: true }
  | { admitted: false; code: "psp_api_host_blocked" | "authorization_host_not_allowed"; host: string | null };

/** host 规范化：小写 + 去单个尾点（DNS 等价）。 */
export function normalizePayswapBrowserHost(host: string): string {
  const lowercased = host.toLowerCase();
  return lowercased.endsWith(".") ? lowercased.slice(0, -1) : lowercased;
}

/** URL → 规范化 host；不可解析 → undefined（由准入层 fail-closed 兜住）。 */
export function readPayswapBrowserUrlHost(rawUrl: string): string | undefined {
  try {
    return normalizePayswapBrowserHost(new URL(rawUrl).hostname);
  } catch {
    return undefined;
  }
}

/** URL 是否 PSP API host（不可解析 → false；fail-closed 由准入层兜住）。 */
export function isPayswapPspApiHostUrl(
  rawUrl: string,
  records: readonly PayswapPspProviderHostRecord[] = PAYSWAP_SEED_PSP_PROVIDER_HOSTS,
): boolean {
  const host = readPayswapBrowserUrlHost(rawUrl);
  if (host === undefined) return false;
  return records.some((record) =>
    record.apiHosts.some((apiHost) => normalizePayswapBrowserHost(apiHost) === host),
  );
}

/**
 * §5.3 条款 1 + 条款 3 —— 模型臂准入决策表：
 * 模式关 → 恒放行（上游行为不变，零回归）；模式开 → PSP API host 拒绝
 * （不可解析 fail-closed 拒绝），非 PSP host 放行。
 */
export function admitPayswapModelBrowserNavigation(input: {
  financialModeActive: boolean;
  url: string;
  records?: readonly PayswapPspProviderHostRecord[];
}): PayswapBrowserNavigationAdmission {
  if (!input.financialModeActive) {
    return { admitted: true }; // §5.3 条款 3 / E1 臂 1：模式关 = 与上游一致。
  }
  const host = readPayswapBrowserUrlHost(input.url);
  if (host === undefined) {
    // fail-closed：无法证明目标不是 PSP host。
    return { admitted: false, code: "psp_api_host_blocked", host: null };
  }
  const records = input.records ?? PAYSWAP_SEED_PSP_PROVIDER_HOSTS;
  const blocked = records.some((record) =>
    record.apiHosts.some((apiHost) => normalizePayswapBrowserHost(apiHost) === host),
  );
  if (blocked) {
    return { admitted: false, code: "psp_api_host_blocked", host };
  }
  return { admitted: true }; // §5.3 条款 3：非 PSP host 照常放行。
}

/**
 * §5.3 条款 2 —— host-initiated provider 授权流准入（allowlist，不是 blocklist）：
 * URL 的 host 在**该 provider** 的授权 host 白名单上才放行；白名单外一律拒绝
 * （含 PSP API host —— denylist 语义不适用于此臂）；空白名单 = 全拒
 * （approval-origin 空受信集同款 fail-closed）；不可解析 = 拒绝。
 * 驱动方是 host account service（authSpec）；URL 永远不来自模型。
 */
export function admitPayswapProviderAuthorizationFlow(input: {
  url: string;
  providerAuthorizationHosts: readonly string[];
}): PayswapBrowserNavigationAdmission {
  const host = readPayswapBrowserUrlHost(input.url);
  if (host === undefined) {
    return { admitted: false, code: "authorization_host_not_allowed", host: null };
  }
  const allowed = input.providerAuthorizationHosts.some(
    (allowedHost) => normalizePayswapBrowserHost(allowedHost) === host,
  );
  if (!allowed) {
    return { admitted: false, code: "authorization_host_not_allowed", host };
  }
  return { admitted: true };
}

/**
 * authSpec → 授权 host 白名单派生（P2 account service 的数据入口）：
 * authorizeUrl/tokenUrl/rotationUrl 的 host，规范化去重；不可解析 URL 跳过
 * （缺失只窄不宽 = fail-closed 方向）。调用方从 authSpec 提取 URL 列表传入，
 * 本模块不依赖 authSpec 类型（P2 契约落地时免受形状耦合）。
 */
export function derivePayswapProviderAuthorizationHosts(
  authSpecUrls: readonly string[],
): string[] {
  const hosts: string[] = [];
  for (const rawUrl of authSpecUrls) {
    const host = readPayswapBrowserUrlHost(rawUrl);
    if (host === undefined) continue;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
