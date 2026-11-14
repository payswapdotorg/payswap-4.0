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

import { installDesktopPayswapConnections } from "./index.js";

/**
 * 演示（P2.2 slice 7）：连接通道的 main 装配期一次完整注册（真实依赖注入 ——
 * safeStorage/fs 缺省即生产值；此处显式示意注入面）。
 */
export function exampleDesktopPayswapConnections(input: {
  getMainWindowFrameUrl: () => string;
}): ReturnType<typeof installDesktopPayswapConnections> {
  const installation = installDesktopPayswapConnections({
    getMainWindowFrameUrl: input.getMainWindowFrameUrl,
  });
  // app-ready 预热（fail-safe：结果不缓存，失败不阻断启动）：
  //   void installation.runtime.warmup();
  // 窗口卸载/应用退出时：installation.registration.unregister()。
  return installation;
}
