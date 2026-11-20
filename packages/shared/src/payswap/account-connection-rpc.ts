/**
 * PaySwap P2.2 —— 连接 RPC 通道法则（ADR-P2-2 Decision 4：renderer 连接面落
 * desktop main —— approvalIpc 的 ipcMain.handle 模式；doc 06 §2.2「exposed over
 * an additive RPC channel」；doc 04 §1.1 operator-supplied-secret）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **请求闭集**（strict zod，discriminated on `op`）：恰四操作 ——
 *    `connect`（providerId + operatorSecret + 可选 displayName）/ `revoke` /
 *    `refresh`（connectionId）/ `list`（无参）。未知 op、多余字段、畸形值 =
 *    `malformed_request`。
 * 2. **operator 秘密的单向性**：`operatorSecret` 只出现在 connect **请求**里
 *    （renderer → main 是它的唯一必经边界 —— ADR-P2-2 Decision 4）；一切响应
 *    形状**结构上无秘密位**（per-op 结果 = 既有账户法则 schema：五行投影 /
 *    结果联合 —— redaction-by-construction，与 reader 桥同款纪律）。
 * 3. **三检先于载荷解析**：发送者三检复用 approval-origin 法则
 *    （`evaluatePayswapApprovalSender`，无 expectedWebContentsId 位 —— 连接面
 *    是应用 shell 自身的任意主框架）：主框架 + 受信 application origin（插件
 *    沙箱/`ui://` origin 永不受信）。失败 = typed `unauthorized_origin`，
 *    **载荷不解析**（不可信发送者的载荷连 schema 都不触）。
 * 4. **受信 origin 每请求现读**：`getMainWindowFrameUrl` live read →
 *    `derivePayswapTrustedAppOrigins`（approval 同款 —— 第 3 检不吃构造期
 *    快照；窗口 URL 不可得 = 空集 = fail-closed 全拒）。
 * 5. **typed refusal 作数据透传**：账户服务的 `refused` 结果（Gate E2 存储
 *    拒绝 / unknown_connection / read_back_unavailable…）原样跨 IPC —— 值语义
 *    不变，通道不吞不改（连接 UI 呈现 typed 拒绝是 Gate E2 的 E2E 条款）。
 * 6. **通道失败闭集**：`unauthorized_origin` / `malformed_request` /
 *    `internal_error`。服务抛出 = `internal_error`（message 操作员可读 ——
 *    服务法则保证零凭据材料；onInternalError 观察面可见原始错误）。**防御
 *    纵深**：服务产出经 per-op 法则校验后才上 IPC —— 畸形值本体永不渡 IPC
 *    （reader 桥服务端法则 4 同款）。
 * 7. **IO 全注入**（服务面 resolver + 主窗口 URL 来源；ipcMain 结构面由
 *    desktop 装配供给）；本模块无 Electron import（真实 IpcMainInvokeEvent
 *    结构满足 `PayswapDesktopIpcEventLike` —— typecheck 即证明）。
 */

import { z } from "zod";
import {
  payswapConnectResultSchema,
  payswapConnectionStatusProjectionSchema,
  payswapRefreshResultSchema,
  payswapRevokeResultSchema,
  type PayswapConnectResult,
  type PayswapConnectionStatusProjection,
  type PayswapRefreshResult,
  type PayswapRevokeResult,
} from "./account-connection.js";
import {
  derivePayswapTrustedAppOrigins,
  mapPayswapDesktopApprovalSender,
  type PayswapDesktopIpcEventLike,
} from "./approval-desktop.js";
import { evaluatePayswapApprovalSender } from "./approval-origin.js";

/** desktop main 的连接通道注册名（ipcMain.handle —— desktop-payswap 装配）。 */
export const PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL = "payswap:account-connections" as const;

/** 连接 RPC 的操作闭集（doc 06 §2.2 四接口面：connect/revoke/refreshEvidence/list）。 */
export const PAYSWAP_CONNECTION_RPC_OPS = ["connect", "revoke", "refresh", "list"] as const;
export type PayswapConnectionRpcOp = (typeof PAYSWAP_CONNECTION_RPC_OPS)[number];

