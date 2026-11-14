/**
 * PaySwap 桌面连接通道的 Electron main 接线（ADR-P2-2 Decision 4 —— 连接受理面
 * 落 desktop main；doc 06 §2.2「exposed over an additive RPC channel」）。
 *
 * 职责分工（approvalIpc 同款）：法则/host 住 shared-payswap（单一实现纪律）；
 * 本模块是 Electron main 侧的装配 owner —— 把真实 `IpcMainInvokeEvent` 交给
 * `PayswapDesktopConnectionHost.handleConnectionRequest`（三检由法则执法），
 * 并供给主窗口 URL 作为生产受信 origin 的现读来源。
 *
 * 通道无条件注册是安全的（fail-closed）：不可信发送者得到 typed
 * `unauthorized_origin`，载荷不解析；通道注册本身不触键 store、不装配运行时
 * （运行时懒装配在 host 的 getAccountService resolver —— slice 6 的监督语义）。
 *
 * 范围（诚实声明）：本模块是接线装配（IO 全注入、typecheck 门）。真实窗口的
 * 端到端运行时臂（连接 UI 呈现 typed 拒绝 —— Gate E2 的 E2E 条款）属于连接流
 * 的 desktop Browser E2E run；main 入口的装配调用（installDesktopPayswapConnections
 * 经 desktopPayswapBootstrap）随该 run 落地（D12.7 纪律：法则与模块先行，入口
 * 接线随活的窗口证明）。
 */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  createPayswapDesktopConnectionHost,
  PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL,
  type PayswapConnectionRpcResponse,
  type PayswapConnectionRpcServiceFace,
  type PayswapDesktopConnectionHost,
} from "@zcode/shared/payswap";

export { PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL };

export interface PayswapDesktopConnectionIpcOptions {
  /** ipcMain（或测试注入面）。 */
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  /** 主窗口 webContents 的当前 URL —— 生产受信 origin 的来源（host 每请求现读）。 */
  getMainWindowFrameUrl: () => string;
  /** 受监督账户服务的现解析面（生产 = slice 6 accountRuntimeWiring 的 getRuntime → accountService）。 */
  getAccountService: () => Promise<PayswapConnectionRpcServiceFace>;
  /** internal_error 观察面（缺省 = 无操作；真实装配接 main 日志）。 */
  onInternalError?: (error: unknown) => void;
}

export interface PayswapDesktopConnectionIpcRegistration {
  host: PayswapDesktopConnectionHost;
  /** 注销（窗口卸载/测试清理）。 */
  unregister(): void;
}

/**
 * 装配并注册桌面连接通道：`ipcMain.handle(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL,
 * (event, payload) => host.handleConnectionRequest({ipcEvent: event, payload}))`。
 * 真实 IpcMainInvokeEvent 结构满足法则的映射面 —— typecheck 即证明。
 */
export function installPayswapDesktopConnectionIpc(
  options: PayswapDesktopConnectionIpcOptions,
): PayswapDesktopConnectionIpcRegistration {
  const host = createPayswapDesktopConnectionHost({
    getMainWindowFrameUrl: options.getMainWindowFrameUrl,
    getAccountService: options.getAccountService,
    ...(options.onInternalError !== undefined
      ? { onInternalError: options.onInternalError }
      : {}),
  });
  const handler = (event: IpcMainInvokeEvent, payload: unknown): Promise<PayswapConnectionRpcResponse> =>
    host.handleConnectionRequest({ ipcEvent: event, payload });
  options.ipcMain.handle(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL, handler);
  return {
    host,
    unregister() {
      options.ipcMain.removeHandler(PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL);
    },
  };
}
