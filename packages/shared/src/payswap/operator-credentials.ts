/**
 * PaySwap operator 凭据（addendum §1.6.3 item 8 —— format/storage law）。
 *
 * 纪律（normative）：
 * - 格式：`pso_v1_<base64url>` 覆盖 32 字节 CSPRNG 输出（randomBytes(32) —— 与 broker
 *   token 同纪律）；高熵由构造保证，注册表只存 `sha256(token)` 做 keyed lookup，
 *   比较用 `timingSafeEqual`（常时）。明文只在 provision/rotate 时一次性返回，
 *   绝不入存储、日志、URL 或模型上下文。
 * - 解析法则：前缀 + 版本 + 43 字符 base64url 字符集（无 padding）；任何偏差 →
 *   `{ok:false}`（不产生 digest、不产生状态）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PAYSWAP_OPERATOR_TOKEN_PREFIX = "pso_v1_";

/** base64url(32B) 的编码长度（无 padding）。 */
const OPERATOR_TOKEN_BODY_LENGTH = 43;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface PayswapMintedOperatorCredential {
  /** 明文凭据 —— 只在铸造处一次性返回给调用方（provision/rotate）。 */
  token: string;
  /** sha256(token) 的 hex —— 注册表存储的唯一形态。 */
  digest: string;
}

/** 铸造一枚 operator 凭据（CSPRNG 32B + sha256 digest）。 */
export function mintPayswapOperatorCredential(): PayswapMintedOperatorCredential {
  const token = `${PAYSWAP_OPERATOR_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, digest: payswapOperatorCredentialDigest(token) };
}

/** sha256(token) hex —— digest-only 存储法的唯一摘要形态。 */
export function payswapOperatorCredentialDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type PayswapOperatorCredentialParse =
  | { ok: true; digest: string }
  | { ok: false };

/**
 * 解析法则（纯）：仅接受 `pso_v1_` + 43 字符 base64url；其余一切（错误前缀/短体/
 * 非法字符）→ `{ok:false}`。digest 只对合法形状计算。
 */
export function parsePayswapOperatorCredential(token: string): PayswapOperatorCredentialParse {
  if (!token.startsWith(PAYSWAP_OPERATOR_TOKEN_PREFIX)) return { ok: false };
  const body = token.slice(PAYSWAP_OPERATOR_TOKEN_PREFIX.length);
  if (body.length !== OPERATOR_TOKEN_BODY_LENGTH) return { ok: false };
  if (!BASE64URL_PATTERN.test(body)) return { ok: false };
  return { ok: true, digest: payswapOperatorCredentialDigest(token) };
}

/** 常时比较两个 hex digest（等长；长度不等直接 false —— hex 形态由本模块保证）。 */
export function verifyPayswapOperatorCredentialDigests(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