// ---------------------------------------------------------------------------
// 请求闭集（法则 1/2）
// ---------------------------------------------------------------------------

export const payswapConnectionRpcRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("connect"),
      providerId: z.string().min(1),
      /** operator 供应的秘密（doc 04 §1.1）—— 只进不出的唯一字段。 */
      operatorSecret: z.string().min(1),
      displayName: z.string().trim().min(1).max(120).optional(),
      /**
       * P3 client-credentials 形态（PayPal）：凭据对的另一半 + operator-declared
       * 沙箱/生产模式（凭据不编码环境 —— 不猜）。operator-supplied-secret 规格
       * 的连接缺省缺席（声明了 mode 则 host 侧服务法则核对前缀一致性）。
       */
      clientId: z.string().trim().min(1).max(200).optional(),
      mode: z.enum(["test", "live"]).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("revoke"),
      connectionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("refresh"),
      connectionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("list"),
    })
    .strict(),
]);

export type PayswapConnectionRpcRequest = z.infer<typeof payswapConnectionRpcRequestSchema>;

/** per-op 结果法则（叶子全部单一事实源复用 —— 投影五行 / 结果联合）。 */
export const payswapConnectionRpcResultSchemas = {
  connect: payswapConnectResultSchema,
  revoke: payswapRevokeResultSchema,
  refresh: payswapRefreshResultSchema,
  list: z.array(payswapConnectionStatusProjectionSchema),
} as const;

// ---------------------------------------------------------------------------
// 响应闭集（法则 2/5/6）
// ---------------------------------------------------------------------------

/** 通道级 typed 失败码（闭集 —— 渲染层按码呈现，不解析 message）。 */
export type PayswapConnectionRpcErrorCode =
  | "unauthorized_origin" // 三检失败（法则 3）：主框架/受信 origin 不满足
  | "malformed_request" // 请求不在闭集内（法则 1）
  | "internal_error"; // 服务抛出 / 产出值不过 per-op 法则（法则 6）

export type PayswapConnectionRpcResponse =
  | {
      readonly ok: true;
      readonly op: PayswapConnectionRpcOp;
      readonly result:
        | PayswapConnectResult
        | PayswapRevokeResult
        | PayswapRefreshResult
        | PayswapConnectionStatusProjection[];
    }
  | {
      readonly ok: false;
      readonly code: PayswapConnectionRpcErrorCode;
      /** 操作员可读、零凭据材料。 */
      readonly message: string;
    };

export const payswapConnectionRpcResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      op: z.enum(PAYSWAP_CONNECTION_RPC_OPS),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["unauthorized_origin", "malformed_request", "internal_error"]),
      message: z.string().min(1),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// 服务面（desktop main 的受监督账户运行时 —— slice 6 的 getRuntime 语义）
// ---------------------------------------------------------------------------

/**
 * 账户服务的窄面（`PayswapAccountService` 的四操作子集 —— 类型上即满足）。
 * resolver 语义 = slice 6 的 `getRuntime()`：每请求现解析（键可用性变化时
 * main 侧按需重建运行时 —— 单写者纪律在 RPC 面的投影）。
 */
export interface PayswapConnectionRpcServiceFace {
  connect(input: {
    providerId: string;
    operatorSecret: string;
    clientId?: string;
    mode?: "test" | "live";
    displayName?: string;
  }): Promise<PayswapConnectResult>;
  revoke(input: { connectionId: string }): Promise<PayswapRevokeResult>;
  refreshEvidence(input: { connectionId: string }): Promise<PayswapRefreshResult>;
  listConnections(): Promise<PayswapConnectionStatusProjection[]>;
}

