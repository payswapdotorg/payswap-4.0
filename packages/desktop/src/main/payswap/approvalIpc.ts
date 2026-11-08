/**
 * PaySwap 桌面批准通道的 Electron main 接线（addendum §1.6.2 item 3 的桌面装配半；
 * ADR-12 D12.7 ——「the real IPC mapping, the production trusted-origin value …
 * arrive with the surface work」）。
 *
 * 职责（法则/映射/host 住 shared-payswap —— 单一实现纪律；本模块是 Electron main
 * 侧的装配 owner）：
 * - 把 `ipcMain.handle` 的**真实** `IpcMainInvokeEvent`（sender.id / senderFrame /
 *   sender.mainFrame —— 结构满足法则的 `PayswapDesktopIpcEventLike`）交给
 *   `host.handleApprovalResolution`（三检由法则执法：expected webContents →
 *   main frame → trusted application origin）。
 * - 生产受信 origin 值：`getMainWindowFrameUrl`（主窗口 webContents 的当前 URL）——
 *   host 每次解析事件前现读派生（dev http origin / 打包 file:// origin；空 = 全拒）。
 * - 通道无条件注册是安全的：无 pending proposal 的事件得到 typed
 *   `proposal_unknown`（fail-closed）；发卡面另有 T3 金融模式 live 读门。
 *
 * 范围（诚实声明）：本模块是接线装配（全部 IO 注入、typecheck 门）；真实窗口/真实
 * ipcMain 的端到端运行时臂与发卡调用方（P2+ request_authorization）属于 roadmap 登记
 * 的 desktop Browser E2E run —— 那次 run 把本模块装进 desktop main 入口并供给真实
 * 的 getMainWindowFrameUrl / financialMode reader。
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  createPayswapDesktopApprovalHost,
  PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
  type PayswapDesktopApprovalHost,
} from "@zcode/shared/payswap";

export { PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL };

export interface PayswapDesktopApprovalIpcOptions {
  /** ipcMain（或测试注入面）。 */
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  /** 主窗口 webContents 的当前 URL —— 生产受信 origin 的来源（host 每次解析前现读）。 */
  getMainWindowFrameUrl: () => string;
  /**
   * T3 金融模式 live 读（addendum §2.2 T3）：发卡门；非 active = 拒发
   * financial_mode_inactive。桌面侧真实 reader（插件 userConfig 投影）由
   * desktop E2E 装配接线时供给。
   */
  financialMode: () => { active: boolean };
  now?: () => number;
  /** 既有 host（测试/复用注入）；缺省自建。 */
  host?: PayswapDesktopApprovalHost;
}

export interface PayswapDesktopApprovalIpcRegistration {
  host: PayswapDesktopApprovalHost;
  /** 注销（窗口卸载/测试清理）。 */
  unregister(): void;
}

/**
 * 装配并注册桌面批准通道：`ipcMain.handle(PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
 * (event, payload) => host.handleApprovalResolution({ipcEvent: event, payload}))`。
 * 真实 IpcMainInvokeEvent 结构满足法则的映射面 —— typecheck 即证明。
 */
export function installPayswapDesktopApprovalIpc(
  options: PayswapDesktopApprovalIpcOptions,
): PayswapDesktopApprovalIpcRegistration {
  const host =
    options.host ??
    createPayswapDesktopApprovalHost({
      getMainWindowFrameUrl: options.getMainWindowFrameUrl,
      financialMode: options.financialMode,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  const handler = (event: IpcMainInvokeEvent, payload: unknown) =>
    host.handleApprovalResolution({ ipcEvent: event, payload });
  options.ipcMain.handle(PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL, handler);
  return {
    host,
    unregister() {
      options.ipcMain.removeHandler(PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL);
    },
  };
}
