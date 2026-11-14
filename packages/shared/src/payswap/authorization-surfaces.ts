/**
 * PaySwap N25 授权样式表面法则（addendum §1.6.0 —— Class B 授权卡「not
 * declarable in `ui.surfaces[]`」；P1 验收矩阵 N25 行的宿主侧门）。
 *
 * 法则（normative，§1.6.0 原文）：「A … plugin manifest that declares an
 * authorization-styled surface in `ui.surfaces[]` (or a tool with `_meta.ui`
 * naming one) is rejected at manifest validation — N25.」授权卡是 host 在受信
 * renderer 渲染的 Class B 表面；插件表面永远渲染在 `zcode-sandbox://` 沙箱
 * origin 内 —— 任何以 id/标题伪装授权（批准/授予/同意）语义的表面声明，都是对
 * Class B 边界的冒充尝试（沙箱内钓鱼授权卡）。门在清单验证处整体拒绝：插件不
 * 加载（fail-closed），而非只丢弃该表面项。
 *
 * 样式判定：表面 id 与全部 locale 标题对 `authori[sz]|approv|grant|consent` 的
 * 不区分大小写子串匹配（授权/批准/授予/同意四族语义）。误伤代价是一个表面换
 * 名；漏放代价是伪造授权面 —— 按安全姿态取窄义 fail-closed。
 *
 * 「工具 `_meta.ui` 命名一面」的臂：现行 `_meta.ui` 只承载 visibility
 * （bootstrap mcp-ui contract），不承载表面引用；授权样式表面在本门整体拒绝后，
 * 命名无从绑定到任何已声明表面 —— 该臂由本门 + N26（插件回调路径不是批准通道）
 * 共同覆盖。
 *
 * 纯法则（无 IO；结构化最小输入类型，宿主装配见 adapters plugins 装载循环）。
 */

/** 与清单解析产物结构兼容的最小表面形状（id + 单串或 locale 映射标题）。 */
export interface PayswapUiSurfaceLike {
  id: string;
  title: string | Record<string, string>;
}

const AUTHORIZATION_SURFACE_STYLE_PATTERN = /authori[sz]|approv|grant|consent/i;

export function isPayswapAuthorizationStyledSurface(surface: PayswapUiSurfaceLike): boolean {
  if (AUTHORIZATION_SURFACE_STYLE_PATTERN.test(surface.id)) return true;
  const title = surface.title;
  if (typeof title === "string") {
    return AUTHORIZATION_SURFACE_STYLE_PATTERN.test(title);
  }
  return Object.values(title ?? {}).some((value) =>
    AUTHORIZATION_SURFACE_STYLE_PATTERN.test(value),
  );
}

export function findPayswapAuthorizationStyledSurfaces<T extends PayswapUiSurfaceLike>(
  surfaces: readonly T[],
): T[] {
  return surfaces.filter((surface) => isPayswapAuthorizationStyledSurface(surface));
}

/**
 * 整体拒绝的诊断消息（无命中返回 null —— 调用方据此放行）。消息是法则的一部分：
 * 拒绝理由必须指向 Class B 不可声明这一 normative 事实（N25），不是泛化的
 * 「invalid surface」。
 */
export function payswapAuthorizationSurfaceRejectionMessage(
  surfaces: readonly PayswapUiSurfaceLike[],
): string | null {
  const rejected = findPayswapAuthorizationStyledSurfaces(surfaces);
  if (rejected.length === 0) return null;
  return `Plugin ui.surfaces: authorization-styled surface declarations are rejected — the authorization card is host-rendered Class B and never declarable (N25): ${rejected
    .map((surface) => surface.id)
    .join(", ")}`;
}