export interface PayswapDesktopConnectionHostOptions {
  /** 主窗口当前 URL（生产受信 origin 来源）—— 每请求现读（法则 4）。 */
  getMainWindowFrameUrl: () => string;
  /** 受监督账户服务的现解析面（法则 7：IO 注入）。 */
  getAccountService: () => Promise<PayswapConnectionRpcServiceFace>;
  /** internal_error 的原始错误观察面（fail-safe：不影响响应；零凭据材料由服务法则保证）。 */
  onInternalError?: (error: unknown) => void;
}

export interface PayswapDesktopConnectionHost {
  /** 真实 IPC 映射 + 三检 + 闭集解析 + 服务转发（ipcMain.handle 的处理体）。 */
  handleConnectionRequest(input: {
    ipcEvent: PayswapDesktopIpcEventLike;
    payload: unknown;
  }): Promise<PayswapConnectionRpcResponse>;
  /** 当前派生的受信 origin 集（观察面 —— 每次现读主窗口 URL）。 */
  trustedAppOrigins(): ReadonlySet<string>;
}

function refusedResponse(
  code: PayswapConnectionRpcErrorCode,
  message: string,
): PayswapConnectionRpcResponse {
  return { ok: false, code, message };
}

/**
 * 桌面连接 host（法则 1-7 的执法者）。无状态 —— 每请求现读受信 origin、
 * 现解析服务面；顺序固定：三检 → 闭集解析 → 服务调用 → per-op 校验。
 */
export function createPayswapDesktopConnectionHost(
  options: PayswapDesktopConnectionHostOptions,
): PayswapDesktopConnectionHost {
  return {
    trustedAppOrigins() {
      return derivePayswapTrustedAppOrigins(options.getMainWindowFrameUrl());
    },

    async handleConnectionRequest({ ipcEvent, payload }) {
      // 法则 3/4：三检先于一切载荷处理 —— 不可信发送者的载荷不解析。
      const sender = mapPayswapDesktopApprovalSender(ipcEvent);
      const verdict = evaluatePayswapApprovalSender({
        sender,
        trustedAppOrigins: derivePayswapTrustedAppOrigins(options.getMainWindowFrameUrl()),
      });
      if (verdict.status === "rejected") {
        return refusedResponse(
          "unauthorized_origin",
          `connection request rejected: ${verdict.reason}`,
        );
      }

      // 法则 1：请求闭集。
      const request = payswapConnectionRpcRequestSchema.safeParse(payload);
      if (!request.success) {
        return refusedResponse(
          "malformed_request",
          "connection request is not in the closed request set",
        );
      }

      try {
        const service = await options.getAccountService();
        let result: unknown;
        switch (request.data.op) {
          case "connect": {
            // P3：clientId/mode（client-credentials 形态）随请求转发 —— 服务侧
            // 规格法则决定必填性/一致性（缺省缺席 = operator 流行为不变）。
            const input = {
              providerId: request.data.providerId,
              operatorSecret: request.data.operatorSecret,
              ...(request.data.displayName !== undefined
                ? { displayName: request.data.displayName }
                : {}),
              ...(request.data.clientId !== undefined ? { clientId: request.data.clientId } : {}),
              ...(request.data.mode !== undefined ? { mode: request.data.mode } : {}),
            };
            result = await service.connect(input);
            break;
          }
          case "revoke":
            result = await service.revoke({ connectionId: request.data.connectionId });
            break;
          case "refresh":
            result = await service.refreshEvidence({ connectionId: request.data.connectionId });
            break;
          case "list":
            result = await service.listConnections();
            break;
        }
        // 法则 6（防御纵深）：per-op 法则校验后才上 IPC —— 畸形值本体永不渡 IPC。
        const valueSchema = payswapConnectionRpcResultSchemas[request.data.op];
        const validated = valueSchema.safeParse(result);
        if (!validated.success) {
          options.onInternalError?.(
            new Error(
              `connection service produced a value that failed the ${request.data.op} law schema`,
            ),
          );
          return refusedResponse(
            "internal_error",
            "connection service produced a value that failed the per-op law schema",
          );
        }
        return { ok: true, op: request.data.op, result: validated.data };
      } catch (error) {
        options.onInternalError?.(error);
        return refusedResponse(
          "internal_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
