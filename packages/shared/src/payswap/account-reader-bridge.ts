/**
 * PaySwap P2.2 —— 账户 reader 桥法则（ADR-P2-2 Decision 3：desktop main 持有账户
 * 运行时，host 进程〔utilityProcess〕里 broker 的两个 reader 面经类型化跨进程桥
 * 触达同一实例）。
 *
 * 通道形态：app 私有 MessagePort（main↔utilityProcess，spawn 时转移 —— 非网络面，
 * 无签名层；进程边界即信任边界，与 bridge-client 的 UDS 签名信封不同源也不同责）。
 * 本模块是**两端共享的单一法则实现**（stub 与 server 各自的漂移即违约 —— 与
 * envelope/replay 的唯一实现纪律同款）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **消息闭集**（strict zod）：request 恰两 op（overview/detail）；response 恰
 *    `ok:true`（value 经 per-op 法则 schema 校验）或 `ok:false`（恰 `reader_error`
 *    —— 服务端 face 抛出或产出畸形值；message 操作员可读、零凭据材料）。
 * 2. **typed refusal 作数据透传**：detail 联合（detail/expired/revoked/refused）
 *    与投影行是**值**—— 桥不吞、不改、不改写语义（ADR-P2-1 的 refusal 值语义
 *    原样跨进程；broker dispatch 的三码法则照常先于 reader）。
 * 3. **桥失败 = reader throw**：stub 的一切失败（`timeout` / `port_closed` /
 *    `malformed_response` / `reader_error` 中继）以 `PayswapReaderBridgeError`
 *    抛出 —— broker dispatch §7.3 把 throwing reader 归 internal_error
 *    （liveStateReader 同款类）。**桥缺席 = reader 缺席**（fail-closed 缺省：
 *    概览不答数据）与桥故障在法则层有别，桥不模糊这个区别。
 * 4. **服务端 fail-closed 校验**：face 产出经 per-op schema 校验后才可上端口
 *    （畸形值 → `reader_error` 响应，畸形值本体永不外发）；畸形请求静默忽略
 *    （不答、不抛 —— 非请求消息不产生任何面）。
 * 5. **服务端串行**：请求按到达序逐个处理（响应序 = 请求序；相关性由 callId
 *    承载 —— 单写者纪律的桥级落地）。stub 侧允许多呼叫并发（pending map）。
 * 6. **每呼叫有界时限**（缺省 15 s）：到期未答 = `timeout` 抛出（挂起清理）。
 *    `dispose()` = 端口终结：全部挂起以 `port_closed` 拒绝；后续呼叫立即拒绝。
 * 7. **IO 全注入**：port（结构面 —— post + subscribe）、callId 铸造、时限全部
 *    可注入；法则级测试无 Electron、无真实 MessagePort。
 *
 * ADR-P2-2 Addendum B 的传输形态（本模块同时是传输法则的单一事实源）：
 * - 第 1 跳 main ↔ 窗口 host：spawn 时 `MessageChannelMain` 转移（main 侧 serve
 *   端口适配 + host 侧中继端口适配 —— 两端适配都只做结构面映射，零语义）。
 * - 第 2 跳 窗口 host ↔ agent：既有 stdio 协议（NDJSON 帧）上的透明中继 —— 桥
 *   消息作为**不透明载荷**装在通知帧（`PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD`）
 *   的 params 里双向转发；中继**不校验、不改写、不解释语义**（zod 校验只住真正
 *   的两端 —— 本模块的 stub 与 server；「两端共享单一实现」纪律不因中继而稀释）。
 *   中继唯一的读取面是 callId（路由键 —— `readPayswapReaderBridgeCallId`，恰一
 *   字段，不作任何合法性裁决）。
 * - 缺席判据：spawn env 标记 `ZCODE_PAYSWAP_READER_BRIDGE`（`ZCODE_PAYSWAP_READER_BRIDGE_ENV`）
 *   是窗口 host 对中继在活的 spawn 时快照断言 —— 标记缺席（headless CLI / 桥未建）
 *   = reader 缺席 = fail-closed 缺省；标记在活后的中继故障 = 桥法则 3 的 throw 语义。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  payswapConnectionStatusProjectionSchema,
  type PayswapConnectionStatusProjection,
} from "./account-connection.js";
import {
  payswapAccountOverviewDetailSchema,
  type PayswapAccountOverviewDetail,
} from "./account-data.js";

// ---------------------------------------------------------------------------
// 消息闭集（法则 1）
// ---------------------------------------------------------------------------

const PAYSWAP_READER_BRIDGE_REQUEST_KIND = "payswap-account-reader-request";
const PAYSWAP_READER_BRIDGE_RESPONSE_KIND = "payswap-account-reader-response";

const callIdSchema = z.string().min(1);
const opSchema = z.enum(["overview", "detail"]);

export type PayswapReaderBridgeRequest =
  | {
      readonly kind: typeof PAYSWAP_READER_BRIDGE_REQUEST_KIND;
      readonly callId: string;
      readonly op: "overview";
    }
  | {
      readonly kind: typeof PAYSWAP_READER_BRIDGE_REQUEST_KIND;
      readonly callId: string;
      readonly op: "detail";
      readonly connectionId: string;
    };

export type PayswapReaderBridgeResponse =
  | {
      readonly kind: typeof PAYSWAP_READER_BRIDGE_RESPONSE_KIND;
      readonly callId: string;
      readonly op: "overview" | "detail";
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: typeof PAYSWAP_READER_BRIDGE_RESPONSE_KIND;
      readonly callId: string;
      readonly op: "overview" | "detail";
      readonly ok: false;
      readonly code: "reader_error";
      readonly message: string;
    };

export type PayswapReaderBridgeMessage =
  | PayswapReaderBridgeRequest
  | PayswapReaderBridgeResponse;

/**
 * Addendum B 第 2 跳的 stdio 载波方法：桥消息作为不透明载荷装在通知帧的 params 里
 * 双向转发（agent→host = 桥请求；host→agent = 桥响应）。窗口 host 中继与 agent 侧
 * 适配器都只认这个方法名，不触碰 params 语义。
 */
