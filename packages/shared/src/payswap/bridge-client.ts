/**
 * PaySwap 子进程侧 bridge transport（契约 w2-01 §3.3、§6.1(5)、§6.5(3)、§9.3(5)/(6)；
 * ADR-9 D9.7 —— transport shell 随 Step 7 落地；ADR-10 as-built）。
 *
 * 本模块是 child 侧访问 broker 的**唯一**通道：UDS connect → 单行写 → §6.5(3) 验签接线 →
 * 发送边界分配器上的有界重试环。与 broker 侧（bootstrap/payswap-broker）共享同一份
 * 协议实现（envelope/replay/canonical —— §6.4(5) 唯一实现纪律），两份实现漂移即违约。
 *
 * 法则（normative）：
 * - §6.1(5) child 侧尺寸预检：序列化超 1 MiB 的逻辑请求在**分配之前**拒绝（不烧 seq）。
 *   预检用最大位宽 seq 占位（16 位十进制 ≥ 任何安全整数的位数）得到精确上界。
 * - §9.3(5) 发送边界分配：`allocate()` 与写发起原子（无预留路径）；发送前取消不消耗
 *   seq；不确定投递（字节已移交 socket：写回调成功后的关闭/超时）保留 seq 同逻辑请求
 *   重试（`retry()` 取回同一 seq，行字节等价）；可证未投递（connect 失败 / 写回调报错）
 *   可同 seq 重试或退役；放弃（永不重发）经 `retire()` 入声明队列，由后续载体携带。
 * - §6.5(3) 每 attempt 读时限（缺省 30 s，SHOULD 与 §3.3(4) 服务端空闲上限对齐）喂入
 *   同一重试预算；验签失败整封拒绝（(a)-(h) 每步机器可读 reason），被拒响应的字段
 *   一个都不外露；v1 无未签名模式。
 * - ADR-10：验签拒绝**永不重发**本 seq（响应已收到、内容未通过认证 —— 重发只会扩大
 *   压制窗口）；其 seq 与本轮携带的退役声明重新入队（broker 侧幂等容忍重复声明）。
 *   已验签的 §6.3 桥接错误（ok:false）是**已答**（answer），不是 client 失败。
 */

import net from "node:net";
import type { PayswapBrokerCredentialTuple } from "./broker-env.js";
import {
  verifyResponseEnvelope,
  PAYSWAP_MAX_LINE_BYTES,
  type PayswapBrokerOp,
  type PayswapBrokerResponseBody,
  type PayswapBrokerResponseRejectionReason,
} from "./envelope.js";
import {
  createPayswapSequenceAllocator,
  PAYSWAP_RETIRED_SEQS_MAX,
  type PayswapSequenceAllocator,
} from "./replay.js";

// ---------------------------------------------------------------------------
// 类型（child 侧 typed 失败闭集；§6.3 桥接码经 answered body 面，见 callOp）
// ---------------------------------------------------------------------------

/** child 侧 typed 失败码（闭集；§6.3 的 broker 桥接码不在此列 —— 它们是已验签的回答）。 */
export type PayswapBridgeClientFailureCode =
  | "session_hint_missing" // §6.1 sessionId min(1)：无权威 hint，请求不可构造
  | "request_too_large" // §6.1(5)：child 侧尺寸预检（分配之前，不烧 seq）
  | "connect_failed" // 可证未投递（connect 失败 / 写回调报错）且预算耗尽
  | "response_deadline_exceeded" // §6.5(3) 读时限到（字节已交付，不确定投递）且预算耗尽
  | "response_rejected" // §6.5(3)(a)-(h) 验签整封拒绝（永不重发，ADR-10）
  | "retry_budget_exhausted" // 不确定投递（无响应关闭）耗尽重试预算（压制面）
  | "aborted"; // 调用方取消（发送前：不消耗 seq；发送后：退役）

