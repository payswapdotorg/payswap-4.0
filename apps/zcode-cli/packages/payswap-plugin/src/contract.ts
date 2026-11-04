/**
 * PaySwap 插件契约（Wave 1 骨架）。
 *
 * 纪律（P0 附录 §9，normative）：MCP server 进程不持有任何金融状态、凭据或账本访问。
 * 六个 `payswap_*` 工具是 thin proxy；真实数据与拒绝判定属于 host 侧 broker（附录 §3.2）。
 * Wave 1 没有 broker：refusal 判定基于启动时的 `PAYSWAP_FINANCIAL_WORKSPACE` env 快照
 * （来自 manifest `${user_config.financialWorkspace}` 解析），live-flip 语义（T2/T3）由
 * Wave 2 的 broker 实现——本文件的行为与 broker 语义结构等价（相同的 typed codes）。
 */

export const SERVER_NAME = "payswap";
export const PLUGIN_VERSION = "0.1.0";

/** `ui://` 资源的 MIME（mcp-app 契约，packages/shared/src/mcp-apps/contract.ts:10）。 */
export const PANEL_MIME_TYPE = "text/html;profile=mcp-app";

/** manifest `userConfig.financialWorkspace` 经 `${user_config.financialWorkspace}` 注入的 env 键。 */
export const FINANCIAL_WORKSPACE_ENV = "PAYSWAP_FINANCIAL_WORKSPACE";

/** 六工具（交付物 05 §9）；顺序即注册顺序。 */
export const TOOL_NAMES = [
  "payswap_compile_intent",
  "payswap_check_eligibility",
  "payswap_discover_routes",
  "payswap_request_authorization",
  "payswap_get_execution_status",
  "payswap_get_account_overview",
] as const;
export type PayswapToolName = (typeof TOOL_NAMES)[number];

/**
 * 状态拒绝码（附录 §2.1，三个 typed code 不得混淆）：
 * - `not_opted_in`            S1：插件启用、用户未 opt-in（financialWorkspace=false）
 * - `not_connected`           S2：已 opt-in、尚无已连接账户
 * - `financial_mode_disabled` 残留调用：禁用/卸载前的旧会话（Wave 1 不可达——需要 broker
 *   绑定撤销；Wave 2+ 实现。此处仅定义类型保持三个 code 的单一事实源）
 */
export type PayswapRefusalCode = "not_opted_in" | "not_connected" | "financial_mode_disabled";

export interface PayswapRefusal {
  code: PayswapRefusalCode;
  message: string;
}

/** 所有 `payswap_*` 工具的统一响应信封：业务数据或 typed refusal，永不裸错误。 */
export type PayswapToolEnvelope<T = unknown> =
  | { kind: "ok"; data: T }
  | { kind: "refused"; refusal: PayswapRefusal };

/** Class A 信息性表面（附录 §1.6.0）：全部为 informational；authorization 卡是 Class B，
 * 由 host 渲染，永不声明在 `ui.surfaces[]`（N25）。 */
export const SURFACES = [
  {
    id: "workspace",
    resourceUri: "ui://payswap/workspace.html",
    title: { "en-US": "PaySwap Workspace", "zh-CN": "PaySwap 金融工作区" },
    icon: "wallet",
  },
  {
    id: "route-plan",
    resourceUri: "ui://payswap/route-plan.html",
    title: { "en-US": "Route Plan", "zh-CN": "路线计划" },
    icon: "route",
  },
  {
    id: "evidence",
    resourceUri: "ui://payswap/evidence.html",
    title: { "en-US": "Evidence", "zh-CN": "凭据与证据" },
    icon: "receipt",
  },
] as const;
export type PayswapSurfaceId = (typeof SURFACES)[number]["id"];

/** Wave 1 的快照式金融模式状态（env 解析结果）。 */
export function readFinancialWorkspaceSnapshot(env: NodeJS.ProcessEnv): boolean {
  return env[FINANCIAL_WORKSPACE_ENV] === "true";
}

/** Wave 1 的统一拒绝：未 opt-in → `not_opted_in`；已 opt-in 无账户 → `not_connected`。 */
export function snapshotRefusal(financialWorkspace: boolean): PayswapRefusal {
  return financialWorkspace
    ? {
        code: "not_connected",
        message:
          "PaySwap financial workspace is enabled, but no account is connected yet. " +
          "Connect a provider account before using financial tools.",
      }
    : {
        code: "not_opted_in",
        message:
          "PaySwap financial workspace is not enabled. Turn on the 'Financial workspace' " +
          "option in the PaySwap plugin settings, then try again.",
      };
}

/** 信封序列化（工具返回的 JSON 文本）。 */
export function envelopeText<T>(envelope: PayswapToolEnvelope<T>): string {
  return JSON.stringify(envelope);
}
