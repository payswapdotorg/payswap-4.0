/**
 * PaySwap P3 —— 协议面 canonical 摘要的单一实现（三个消息面共用 —— 三份漂移
 * 即违约，与 canonical-json / evidence-gate 同一纪律）。
 *
 * 摘要 = SHA-256(JCS canonical JSON, RFC 8785) 的 base64url-nopad。只用于
 * **绑定与证据链比对**（键序无关）；不是密码学验证，也不构成任何授权。
 */

import { canonicalJsonStringify } from "../canonical-json.js";

function base64UrlNopad(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function payswapCanonicalDigest(value: unknown): Promise<string> {
  const canonical = canonicalJsonStringify(value);
  const digestBytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64UrlNopad(new Uint8Array(digestBytes));
}