export const PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD = "payswap/accountReaderBridge";

/**
 * spawn env 可用性标记（Addendum B 缺席判据）：窗口 host 在中继 main 端口在活时
 * 把 `ZCODE_PAYSWAP_READER_BRIDGE=1` 注入 agent spawn env（spawn 时快照）。agent
 * 侧见到标记才构造 stdio 适配器 + stub；标记缺席 = reader 缺席 = fail-closed 缺省
 * （headless CLI 拓扑不变）。标记在活后的中继/端口故障 = 桥法则 3 的 throw 语义，
 * 与缺席有别。
 */
export const ZCODE_PAYSWAP_READER_BRIDGE_ENV = "ZCODE_PAYSWAP_READER_BRIDGE";

/**
 * 中继路由读（Addendum B：中继不是端 —— 本函数是中继唯一的读取面）：恰读
 * `callId` 字段作路由键，非空字符串才返回，其余一律 null。**不作任何合法性裁决**
 * （zod 校验只住真正的两端）；callId 缺席的帧对中继不可路由但仍被透明转发/由端
 * 法则静默忽略。
 */
export function readPayswapReaderBridgeCallId(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const callId = (message as { callId?: unknown }).callId;
  return typeof callId === "string" && callId.length > 0 ? callId : null;
}

/** 请求 strict 校验器（法则 1：畸形请求在服务端静默忽略的判定面）。 */
export const payswapReaderBridgeRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      kind: z.literal(PAYSWAP_READER_BRIDGE_REQUEST_KIND),
      callId: callIdSchema,
      op: z.literal("overview"),
    })
    .strict(),
  z
    .object({
      kind: z.literal(PAYSWAP_READER_BRIDGE_REQUEST_KIND),
      callId: callIdSchema,
      op: z.literal("detail"),
      connectionId: z.string().min(1),
    })
    .strict(),
]);

/**
 * 响应信封 strict 校验器（法则 1）。`value` 在信封层是 `unknown` —— **值的校验是
 * per-op 的第二层**（两端各校一次：服务端法则 4 上端口前、stub 收到后），畸形值
 * 在 stub 侧落 `malformed_response`（信封合法 + 值不合法 ≠ 非响应消息）。
 */
export const payswapReaderBridgeResponseEnvelopeSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal(PAYSWAP_READER_BRIDGE_RESPONSE_KIND),
      callId: callIdSchema,
      op: opSchema,
      ok: z.literal(true),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(PAYSWAP_READER_BRIDGE_RESPONSE_KIND),
      callId: callIdSchema,
      op: opSchema,
      ok: z.literal(false),
      code: z.literal("reader_error"),
      message: z.string().min(1),
    })
    .strict(),
]);

/** per-op 值法则（投影行清单 / detail 联合 —— 叶子 schema 全部单一事实源复用）。 */
export const payswapReaderBridgeOverviewValueSchema = z.array(
  payswapConnectionStatusProjectionSchema,
);
export const payswapReaderBridgeDetailValueSchema = payswapAccountOverviewDetailSchema;

