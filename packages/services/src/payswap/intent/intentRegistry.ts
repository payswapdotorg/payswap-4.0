/**
 * PaySwap P4 wave 4 —— 进程内不可变 intent 注册表（shared CONTRACT「P4 wave 4」
 * 的注册表半；wave 1 capability registry 的同款纪律投影到 intent 面）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **intent 不可变**：编译产物永不改写；注册表存储深冻结副本（frozen views）。
 * 2. **revision 递增**：revision 是注册表的**全局声明序号**（append-only 纪律；
 *    wave 1 按 key 递增，intent 按 id 全局唯一 —— 同 id 永不二次声明，故按全局
 *    序号递增才有意义）。compile 产出的 revision 占位 1 在 declare 时被覆写为
 *    权威值（wave 1 推导面同款）。
 * 3. **历史保留**：每个 intentId 的声明历史永久保留（单条 —— 不可变性使然；
 *    数组形状与 wave 1 对齐，P7 账本切片接管持久化时形状不变）。
 * 4. **stale 声明拒绝**：createdAt 早于最近一次声明的 createdAt → 拒绝
 *    （单一时钟纪律，wave 1 同款；相等放行）。
 * 5. **同一 intentId 永不重声明**：id 是 host 分配的一次性能力 —— 重声明 =
 *    装配错误（意图不可变，无「新版本 intent」；演化走新 intentId）。
 * 6. **无权威外溢**：不路由、不铸造、不提交、不写 ledger（P7 证据账本切片接手
 *    持久化 —— 本注册表是 P4 的进程内 wire 面，边界如实记录）。
 *
 * 纯进程内：无 IO、无凭据、无时钟（时间由 intent.createdAt 携带，declare 不取
 * 当前时间 —— 与 wave 1「注册表不持时钟」同一纪律）。
 */

import {
  payswapFinancialIntentSchema,
  type PayswapFinancialIntent,
} from "./intentCompiler.js";

export interface PayswapIntentRegistry {
  /** 声明一条编译产物（revision 由注册表分配；同 id 重声明 / stale createdAt 拒绝）。 */
  declare(intent: PayswapFinancialIntent): Readonly<PayswapFinancialIntent>;
  /** 最新声明（frozen；未知 intentId = null —— 缺席不是零记录）。 */
  latest(intentId: string): Readonly<PayswapFinancialIntent> | null;
  /** 该 id 的全部声明历史（frozen，按 revision 升序 —— 不可变性使然，恰一条）。 */
  history(intentId: string): readonly Readonly<PayswapFinancialIntent>[];
}

export function createPayswapIntentRegistry(): PayswapIntentRegistry {
  const byIntentId = new Map<string, readonly Readonly<PayswapFinancialIntent>[]>();
  let lastDeclaredAt: string | null = null;
  let lastRevision = 0;

  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) {
        if (child && typeof child === "object") deepFreeze(child);
      }
    }
    return value;
  };

  return {
    declare(intent) {
      if (intent.intentId.trim().length === 0) {
        throw new Error("intent registry declare requires a non-empty intentId");
      }
      if (byIntentId.has(intent.intentId)) {
        throw new Error(
          `intent registry refuses a re-declaration: intentId '${intent.intentId}' is immutable and already declared (evolution rides a new intentId)`,
        );
      }
      if (lastDeclaredAt !== null && intent.createdAt < lastDeclaredAt) {
        throw new Error(
          `intent registry refuses a stale declaration: createdAt ${intent.createdAt} is older than the latest declaration at ${lastDeclaredAt} (revision ${lastRevision})`,
        );
      }
      const revision = lastRevision + 1;
      // zod parse 产出全新对象树 —— 冻结必须在 parse 之后（否则冻结的是弃置副本）。
      const stored = deepFreeze(
        payswapFinancialIntentSchema.parse({
          ...intent,
          revision,
        }),
      );
      byIntentId.set(intent.intentId, Object.freeze([stored]));
      lastDeclaredAt = intent.createdAt;
      lastRevision = revision;
      return stored;
    },
    latest(intentId) {
      return byIntentId.get(intentId)?.[0] ?? null;
    },
    history(intentId) {
      return byIntentId.get(intentId) ?? [];
    },
  };
}