export type PayswapBridgeCallResult =
  | { kind: "answered"; body: PayswapBrokerResponseBody }
  | {
      kind: "failed";
      code: PayswapBridgeClientFailureCode;
      message: string;
      retryable: boolean;
      /** 仅 `response_rejected` 携带：§6.5(3) 的机器可读拒绝原因（closed set，非响应字段）。 */
      rejectionReason?: PayswapBrokerResponseRejectionReason;
    };

export interface PayswapBridgeCallOptions {
  signal?: AbortSignal;
  trace?: { traceId: string; spanId?: string; parentSpanId?: string };
}

export interface PayswapBridgeClient {
  /**
   * 发起一次逻辑 broker 调用（§3.3 一请求一连接）。已验签的回答（成功体或 §6.3 桥接
   * 错误）→ `answered`；child 侧失败（含验签整封拒绝）→ `failed`。永不抛裸错误。
   */
  callOp(
    op: PayswapBrokerOp,
    params: Record<string, unknown>,
    sessionHint: string | null | undefined,
    options?: PayswapBridgeCallOptions,
  ): Promise<PayswapBridgeCallResult>;
  /** 子进程侧发送边界分配器（§9.3(5)；introspection/测试用）。 */
  readonly allocator: PayswapSequenceAllocator;
}

export interface PayswapBridgeClientOptions {
  /** 受信注入的五键组（§4.2；形状非法即构造失败 —— 编程错误，非协议事件）。 */
  tuple: PayswapBrokerCredentialTuple;
  /** §6.5(3) 每 attempt 读时限（connect+写+读整体）；缺省 30 s。 */
  readDeadlineMs?: number;
  /** 重试预算（§6.3 rev 2a：同 seq 重试的额外次数）；缺省 1。 */
  retryBudget?: number;
  /** 注入分配器（缺省新建；introspection/测试用）。 */
  allocator?: PayswapSequenceAllocator;
}

/** §6.5(3) 读时限 SHOULD 30 s（与 §3.3(4) 服务端空闲上限对齐）。 */
export const PAYSWAP_BRIDGE_DEFAULT_READ_DEADLINE_MS = 30_000;
/** ADR-10：delivery-failure 同 seq 重试预算缺省 1（验签拒绝永不重试）。 */
export const PAYSWAP_BRIDGE_DEFAULT_RETRY_BUDGET = 1;

/** 尺寸预检的 seq 占位：16 位十进制（≥ 任何 ≤ Number.MAX_SAFE_INTEGER 的 seq 位宽）。 */
const SIZE_PROBE_SEQ = 9_999_999_999_999_999;

// ---------------------------------------------------------------------------
// 单次 attempt 的传输结局（§9.3(5) 的三种投递知识 + 已答/取消）
// ---------------------------------------------------------------------------

type AttemptOutcome =
  | { kind: "response"; line: string }
  | { kind: "provable_non_delivery" } // connect 失败 / 写回调报错 —— 字节未移交
  | { kind: "uncertain_closed" } // 字节已移交、连接关闭且无完整响应行
  | { kind: "uncertain_deadline" } // 字节已移交、读时限到
  | { kind: "aborted" };

