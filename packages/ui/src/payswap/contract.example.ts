/**
 * ui-payswap 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { createPayswapSurfaceContentRegistry, runPayswapSurfaceOptOutRevocation } from "@zcode/shared/payswap";
import {
  bindPayswapSurfaceRevocationDeps,
  registerPayswapSurfaceInstance,
  type PayswapUiSurfaceTeardownTarget,
} from "./index.js";

/** 演示：一次完整的「入册 → opt-out 撤销」装配（IO 目标由页面 owner 供给）。 */
export function exampleUiPayswapSurfaceLifecycle(
  target: PayswapUiSurfaceTeardownTarget,
  instance: Parameters<typeof registerPayswapSurfaceInstance>[0]["handle"],
): ReturnType<typeof runPayswapSurfaceOptOutRevocation> {
  const registry = createPayswapSurfaceContentRegistry();
  // 1) 实例入册（真实 builder 键 + 提取租约 —— token 不入册）。
  registerPayswapSurfaceInstance({
    registry,
    target: {
      workspacePath: "/home/dev/workspace",
      sessionId: "session-1",
      pluginId: "payswap@zcode-plugins-official",
      serverName: "gateway",
      resourceUri: "payswap://workspace-panel",
    },
    scope: { kind: "surface", surfaceId: "workspace-panel" },
    handle: instance,
    anchor: "replace",
  });
  // 2) 受保护账户数据投递到该键后打标（has-ever-received —— opt-out 撤销的依据）。
  registry.markProtectedDataDelivered(
    JSON.stringify([
      JSON.stringify(["/home/dev/workspace", "session-1"]),
      "payswap@zcode-plugins-official",
      "gateway",
      "payswap://workspace-panel",
      "surface:workspace-panel",
    ]),
  );
  // 3) opt-out：执行器 + 真实原语绑定 deps（守护窗与上游拆除窗同源）。
  return runPayswapSurfaceOptOutRevocation(
    registry,
    bindPayswapSurfaceRevocationDeps({ target }),
  );
}
