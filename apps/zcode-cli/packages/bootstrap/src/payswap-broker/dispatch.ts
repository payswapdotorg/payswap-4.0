/**
 * PaySwap 闭集六操作 dispatch 表（契约 w2-01 §7；Step 4 落地，P2.2 slice 3 扩展
 * account-overview 真数据半）。
 *
 * §7.2（N21，normative）：dispatch 是**代码里的闭集 enum → handler map**，不是可注册
 * 的 registry —— 无 ServiceChannels 通路、无任意 host-service 调用、无反射、无
 * passthrough、无"raw service"逃生门、无把 service/channel 名当数据的操作。闭集表即
 * `PAYSWAP_OPERATION_PARAMS_SCHEMAS`（op → per-op schema 的字面 map，§7.1 六操作，
 * 无第七个）。op 越枚举先死在 §6.1 schema（request_invalid）；表查找未命中是 schema
 * 后面的皮带扣（operation_not_found，§6.3），dispatches nothing。
 *
 * §7.3 三码法则：每个操作按 broker 观察到的 live 状态回答业务拒绝 —— 插件禁用/卸载
 * → financial_mode_disabled；enabled + 未 opt-in（S1）→ not_opted_in；enabled +
 * opted-in + 无账户（S2）→ not_connected。live 状态经注入的 reader **每次 dispatch
 * 现读**（非 boot 快照 —— T2/T3 live-flip 的基础，§10.2(3)）。reader 缺省 →
 * not_connected（S2 默认：所有码都是拒绝）；reader 抛错 → internal_error（§6.3，无细节
 * 外泄）。
 *
 * P2.2 slice 3（§7.3「Read-only account data arrives with P2's Gate E2」的兑现）：
 * `get_account_overview` 在 **live 状态实读为 enabled + opted-in** 且注入的
 * `accountOverviewReader` 读回非空时回答真数据 `{kind:"overview", connections}`
 * （shared `PayswapAccountOverviewData` —— 五字段状态投影，schema 级无秘密）。
 * 法则序：三码法则优先于数据路径（disable 撤销 / 未 opt-in 永不触 overview
 * reader）；live 状态未实读（reader 缺席的 S2 默认）同样不触 —— 数据永不绕过
 * opt-in 门。空清单 / 未知 connectionId → `not_connected`（该工作区的已连接集合
 * 之为空/不含所求 —— S2 唯一真话，永不是空概览）；`connectionId` 收窄所求行。
 * reader 抛错 → internal_error（§6.3，与 liveStateReader 同类）。闭表保持：其余
 * 五操作维持 §7.3 拒绝语义（各自领域 —— intent/eligibility/routing/grant/
 * execution —— 随其切片落地，届时 not_connected 的 S2 前置由各领域自身证据驱动）。
 *
 * §7.4 dormant grant hook：`request_authorization` 的 dispatch 层预留 grant 校验步骤，
 * Wave 2 **休眠** —— 不铸造、不校验、不存储任何 grant；`authorizationId` 不是 Wave 1
 * 已知 params 键（§6.1(3) 1:1），schema 层即拒（Step 7 套件断言其永不到达 grant 逻辑）。
 *
 * §10.2 + ADR-5 D5.6：disable 撤销（注册表 tombstone reason "disabled"）的实例不走
 * instance_unknown 桥接错误 —— 绑定完成后按 financial_mode_disabled 业务拒绝回答
 * （注册表撤销是权威，无需 reader 佐证）；exit/superseded tombstone 仍走
 * instance_unknown（server.ts §5.5 步 (4)）。
 */

import {
  PAYSWAP_OPERATION_PARAMS_SCHEMAS,
  payswapBusinessRefusal,
  type PayswapAccountOverviewData,
  type PayswapBrokerOp,
  type PayswapBrokerResponseBody,
  type PayswapConnectionStatusProjection,
} from "@zcode/shared/payswap";

/** broker 观察到的 live 金融模式状态（§7.3 live 读，非子进程 env 快照）。 */
export interface PayswapBrokerLiveState {
  /** 官方 PaySwap 插件当前是否启用（enabled map；禁用/卸载 = false）。 */
  pluginEnabled: boolean;
  /** userConfig.financialWorkspace 当前 opt-in 状态。 */
  financialWorkspace: boolean;
}

/** live 状态 reader：每次 dispatch 现读；抛错 → internal_error（§6.3）。 */
export type PayswapLiveStateReader = () => PayswapBrokerLiveState | Promise<PayswapBrokerLiveState>;

/**
 * account-overview reader（P2.2 slice 3）：本 broker 绑定作用域（工作区）的连接
 * 状态投影清单 —— host 装配侧把它接到账户服务的 listConnections（每次 dispatch
 * 现读，非 boot 快照）。返回的投影由 shared 法则投影面保证无秘密。抛错 →
 * internal_error（§6.3，与 liveStateReader 同类）。
 */
export type PayswapAccountOverviewReader =
  () => readonly PayswapConnectionStatusProjection[] | Promise<readonly PayswapConnectionStatusProjection[]>;

/** §5.5 步 (4) 之后的实例绑定状态：live，或 disable 撤销（D5.6 流通到三码法则）。 */
export type PayswapInstanceBinding = "live" | "disabled_revocation";

