/**
 * PaySwap §9 重放保护两侧引擎（契约 w2-01 §9；§12.1 Step 6；ADR-2/ADR-9）。
 *
 * 本文件是重放协议的**共享单一实现**（§9.4(1)：G 冻结于共享协议模块、两侧引用同一常量；
 * 与 canonical-json/envelope 的"唯一实现"纪律同源）：
 *
 * - **broker 侧 seen-record 引擎**（§9.3(1)-(4)/(6)、§9.4）：连续水标 W + 保留集 R +
 *   resolved-missing 集 M。受理判定（`seq ≤ W` 或 `seq ∈ R` → sequence_duplicate，先于
 *   dispatch，与原请求最终结局无关）、缺口判定（`seq > W + G` → sequence_gap_exceeded）、
 *   水标只在 W+1 受理后连续推进（受理 ∪ resolved-missing，随推进清理 R/M）、退役声明
 *   按载体独立处理（rev 2a）。原子性（§9.3(4)）：accept 的判定+插入与退役的解析共享
 *   同一同步临界区 —— 本模块全部方法为同步纯内存操作，Node 单线程事件循环内即一个
 *   不可交错步；server.ts 的调用序保证（ADR-9 D9.1）：**载体自身的受理判定先于其退役
 *   处理**（载体的缺口判定对着其退役处理前的 W —— 楔死恢复行的"载体个体失败"语义）。
 *
 * - **child 侧序列分配器**（§9.3(5) rev 2）：分配只发生在发送边界（`allocate()` 即
 *   写发起的原子部分 —— 无预留路径，发送前取消不消耗任何 seq）；不确定投递（任何字节
 *   已移交 socket）保留 seq —— 同逻辑请求重试经 `retry()` 取回**同一** seq；可证未投递
 *   （首写 0 字节，如 EPIPE）可同 seq 重试或退役；放弃（永不重发）经 `retire()` 入声明
 *   队列，由后续载体携带（`takeRetirements`：≤8、严格递增、均小于载体自身 seq）。
 *   已答/已退役的 seq 永不复用（分配单调）。载体丢失后的再声明是幂等安全的
 *   （broker 侧 ignore 规则容忍重复声明，§9.3(6)）。
 *
 * 不变量（违反即实现缺陷）：
 * 1. `R ⊆ (W, W+G]` —— |R| ≤ G 结构性成立（§9.4(3) 内存界）；受理后即时校验，violation
 *    抛 `PayswapReplayInvariantError`（fail-closed：server 以 internal_error 应答）。
 * 2. W 只前进不后退；R/M 中元素只在被水标覆盖时移除（受理永不撤销）。
 * 3. 退役效果分类互斥且机器可读（resolved_missing / ignored_already_accepted /
 *    ignored_nonsensical），逐条返回供 §11 审计。
 * 4. 分配器永不复用任何已分配 seq（含已答/已退役）；`retry` 仅对可重试态
 *   （uncertain/provable）合法，其余抛 TypeError（调用方缺陷，非协议事件）。
 *
 * 幂等/持久化：全内存态、无 IO（§9.2：broker 重启 = host 重启，seen-record 无需持久化 ——
 * 上一代 incarnations 的 instanceId 全部 superseded，其请求先死于 instance_unknown）。
 */

// ---------------------------------------------------------------------------
// §9.4(1) 冻结协议常量（ADR-2：无任何配置面 —— 无 settings 键、无环境变量、无 CLI
// flag、无 manifest 字段可改；变更需 ADR + 实测证据 + 契约修正案，别无他途）
// ---------------------------------------------------------------------------

/** 重放缺口上限 G = 64（fixed v1 protocol constant；§9.4/ADR-2）。 */
export const PAYSWAP_REPLAY_GAP_G = 64;

/** §6.1(4)：retiredSeqs 每请求至多 8 条（schema 层强制；语义错报由引擎容忍）。 */
export const PAYSWAP_RETIRED_SEQS_MAX = 8;