function performAttempt(
  socketPath: string,
  line: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  return new Promise<AttemptOutcome>((resolve) => {
    let settled = false;
    let writeHanded = false; // 写回调成功 —— 字节已移交 socket（不确定投递的判据）
    let buffer = "";
    let socket: net.Socket | null = null;

    const onAbort = () => settle({ kind: "aborted" });

    const settle = (outcome: AttemptOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      if (socket !== null) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(outcome);
    };

    const deadlineTimer = setTimeout(() => {
      // §6.5(3)：读时限喂入重试预算。写已移交 → 不确定投递；否则连接级失败（可证）。
      settle(writeHanded ? { kind: "uncertain_deadline" } : { kind: "provable_non_delivery" });
    }, deadlineMs);
    deadlineTimer.unref?.();

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      socket = net.connect({ path: socketPath });
    } catch {
      settle({ kind: "provable_non_delivery" });
      return;
    }

    socket.on("error", () => {
      // 写已成功移交后的错误（ECONNRESET 等）：请求可能已被处理 → 不确定（§9.3(5)）。
      settle(writeHanded ? { kind: "uncertain_closed" } : { kind: "provable_non_delivery" });
    });

    socket.on("connect", () => {
      socket!.write(`${line}\n`, (error) => {
        if (settled) return;
        if (error) {
          // 写回调报错：数据未交付（§9.3(5)「首写 0 字节」的可观测形状）→ 可证未投递。
          settle({ kind: "provable_non_delivery" });
          return;
        }
        writeHanded = true;
      });
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        settle({ kind: "response", line: buffer.slice(0, index) });
        return;
      }
      if (Buffer.byteLength(buffer, "utf8") > PAYSWAP_MAX_LINE_BYTES) {
        // §6.4(4)：超限即弃 —— 交给验签层按 response_line_oversize 整封拒绝（先于一切解析）。
        settle({ kind: "response", line: buffer });
      }
    });

    socket.on("close", () => {
      // 已有完整行则在 data 分支 settle 过；此处只剩无响应关闭。
      settle(writeHanded ? { kind: "uncertain_closed" } : { kind: "provable_non_delivery" });
    });
  });
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/** 校验五键组形状（§4.4(1) all-or-nothing 的构造面 —— 非法即编程错误）。 */
function assertValidTuple(tuple: PayswapBrokerCredentialTuple): void {
  for (const key of ["socket", "token", "instanceId", "hostId", "verifyKeyBase64"] as const) {
    if (typeof tuple[key] !== "string" || tuple[key].trim().length === 0) {
      throw new Error(`payswap bridge client: the injected credential tuple is malformed (field ${key})`);
    }
  }
}

