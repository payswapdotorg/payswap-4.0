/**
 * PaySwap §8 会话解析与工作区隔离的类型与法则（契约 w2-01 §8；Step 5 落地）。
 *
 * 法则（§8.1，normative）：broker **永不**从请求载荷取得会话身份。连接的已验证实例
 * （§5.2）映射到其注册 scope（§10.1）；会话记录经 shipped `requireSession` 模式
 * （`server-types.ts` 的 readiness + record lookup）**权威下游解析** —— 私有 socket
 * token 证明来源；会话被解析，而非被声明。
 *
 * 法则（§8.2）：连接绑定三元组（已验证 pid → host 注册插件实例 → session scope）。
 * 该连接上的一切请求都在此绑定内解析；sessionId hint 与绑定可解析 scope 不符 →
 * `session_unresolvable` —— hint 只能收窄，永不放宽。判定字段是注册条目的
 * **sessionScope**（不是 workspace 字段）：Wave 3 服务端 operator-principal 会把
 * scope 收窄到工作区之下，本判定随之收窄而无需改动 workspace 侧。
 *
 * 法则（§8.3）：实例注册携带其工作区；请求只能在该工作区内解析；params 命名**其它
 * 工作区实体**（账户/路由/evidence URI）→ `workspace_mismatch`。跨工作区可达性即使
 * 只读也拒绝 —— §1.6.3 item 9 的 (operator, workspace) 绑定纪律在 Wave 3 服务端化
 * 之前，先在此处对本地情形结构性执行。
 *
 * 执行位置（ADR-8 D8.1）：§5.5 步 (4)（实例/注册表绑定）之后、预留的步 (5)（重放，
 * Step 6）之前。理由：addendum §3.5 item 5 把 session scope 并入绑定三元组本身；
 * §9.3(1)/(4) 的原子 accept-and-mark 边界在 dedupe 步 —— §8 拒绝的请求**不得**烧序列
 * （pre-dispatch 拒绝 ≠ accepted for dispatch；child 可原样重发同一逻辑请求或经
 * retiredSeqs 退役）。disable 撤销臂（ADR-5 D5.6）绕过 §8：注册表撤销是权威，被撤销
 * 实例无会话/实体 oracle。
 *
 * 实体解析端口（§8.3）：返回 params 所命名实体归属的工作区键；**null = 未命名实体或
 * 实体不可解析**（未知 id 不构成 mismatch —— 那是三码法则的业务层；§8.3 只惩罚**已知**
 * 的跨工作区引用）。Wave 2 生产不接线（无实体存储，§13）—— 端口与法则由注入行证明，
 * P2 的账户存储落地时接线。
 */

import type { PayswapBrokerOp } from "@zcode/shared/payswap";

/** §8.1 权威解析的答案：会话经 requireSession 模式解析后的工作区绑定。 */
export interface PayswapResolvedSessionScope {
  /**
   * 已解析会话的工作区键（ZCodeWorkspaceRef.workspaceKey —— identity||path 的
   * resolveWorkspaceKey 约定；与 mcp.ts 注入 scope 同式）。键式失配 → fail-closed
   * （session_unresolvable），绝不放宽。
   */
  workspaceKey: string;
}

/**
 * §8.1 resolver 端口：把 sessionId hint 经宿主会话运行时权威解析。**null = 不可解析**
 * （runtime 未就绪 / 记录缺失 / 一切失败 —— fail-closed）；抛错同 null 处理
 * （requireSession 的 typed sessionUnavailable 即"不可解析"的域答案，无细节外泄）。
 */
export type PayswapSessionScopeResolver = (
  sessionIdHint: string,
) => PayswapResolvedSessionScope | null | Promise<PayswapResolvedSessionScope | null>;

/**
 * §8.3 实体工作区端口：params 命名的实体归属的工作区键，或 null（未命名/未知 —— 落到
 * 三码法则的业务层）。抛错 = 未预期的 host 侧失败 → internal_error（D7.7 同款分类）。
 */
export type PayswapEntityWorkspaceResolver = (
  op: PayswapBrokerOp,
  params: unknown,
) => string | null | Promise<string | null>;

/**
 * §8.2 绑定法则（纯）：已解析会话必须在注册条目的 **sessionScope**（可解析 scope）内。
 * broker 自行执行本判定，不委托 resolver —— hint-永不-放宽是 broker 的法则，不是
 * resolver 的善意。workspace 字段相等**不豁免**（实体隔离才用 workspace；会话解析只认
 * sessionScope）。
 */
export function isSessionWithinBindingScope(
  registration: { sessionScope: string },
  resolved: PayswapResolvedSessionScope,
): boolean {
  return resolved.workspaceKey === registration.sessionScope;
}