// ---------------------------------------------------------------------------
// broker 侧：seen-record 引擎（§9.3/§9.4）
// ---------------------------------------------------------------------------

/** §9.3(1) 受理判定（§6.3 的三个 §9 拒绝/受理结局）。 */
export type PayswapReplayAcceptVerdict =
  | { kind: "accepted" }
  | { kind: "sequence_duplicate" }
  | { kind: "sequence_gap_exceeded" };

/** 引擎状态的只读投影（§9.4(3) 内存界断言与 §11 审计形状的基础）。 */
export interface PayswapSeenRecordState {
  /** 水标 W：≤ W 的每个序号都已受理（或 resolved-missing）。 */
  watermark: number;
  /** 保留集 R（升序只读副本）：> W 的已受理序号 —— 已完成的也在内（N39 臂）。 */
  retained: readonly number[];
  /** resolved-missing 集 M（升序只读副本）：被声明为弃用的 > W 序号。 */
  resolvedMissing: readonly number[];
}

/** §9.3(6) 退役条目效果（互斥、机器可读；§11 审计携带）。 */
export type PayswapRetirementEffect =
  | "resolved_missing"
  | "ignored_already_accepted"
  | "ignored_nonsensical";

export interface PayswapRetirementEntryEffect {
  seq: number;
  effect: PayswapRetirementEffect;
}

/** §9.4(3) 不变量违反（实现缺陷；server 兜底为 internal_error，绝不外泄细节）。 */
export class PayswapReplayInvariantError extends Error {
  constructor(message: string) {
    super(`payswap replay invariant violated: ${message}`);
    this.name = "PayswapReplayInvariantError";
  }
}

export interface PayswapSeenRecords {
  /**
   * §9.3(1)/(2)/(4) 原子受理判定 + R 插入 + 水标推进。dedupe scope = broker 实例
   * （按 instanceId 键控；连接无关，§9.2）。先判 duplicate（≤ W 或 ∈ R），再判缺口
   * （> W + G）—— 两判互斥（R ⊆ (W, W+G]），次序仅为确定性。
   */
  accept(instanceId: string, seq: number): PayswapReplayAcceptVerdict;
  /**
   * §9.3(6) rev 2a 退役解析：逐条分类并推进水标（与 accept 共享同一同步临界区 —— 本
   * 模块内全部同步）。分类规则（ADR-9 D9.2）：
   * - `e ≥ carrierSeq`、数组内重复、相对先前条目非严格递增、`e ≤ 0` →
   *   `ignored_nonsensical`（child 缺陷，协议注记，非致命）；
   * - `e ≤ W` 或 `e ∈ R` → `ignored_already_accepted`（child 不知 W/R，容忍；
   *     at-most-once 不受扰动 —— 受理永不撤销）；
   * - 其余（`W < e < carrierSeq`、从未受理）→ `resolved_missing`（幂等标记），
   *     水标随后连续推进过 accepted ∪ resolved-missing。
   */
  resolveRetirements(
    instanceId: string,
    retiredSeqs: readonly number[],
    carrierSeq: number,
  ): PayswapRetirementEntryEffect[];
  /** 状态投影（未知实例 = 零态；测试与审计用）。 */
  state(instanceId: string): PayswapSeenRecordState;
}

interface InstanceRecords {
  watermark: number;
  retained: Set<number>;
  resolvedMissing: Set<number>;
}