export interface PayswapDispatchRequest {
  instanceId: string;
  seq: number;
  op: PayswapBrokerOp;
  /** per-op schema 校验前的原始 params（unknown，§6.1 params record）。 */
  params: unknown;
}

export type PayswapDispatchResult =
  | { kind: "dispatched"; body: PayswapBrokerResponseBody }
  | { kind: "refused"; code: "operation_not_found" | "request_invalid" | "internal_error"; retryable: false };

export interface PayswapBrokerDispatchOptions {
  /** live 状态 reader（缺省 → S2 not_connected：所有码都是拒绝，§13 无账户无条件为真）。 */
  liveStateReader?: PayswapLiveStateReader;
  /**
   * account-overview reader（P2.2 slice 3；缺省 → 概览不答数据，`not_connected`
   * 保持唯一真话）。仅当 live 状态**实读**为 enabled + opted-in 时被咨询（三码
   * 法则优先于数据路径 —— 数据永不绕过 opt-in 门）。
   */
  accountOverviewReader?: PayswapAccountOverviewReader;
}

export interface PayswapBrokerDispatch {
  /** 解析一个已通过 §5.5 步 (1)-(4) 的请求（peer/token/绑定已过）。 */
  resolveRequest(
    request: PayswapDispatchRequest,
    context?: { instanceBinding?: PayswapInstanceBinding },
  ): Promise<PayswapDispatchResult>;
}

/** §7.3 表第 1 行：插件禁用/卸载（残留调用）→ financial_mode_disabled（§10.2(2)）。 */
const DISABLED_REFUSAL = "financial_mode_disabled" as const;

/**
 * 创建闭集 dispatch 表（§7）。belt：`op` 不在表内（类型系统不可达；schema 被绕过时）
 * → operation_not_found，绝不崩溃、绝不分发（N21）。
 */
export function createPayswapBrokerDispatch(
  options: PayswapBrokerDispatchOptions = {},
): PayswapBrokerDispatch {
  const liveStateReader = options.liveStateReader;
  const accountOverviewReader = options.accountOverviewReader;
  return {
    async resolveRequest(request, context) {
      const schema = PAYSWAP_OPERATION_PARAMS_SCHEMAS[request.op as PayswapBrokerOp];
      if (schema === undefined) {
        // N21 皮带扣：schema 枚举之后的第二道闭集防线。
        return { kind: "refused", code: "operation_not_found", retryable: false };
      }
      const params = schema.safeParse(request.params);
      if (!params.success) {
        // §6.1(3)：per-op schema 违例 → request_invalid（绑定后的桥接拒绝，请求归属信封）。
        return { kind: "refused", code: "request_invalid", retryable: false };
      }
      // 三码法则（§7.3）。disable 撤销（D5.6）优先于 reader —— 注册表 tombstone 是权威。
      let code: "not_opted_in" | "not_connected" | "financial_mode_disabled";
      let stateWasRead = false;
      if (context?.instanceBinding === "disabled_revocation") {
        code = DISABLED_REFUSAL;
      } else if (liveStateReader === undefined) {
        // 缺省：S2 not_connected —— 所有码都是拒绝；无账户数据接线（§13）。
        code = "not_connected";
      } else {
        let state: PayswapBrokerLiveState;
        try {
          state = await liveStateReader();
        } catch {
          // reader 故障 = 未预期的 host 侧失败：typed internal_error，无细节外泄（§6.3）。
          return { kind: "refused", code: "internal_error", retryable: false };
        }
        stateWasRead = true;
        code = !state.pluginEnabled
          ? DISABLED_REFUSAL
          : !state.financialWorkspace
            ? "not_opted_in"
            : "not_connected";
      }
      // P2.2 slice 3 数据路径：三码法则已判定 enabled + opted-in（not_connected 终态
      // 且状态**实读**）时，get_account_overview 咨询注入的概览 reader。数据永不
      // 绕过 opt-in 门 —— live 状态未实读（reader 缺席默认）不触。
      if (
        code === "not_connected" &&
        stateWasRead &&
        request.op === "get_account_overview" &&
        accountOverviewReader !== undefined
      ) {
        let connections: readonly PayswapConnectionStatusProjection[];
        try {
          connections = await accountOverviewReader();
        } catch {
          // 概览 reader 故障 = 未预期的 host 侧失败（§6.3，与 liveStateReader 同类）。
          return { kind: "refused", code: "internal_error", retryable: false };
        }
        // connectionId 收窄（params 已过 per-op strict schema）：所求行不在本作用域的
        // 已连接集合 → not_connected（S2 对该所求为真；跨工作区不可证，§8.3 不越权
        // 声称）。全清单非空才答概览 —— 空清单是 S2 的唯一真话。
        const requestedConnectionId = (params.data as { connectionId?: string }).connectionId;
        const narrowed =
          requestedConnectionId === undefined
            ? connections
            : connections.filter((connection) => connection.connectionId === requestedConnectionId);
        if (narrowed.length > 0) {
          const data: PayswapAccountOverviewData = { kind: "overview", connections: narrowed };
          return {
            kind: "dispatched",
            body: { ok: true, seq: request.seq, data },
          };
        }
      }
      return {
        kind: "dispatched",
        body: { ok: true, seq: request.seq, data: payswapBusinessRefusal(code) },
      };
    },
  };
}