export function createPayswapBridgeClient(options: PayswapBridgeClientOptions): PayswapBridgeClient {
  const { tuple } = options;
  assertValidTuple(tuple);
  const readDeadlineMs = options.readDeadlineMs ?? PAYSWAP_BRIDGE_DEFAULT_READ_DEADLINE_MS;
  const retryBudget = options.retryBudget ?? PAYSWAP_BRIDGE_DEFAULT_RETRY_BUDGET;
  const allocator = options.allocator ?? createPayswapSequenceAllocator();
  const material = { hostId: tuple.hostId, verifyKeyBase64: tuple.verifyKeyBase64 };

  /** 预检镜像 takeRetirements 的取批语义（升序、≤8、< carrier seq）—— 精确上界。 */
  const probeRetirements = (): number[] =>
    allocator
      .pendingRetirements()
      .filter((seq) => seq < SIZE_PROBE_SEQ)
      .slice(0, PAYSWAP_RETIRED_SEQS_MAX);

  return {
    allocator,
    async callOp(op, params, sessionHint, callOptions) {
      const hint = typeof sessionHint === "string" ? sessionHint.trim() : "";
      if (hint.length === 0) {
        // §6.1 sessionId min(1)：无权威 hint → 请求不可构造（fail-closed，零连接零分配）。
        return { kind: "failed", code: "session_hint_missing", message: "payswap bridge: no authoritative session hint on the tool call", retryable: false };
      }
      if (callOptions?.signal?.aborted) {
        return { kind: "failed", code: "aborted", message: "payswap bridge: the call was aborted before the send boundary (no sequence consumed)", retryable: false };
      }

      // §6.1(5) child 侧尺寸预检（分配之前）：以最大位宽 seq 占位构造精确上界行。
      const probeLine = JSON.stringify({
        instanceId: tuple.instanceId,
        seq: SIZE_PROBE_SEQ,
        op,
        params,
        token: tuple.token,
        sessionId: hint,
        ...(probeRetirements().length > 0 ? { retiredSeqs: probeRetirements() } : {}),
        ...(callOptions?.trace ? { trace: callOptions.trace } : {}),
      });
      if (Buffer.byteLength(probeLine, "utf8") > PAYSWAP_MAX_LINE_BYTES) {
        return { kind: "failed", code: "request_too_large", message: `payswap bridge: the serialized request exceeds the ${PAYSWAP_MAX_LINE_BYTES}-byte line cap (contract §6.1(5)); refused before send-boundary allocation`, retryable: false };
      }

      let seq: number | null = null;
      let lastTakenRetirements: number[] = [];
      let lastDeliveryFailure: "provable_non_delivery" | "uncertain_closed" | "uncertain_deadline" = "provable_non_delivery";

      const retireAttempt = (): void => {
        // 本 seq 永不重发 → 退役；本轮携带的退役声明重新入队（载体命运未知 —— broker 幂等容忍）。
        if (seq !== null) {
          allocator.retire(seq);
          for (const entry of lastTakenRetirements) {
            allocator.retire(entry);
          }
        }
      };

      for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
        if (callOptions?.signal?.aborted) {
          retireAttempt();
          return { kind: "failed", code: "aborted", message: "payswap bridge: the call was aborted; the sequence is retired for declaration", retryable: false };
        }
        // 发送边界分配（§9.3(5)）：首轮 allocate，重试轮取回同一 seq（字节等价重发）。
        seq = attempt === 0 ? allocator.allocate() : allocator.retry(seq as number);
        const currentSeq = seq;
        lastTakenRetirements = allocator.takeRetirements(currentSeq);
        const request: Record<string, unknown> = {
          instanceId: tuple.instanceId,
          seq: currentSeq,
          op,
          params,
          token: tuple.token,
          sessionId: hint,
          ...(lastTakenRetirements.length > 0 ? { retiredSeqs: lastTakenRetirements } : {}),
          ...(callOptions?.trace ? { trace: callOptions.trace } : {}),
        };
        const line = JSON.stringify(request);

        const outcome = await performAttempt(tuple.socket, line, readDeadlineMs, callOptions?.signal);

        if (outcome.kind === "response") {
          const verdict = verifyResponseEnvelope(
            outcome.line,
            { instanceId: tuple.instanceId, seq: currentSeq, op, sentLine: line },
            material,
          );
          if (verdict.ok) {
            // 已答（成功体或 §6.3 桥接错误都是回答）；退役声明已随载体交付。
            allocator.settle(currentSeq, "answered");
            return { kind: "answered", body: verdict.body };
          }
          // §6.5(3) 整封拒绝 + ADR-10 永不重发：退役 seq 与本轮声明；被拒字段零外露。
          retireAttempt();
          return {
            kind: "failed",
            code: "response_rejected",
            message: `payswap bridge: the broker response failed verification (${verdict.reason}); rejected in full`,
            retryable: false,
            rejectionReason: verdict.reason,
          };
        }
        if (outcome.kind === "aborted") {
          retireAttempt();
          return { kind: "failed", code: "aborted", message: "payswap bridge: the call was aborted in flight; the sequence is retired for declaration", retryable: false };
        }

        // 传输层失败：按 §9.3(5) 结算（可证 → provable；不确定 → 保留同 seq 重试）。
        lastDeliveryFailure = outcome.kind;
        allocator.settle(currentSeq, outcome.kind === "provable_non_delivery" ? "provable_non_delivery" : "uncertain_delivery");
      }

      // 预算耗尽：本 seq 永不重发 → 退役；按最后失败类别给出 typed 码（ADR-10）。
      retireAttempt();
      if (lastDeliveryFailure === "uncertain_deadline") {
        return { kind: "failed", code: "response_deadline_exceeded", message: `payswap bridge: no verified response within the ${readDeadlineMs}ms read deadline and the retry budget is exhausted (contract §6.5(3))`, retryable: true };
      }
      if (lastDeliveryFailure === "provable_non_delivery") {
        return { kind: "failed", code: "connect_failed", message: "payswap bridge: the broker endpoint could not be reached (provable non-delivery) and the retry budget is exhausted", retryable: true };
      }
      return { kind: "failed", code: "retry_budget_exhausted", message: "payswap bridge: the request delivery stayed uncertain (no response line) and the retry budget is exhausted; the sequence is retired for declaration", retryable: true };
    },
  };
}