export function createPayswapSeenRecords(): PayswapSeenRecords {
  const instances = new Map<string, InstanceRecords>();

  // 错误文本不带 instanceId 全值（§11(2) 纪律的保守延伸：标识符最小化）。
  const instanceIdMasked = "«instance»";

  function recordsOf(instanceId: string): InstanceRecords {
    let records = instances.get(instanceId);
    if (records === undefined) {
      records = { watermark: 0, retained: new Set(), resolvedMissing: new Set() };
      instances.set(instanceId, records);
    }
    return records;
  }

  /** 规则 2/6：水标连续推进过 accepted ∪ resolved-missing，随推进清理 R/M。 */
  function advance(records: InstanceRecords): void {
    while (records.retained.has(records.watermark + 1) || records.resolvedMissing.has(records.watermark + 1)) {
      records.watermark += 1;
      records.retained.delete(records.watermark);
      records.resolvedMissing.delete(records.watermark);
    }
    // §9.4(3) 不变量：R ⊆ (W, W+G]（结构性成立；此处 belt 校验 —— 违反即实现缺陷）。
    for (const seq of records.retained) {
      if (seq > records.watermark + PAYSWAP_REPLAY_GAP_G) {
        throw new PayswapReplayInvariantError(
          `retained seq ${seq} exceeds W+G=${records.watermark + PAYSWAP_REPLAY_GAP_G} (instance ${instanceIdMasked})`,
        );
      }
    }
  }

  return {
    accept(instanceId, seq) {
      if (!Number.isInteger(seq) || seq <= 0) {
        // schema 后的 belt：非法 seq 永不受理（§6.1(1) 序列 0 无效）。
        return { kind: "sequence_duplicate" };
      }
      const records = recordsOf(instanceId);
      if (seq <= records.watermark || records.retained.has(seq)) {
        return { kind: "sequence_duplicate" };
      }
      if (seq > records.watermark + PAYSWAP_REPLAY_GAP_G) {
        return { kind: "sequence_gap_exceeded" };
      }
      records.retained.add(seq);
      advance(records);
      return { kind: "accepted" };
    },
    resolveRetirements(instanceId, retiredSeqs, carrierSeq) {
      const records = recordsOf(instanceId);
      const effects: PayswapRetirementEntryEffect[] = [];
      let priorMax = 0;
      for (const entry of retiredSeqs) {
        if (
          entry >= carrierSeq ||
          entry <= priorMax ||
          !Number.isInteger(entry) ||
          entry <= 0
        ) {
          // 非语义（含数组内重复/非严格递增 —— 以先前条目最大值为基准，ADR-9 D9.2）。
          effects.push({ seq: entry, effect: "ignored_nonsensical" });
        } else if (entry <= records.watermark || records.retained.has(entry)) {
          // 已受理（≤ W 或 ∈ R）：child 不知 W/R —— 容忍；受理永不撤销（at-most-once）。
          effects.push({ seq: entry, effect: "ignored_already_accepted" });
        } else {
          // 真报弃用（W < e < carrierSeq、从未受理）→ resolved-missing（幂等）。
          records.resolvedMissing.add(entry);
          effects.push({ seq: entry, effect: "resolved_missing" });
        }
        priorMax = Math.max(priorMax, entry);
      }
      advance(records);
      return effects;
    },
    state(instanceId) {
      const records = instances.get(instanceId);
      if (records === undefined) {
        return { watermark: 0, retained: [], resolvedMissing: [] };
      }
      return {
        watermark: records.watermark,
        retained: [...records.retained].sort((a, b) => a - b),
        resolvedMissing: [...records.resolvedMissing].sort((a, b) => a - b),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// child 侧：发送边界序列分配器（§9.3(5) rev 2）
// ---------------------------------------------------------------------------

/** 分配结局（§9.3(5) 的三种投递知识 + answered）。 */
export type PayswapSequenceSettlement =
  | "answered" // 已获验证响应 —— seq 关闭
  | "uncertain_delivery" // 任何字节已移交 socket —— 交付不确定：保留 seq 同逻辑请求重试
  | "provable_non_delivery"; // 首写 0 字节（如 EPIPE）—— 可同 seq 重试或退役

/** 分配器内部态（introspection 用）。 */
export type PayswapSequenceStatus = "in_flight" | "retryable" | "answered" | "retired";

export interface PayswapSequenceAllocator {
  /**
   * §9.3(5) 发送边界分配：与写发起原子（唯一 seq 来源，无预留路径）。单调从 1 开始，
   * 永不复用（含已答/已退役）。发送前取消 = 不调用本方法（无 seq 可消耗）。
   */
  allocate(): number;
  /** 记录分配结局（§9.3(5) 两情形 + answered）。 */
  settle(seq: number, settlement: PayswapSequenceSettlement): void;
  /**
   * 不确定投递/可证未投递的同逻辑请求重试：取回**同一** seq（§9.3(5)「retain-then-retry」）。
   * 仅对 retryable 态合法；其它态（answered / 未分配）抛 TypeError（调用方缺陷）。
   */
  retry(seq: number): number;
  /**
   * §9.3(6) 退役声明入队（永不重发的 seq —— 取消后放弃、可证未投递后弃用）。
   * 已在队列中 = 幂等 no-op；未分配的 seq 抛 TypeError（发送前取消无 seq 可退役）。
   * 载体丢失后可再 retire（broker 容忍重复声明，§9.3(6) ignore/幂等规则）。
   */
  retire(seq: number): void;
  /** 待声明队列（升序；introspection）。 */
  pendingRetirements(): number[];
  /**
   * 取出下一批声明（§6.1(4)：≤ maxEntries（缺省 8）、严格递增、每条 < carrierSeq；
   * 超出上界或 ≥ carrierSeq 的条目留待后续载体）。**取出即从队列移除** —— 载体若
   * 丢失（未获响应），调用方对其条目再 retire()（幂等安全）。
   */
  takeRetirements(carrierSeq: number, maxEntries?: number): number[];
  /** introspection：seq 是否已分配（含已答/已退役）。 */
  isAllocated(seq: number): boolean;
  /** introspection：seq 当前态（未分配 → undefined）。 */
  status(seq: number): PayswapSequenceStatus | undefined;
}

export function createPayswapSequenceAllocator(): PayswapSequenceAllocator {
  let nextSeq = 1;
  const statuses = new Map<number, PayswapSequenceStatus>();
  const pending = new Set<number>();

  function requireAllocated(seq: number): PayswapSequenceStatus {
    const status = statuses.get(seq);
    if (status === undefined) {
      throw new TypeError(`payswap sequence allocator: seq ${seq} was never allocated (allocation happens only at the send boundary)`);
    }
    return status;
  }

  return {
    allocate() {
      const seq = nextSeq;
      nextSeq += 1;
      statuses.set(seq, "in_flight");
      return seq;
    },
    settle(seq, settlement) {
      const status = requireAllocated(seq);
      if (settlement === "answered") {
        if (status === "answered") return; // 幂等
        statuses.set(seq, "answered");
        pending.delete(seq); // 已答无需声明（防御：调用方误入队的清理）
        return;
      }
      // uncertain / provable → 可重试态（provable 亦可直接 retire）。
      statuses.set(seq, "retryable");
    },
    retry(seq) {
      const status = requireAllocated(seq);
      if (status !== "retryable") {
        throw new TypeError(
          `payswap sequence allocator: retry(seq=${seq}) is only legal for an uncertain/provable delivery (status=${status}); a new logical request allocates a fresh seq`,
        );
      }
      return seq;
    },
    retire(seq) {
      requireAllocated(seq);
      if (statuses.get(seq) === "answered") {
        // 已答 seq 的退役是无效载荷 —— 容忍为 no-op（broker 侧 anyway ignore；防御性不留队列）。
        return;
      }
      statuses.set(seq, "retired");
      pending.add(seq);
    },
    pendingRetirements() {
      return [...pending].sort((a, b) => a - b);
    },
    takeRetirements(carrierSeq, maxEntries = PAYSWAP_RETIRED_SEQS_MAX) {
      const batch: number[] = [];
      for (const seq of [...pending].sort((a, b) => a - b)) {
        if (batch.length >= maxEntries) break;
        if (seq >= carrierSeq) continue; // §6.1(4)：每条 < 载体自身 seq（belt —— 单调分配下恒真）
        batch.push(seq);
      }
      for (const seq of batch) {
        pending.delete(seq);
      }
      return batch;
    },
    isAllocated(seq) {
      return statuses.has(seq);
    },
    status(seq) {
      return statuses.get(seq);
    },
  };
}
