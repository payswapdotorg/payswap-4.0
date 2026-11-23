/**
 * PaySwap P3 —— 协议边界 typed refusal 词汇（闭集）。
 *
 * 叶子模块（无任何 import）：`protocol-facts.ts`（注册表的不支持能力清单引用
 * refusal 码）与 `protocol-contract.ts`（边界契约）都依赖它 —— 二者互不依赖
 * 对方的方向上不成环。`protocol-contract.ts` 原名再导出，调用方的导入面不变。
 *
 * 法则：这是协议边界唯一的拒绝词汇 —— 连接 UI / 法则测试按 code 分流；无带
 * 警告结局、无第三种结局。新 code = 契约变更（同步更新闭集电池）。
 */

export const PAYSWAP_PROTOCOL_REFUSAL_CODES = [
  /** 协议 id 不在 pinned 注册表（未评估/未批准的协议面）。 */
  "protocol_not_registered",
  /** 注册表尚未验证到该协议的版本串 —— 适配器实现被挡（fail-closed：不猜版本）。 */
  "protocol_version_unpinned",
  /** 适配器 pin 的版本与注册表不一致（含未知/未来版本 —— 不模拟支持）。 */
  "protocol_version_unsupported",
  /** 适配器的事实源（URL/检索日期）与注册表不一致 —— 事实漂移 ≠ 版本不支持
   *  （2026-11-22 修正：两种失败模式分开，宿主按 code 精确分派）。 */
  "protocol_facts_drift",
  /** 消息结构验证失败或形态未知（unknown → fail-closed）。注意：本面不做
   *  SD-JWT 密码学验证 —— 该 code 仅指结构验证失败，不指验签失败。 */
  "protocol_message_unverifiable",
  /** 协议特性经官方源验证为不适用/未启用（不可用，不是模拟）。 */
  "protocol_feature_unsupported",
  /** 收据面被要求但宿主结算证据缺席/畸形/非 settled-verified（协议 accepted
   *  ≠ 结算）。 */
  "protocol_receipt_unavailable",
  /** 宿主证据未被权威证据源签发（伪造/篡改/跨协议复用）—— 适配器不得采信。 */
  "protocol_evidence_untrusted",
  /** challenge id 从未由本宿主签发（未知/已清除）—— fail-closed。 */
  "protocol_challenge_unknown",
  /** challenge 已过期（宿主时钟裁决；客户端时间不参与）。 */
  "protocol_challenge_expired",
  /** challenge 已被消费（原子单次使用；含并发重复与重连后重放）。 */
  "protocol_challenge_consumed",
  /** 回显 challenge 与宿主签发记录不一致（id/method/intent/request/opaque/
   *  expires 等绑定字段被改动或错配）。 */
  "protocol_challenge_mismatch",
  /** 注册表的消息面再验证清单未空 —— 该协议的适配器实现被挡（法则 5 的注册门
   *  半：未验证到的不编码、不模拟）。 */
  "protocol_reverify_pending",
] as const;

export type PayswapProtocolRefusalCode = (typeof PAYSWAP_PROTOCOL_REFUSAL_CODES)[number];

/** 协议边界 typed 拒绝（与账户服务 refusal 同形：code + 人类可读消息）。 */
export interface PayswapProtocolRefusal {
  readonly code: PayswapProtocolRefusalCode;
  readonly message: string;
}
