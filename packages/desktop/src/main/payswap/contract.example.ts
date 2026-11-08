/**
 * desktop-payswap 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import { installPayswapDesktopApprovalIpc } from "./index.js";

/** 演示：Electron main 装配期的一次完整注册（全部真实依赖注入）。 */
export function exampleDesktopPayswapApprovalIpc(input: {
  ipcMain: Parameters<typeof installPayswapDesktopApprovalIpc>[0]["ipcMain"];
  getMainWindowFrameUrl: () => string;
  financialMode: () => { active: boolean };
}): ReturnType<typeof installPayswapDesktopApprovalIpc> {
  const registration = installPayswapDesktopApprovalIpc({
    ipcMain: input.ipcMain,
    getMainWindowFrameUrl: input.getMainWindowFrameUrl,
    financialMode: input.financialMode,
  });
  // 窗口卸载/应用退出时：registration.unregister()。
  return registration;
}
