/**
 * PaySwap P4 wave 5 —— blockchain/wallet 约束证据（shared CONTRACT「P4 wave 5」
 * + addendum §13 边界的 schema 层投影）。
 *
 * 法则（normative；违反即实现缺陷）—— 全文见 shared CONTRACT；此处只列实现要点：
 * 1. **四族证据分立**：wallet address-control 证据是第四族（独立模块、独立 source
 *    闭集），与 wave 3 三族（sender 能力记录 / verified-recipient / participant）
 *    互不充当对方证据、互不可变换（电池持有结构断言）。
 * 2. **canonical network identity（§13.3/§13.4）**：`{namespace, reference}` 形状
 *    （CAIP-2 对齐、namespace 无关 —— 不钉任何链表，链专属词汇随 adapter 切片且
 *    只从 provider 证据来）；canonical 字符串形 `namespace:reference`。
 * 3. **address proof-of-control 只证明控制（§13.2 逐字落地）**：记录必须携带
 *    challenge 绑定证据（challengeId + evidenceRef + source + verifiedAt）、
 *    address、canonical chain id、freshnessBoundMs。成功连接只证明挑战期内对该
 *    地址的控制 —— schema 层不含也永不添加任何 spending/allowance/mandate 字段；
 *    seed phrase / private key / mnemonic 类字段 strict 拒绝；消息零密钥材料。
 * 4. **无权威外溢（§13.3/§13.5）**：无 adapter 面、无签名/广播/提交面、无路由面、
 *    无链表、无 connector 实现 —— §13.5 的 P7 authorization/reconciliation 门
 *    原样有效（结构断言由电池持有）。
 *
 * 纯类型 + zod schema + 纯函数：无 IO、无凭据、无 runtime（doc 06 §1.1 domain 1）。
 */

import { z } from "zod";
import { payswapIsoDateTimeSchema } from "./parties.js";

// ---------------------------------------------------------------------------
// canonical network identity（§13.3「chain ID plus independently verified network
// identity」—— CAIP-2 对齐形状；namespace 无关，不发明链表）
// ---------------------------------------------------------------------------

export const payswapChainNetworkRefSchema = z
  .object({
    namespace: z.string().regex(/^[a-z0-9-]{3,8}$/, "CAIP-2 namespace shape (lowercase alphanumerics and dashes, 3-8 chars)"),
    reference: z.string().min(1).max(64),
  })
  .strict();
export type PayswapChainNetworkRef = z.infer<typeof payswapChainNetworkRefSchema>;

/** canonical 字符串形（`namespace:reference` —— 约束维度与 rail detail 的承载形）。 */
export const payswapCanonicalChainIdSchema = z
  .string()
  .regex(
    /^[a-z0-9-]{3,8}:[a-zA-Z0-9_.-]{1,64}$/,
    "canonical chain id must be the CAIP-2-aligned 'namespace:reference' string form",
  );

/** 纯函数：network ref → canonical 字符串形（不抛错；无链表查找 —— 不发明）。 */
export function payswapCanonicalChainIdOf(ref: PayswapChainNetworkRef): string {
  return `${ref.namespace}:${ref.reference}`;
}

// ---------------------------------------------------------------------------
// 第四族证据：wallet address-control（独立 source 闭集 —— 永不并入 wave 3 三族；
// §13.1 separate capabilities 的家族层投影）
// ---------------------------------------------------------------------------

export const PAYSWAP_WALLET_EVIDENCE_SOURCES = [
  "address-proof-of-control",
] as const;
export type PayswapWalletEvidenceSource = (typeof PAYSWAP_WALLET_EVIDENCE_SOURCES)[number];

export const payswapWalletAddressControlEvidenceSchema = z
  .object({
    kind: z.literal("wallet-address-control"),
    wallet: z
      .object({
        address: z.string().min(1),
        chainId: payswapCanonicalChainIdSchema,
      })
      .strict(),
    proof: z
      .object({
        evidenceRef: z.string().min(1),
        source: z.enum(PAYSWAP_WALLET_EVIDENCE_SOURCES),
        verifiedAt: payswapIsoDateTimeSchema,
        /** §13.2：fresh、single-use、expiring、domain/origin/audience-bound —— 生灭语义随 connector 切片。 */
        challengeId: z.string().min(1),
      })
      .strict(),
    freshnessBoundMs: z.number().int().positive(),
  })
  .strict();
export type PayswapWalletAddressControlEvidence = z.infer<typeof payswapWalletAddressControlEvidenceSchema>;

// ---------------------------------------------------------------------------
// wallet association（§13.2：address + canonical chain identity bound to the
// authenticated principal/workspace; proof-of-control is not spending authority）
// ---------------------------------------------------------------------------

export const payswapWalletAssociationSchema = z
  .object({
    kind: z.literal("wallet-association"),
    wallet: z
      .object({
        address: z.string().min(1),
        chainId: payswapCanonicalChainIdSchema,
      })
      .strict(),
    principalId: z.string().min(1),
    workspaceId: z.string().min(1),
    proof: z
      .object({
        evidenceRef: z.string().min(1),
        source: z.enum(PAYSWAP_WALLET_EVIDENCE_SOURCES),
        verifiedAt: payswapIsoDateTimeSchema,
        challengeId: z.string().min(1),
      })
      .strict(),
    freshnessBoundMs: z.number().int().positive(),
  })
  .strict();
export type PayswapWalletAssociation = z.infer<typeof payswapWalletAssociationSchema>;