// ---------------------------------------------------------------------------
// 端口结构面（法则 7：IO 全注入 —— Electron MessagePortMain / MessagePort 由装配
// 侧适配；法则与测试零 Electron 依赖）
// ---------------------------------------------------------------------------

export interface PayswapReaderBridgePort {
  /** 发送一条桥消息（纯 JSON 对象 —— 结构化克隆安全）。 */
  post(message: PayswapReaderBridgeMessage): void;
  /** 订阅入站消息；返回退订函数。 */
  subscribe(listener: (message: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// stub 失败闭集（法则 3：一切失败 = throw）
// ---------------------------------------------------------------------------

export type PayswapReaderBridgeErrorCode =
  | "reader_error" // 服务端 face 抛出/畸形值（ok:false 中继）
  | "timeout" // 每呼叫有界时限到期（法则 6）
  | "port_closed" // 端口终结（dispose 后的挂起与新呼叫）
  | "malformed_response"; // 信封合法但值不过 per-op 法则（防御纵深）

export class PayswapReaderBridgeError extends Error {
  constructor(
    readonly code: PayswapReaderBridgeErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PayswapReaderBridgeError";
  }
}

/** 每呼叫有界时限缺省（ms）—— overview 面：单次 listConnections 投影（无 provider
 * 读）+ 余量；含一次验证读语义的 face 实现也远在其内。 */
export const PAYSWAP_READER_BRIDGE_DEFAULT_TIMEOUT_MS = 15_000;

/** detail 面的缩放缺省（ms）—— 覆盖 getOverviewData 的文档化顺序最坏情形：
 * 验证读（≤10 s adapter 时限）+ 四类别读（各 ≤10 s，顺序执行）+ 余量。
 * 15 s 的全-op 预算在该最坏情形下算术上不成立（5 × 10 s = 50 s），会误杀
 * 慢而合法的 detail 流（迟到响应被丢弃，调用方只见 timeout）。显式
 * timeoutMs 覆盖仍对两 op 全局生效。 */
export const PAYSWAP_READER_BRIDGE_DEFAULT_DETAIL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// stub（host 进程侧：broker 协调器的两个 reader 面 —— ADR-P2-2 Decision 3）
// ---------------------------------------------------------------------------

export interface PayswapReaderBridgeClientOptions {
  port: PayswapReaderBridgePort;
  /** 每呼叫时限（ms；缺省按 op 缩放 —— overview =
   * PAYSWAP_READER_BRIDGE_DEFAULT_TIMEOUT_MS，detail =
   * PAYSWAP_READER_BRIDGE_DEFAULT_DETAIL_TIMEOUT_MS；显式设置对两 op 全局覆盖）。 */
  timeoutMs?: number;
  /** callId 铸造（缺省 randomUUID；测试注入）。 */
  mintCallId?: () => string;
}

export interface PayswapReaderBridgeClient {
  /** broker 概览 reader 面（listConnections 的桥形态）。 */
  accountOverviewReader(): Promise<PayswapConnectionStatusProjection[]>;
  /** broker detail reader 面（getOverviewData 的桥形态）。 */
  accountDetailReader(connectionId: string): Promise<PayswapAccountOverviewDetail>;
  /** 端口终结：全部挂起 port_closed、退订、后续呼叫立即拒绝。 */
  dispose(): void;
}

interface PendingCall {
  readonly op: "overview" | "detail";
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: never) => void;
  readonly reject: (error: PayswapReaderBridgeError) => void;
}

export function createPayswapReaderBridgeClient(
  options: PayswapReaderBridgeClientOptions,
): PayswapReaderBridgeClient {
  const mintCallId = options.mintCallId ?? randomUUID;
  const pending = new Map<string, PendingCall>();
  let disposed = false;

  const unsubscribe = options.port.subscribe((message) => {
    const envelope = payswapReaderBridgeResponseEnvelopeSchema.safeParse(message);
    if (!envelope.success) return; // 非响应消息：静默忽略（法则 4 同款）
    const response = envelope.data;
    const entry = pending.get(response.callId);
    if (!entry) return; // 未知 callId：忽略（迟到的重复响应）
    pending.delete(response.callId);
    clearTimeout(entry.timer);
    if (!response.ok) {
      entry.reject(new PayswapReaderBridgeError("reader_error", response.message));
      return;
    }
    const valueSchema =
      response.op === "overview"
        ? payswapReaderBridgeOverviewValueSchema
        : payswapReaderBridgeDetailValueSchema;
    const value = valueSchema.safeParse(response.value);
    if (!value.success) {
      entry.reject(
        new PayswapReaderBridgeError(
          "malformed_response",
          "bridge response value failed the per-op law schema",
        ),
      );
      return;
    }
    entry.resolve(value.data as never);
  });

  function call<T>(op: "overview" | "detail", connectionId?: string): Promise<T> {
    if (disposed) {
      return Promise.reject(new PayswapReaderBridgeError("port_closed", "bridge client disposed"));
    }
    const callId = mintCallId();
    // 显式 timeoutMs 对两 op 全局覆盖；缺省按 op 缩放（detail 面的文档化顺序
    // 最坏情形装不进 overview 的单读预算 —— 见常量注释）。
    const budgetMs =
      options.timeoutMs ??
      (op === "detail"
        ? PAYSWAP_READER_BRIDGE_DEFAULT_DETAIL_TIMEOUT_MS
        : PAYSWAP_READER_BRIDGE_DEFAULT_TIMEOUT_MS);
    const request: PayswapReaderBridgeRequest =
      op === "overview"
        ? { kind: PAYSWAP_READER_BRIDGE_REQUEST_KIND, callId, op }
        : { kind: PAYSWAP_READER_BRIDGE_REQUEST_KIND, callId, op, connectionId: connectionId ?? "" };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new PayswapReaderBridgeError("timeout", `bridge call ${op} timed out after ${budgetMs}ms`));
      }, budgetMs);
      pending.set(callId, {
        op,
        timer,
        resolve: resolve as (value: never) => void,
        reject,
      });
    });
    options.port.post(request);
    return promise;
  }

  return {
    accountOverviewReader: () => call<PayswapConnectionStatusProjection[]>("overview"),
    accountDetailReader: (connectionId: string) =>
      call<PayswapAccountOverviewDetail>("detail", connectionId),
    dispose() {
      disposed = true;
      unsubscribe();
      for (const [callId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new PayswapReaderBridgeError("port_closed", "bridge client disposed"));
        pending.delete(callId);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// server（desktop main 侧：账户运行时两个绑定面的桥服务端 —— ADR-P2-2 Decision 1）
// ---------------------------------------------------------------------------

export interface PayswapReaderBridgeServerOptions {
  port: PayswapReaderBridgePort;
  /** 概览 face（生产装配 = 账户运行时绑定面）。 */
  accountOverviewReader(): Promise<PayswapConnectionStatusProjection[]>;
  /** detail face（生产装配 = 账户运行时绑定面）。 */
  accountDetailReader(connectionId: string): Promise<PayswapAccountOverviewDetail>;
}

export interface PayswapReaderBridgeServer {
  /** 停止服务（退订；在途请求完成但不再受理新请求）。 */
  stop(): void;
}

export function servePayswapReaderBridge(
  options: PayswapReaderBridgeServerOptions,
): PayswapReaderBridgeServer {
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();

  const unsubscribe = options.port.subscribe((message) => {
    const request = payswapReaderBridgeRequestSchema.safeParse(message);
    if (!request.success) return; // 法则 4：畸形/非请求消息静默忽略
    const parsed = request.data;
    // 法则 5：串行队列（响应序 = 请求序）；post 失败不摧毁队列。
    queue = queue
      .then(async () => {
        if (stopped) return;
        let response: PayswapReaderBridgeResponse;
        try {
          const value =
            parsed.op === "overview"
              ? await options.accountOverviewReader()
              : await options.accountDetailReader(parsed.connectionId);
          const valueSchema =
            parsed.op === "overview"
              ? payswapReaderBridgeOverviewValueSchema
              : payswapReaderBridgeDetailValueSchema;
          const validated = valueSchema.safeParse(value);
          if (!validated.success) {
            response = {
              kind: PAYSWAP_READER_BRIDGE_RESPONSE_KIND,
              callId: parsed.callId,
              op: parsed.op,
              ok: false,
              code: "reader_error",
              message: "reader produced a value that failed the per-op law schema",
            };
          } else {
            response = {
              kind: PAYSWAP_READER_BRIDGE_RESPONSE_KIND,
              callId: parsed.callId,
              op: parsed.op,
              ok: true,
              value: validated.data,
            };
          }
        } catch (error) {
          response = {
            kind: PAYSWAP_READER_BRIDGE_RESPONSE_KIND,
            callId: parsed.callId,
            op: parsed.op,
            ok: false,
            code: "reader_error",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        options.port.post(response);
      })
      .catch(() => undefined);
  });

  return {
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
