/**
 * PaySwap P3 —— MPP 共享校验原语（regex 形态 + RFC 3339 日历校验 + fatal
 * UTF-8 解码 —— mpp-message-face.ts 与 mpp-receipt-schemas.ts 共用的单一
 * 实现，避免两份漂移）。
 */

/** base64url（RFC 4648 §5 nopad —— challenge request/哈希形态）。 */
export const base64UrlNopadRegex = /^[A-Za-z0-9_-]+$/;
/** 正整数字符串（无符号/小数/指数/前导零）。 */
export const positiveIntStringRegex = /^[1-9]\d*$/;
/** EVM 地址（0x + 40 hex —— EIP-55 混合大小写校验不在本面，按 20 字节解码比较）。 */
export const evmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
/** EVM 交易哈希（0x + 64 hex）。 */
export const evmTxHashRegex = /^0x[0-9a-fA-F]{64}$/;
/** RFC 3339 形态（日历校验由 isValidRfc3339Date 补充）。 */
export const rfc3339Regex = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
/** ISO 4217 三字母小写货币码（stripe rail 用）。 */
export const isoCurrencyRegex = /^[a-z]{3}$/;
/** RFC 9530 content-digest 形态（Structured Field Dictionary：algo=:base64:）。 */
export const rfc9530DigestRegex = /^[a-z0-9-]+=:([A-Za-z0-9+/=]+):$/;

/** RFC 3339 真实日历日期校验（regex 检查形态 + Date 校验日历有效性 ——
 *  "2026-02-30" 的 regex 通过但日历无效）。 */
export function isValidRfc3339Date(value: string): boolean {
  if (!rfc3339Regex.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** fatal UTF-8 解码 —— 无效字节序列可靠拒绝（非替换）。 */
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

export function base64UrlDecodeUtf8(request: string): { ok: true; decoded: string } | { ok: false; reason: string } {
  try {
    const base64 = request.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    return { ok: true, decoded: fatalUtf8.decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))) };
  } catch {
    return { ok: false, reason: "request base64url 解码失败（含无效 UTF-8 字节序列）" };
  }
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
