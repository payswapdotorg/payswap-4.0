/**
 * desktop-payswap 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */

import type { IpcMain } from "electron";
import type { PayswapDesktopApprovalHost } from "@zcode/shared/payswap";
import type { ResolvePayswapBrokerPeerHelperSupplyOptions } from "./brokerPeerHelperSupply.js";

export interface PayswapDesktopApprovalIpcOptions {
  /** ipcMain（或测试注入面）。 */
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  /** 主窗口 webContents 的当前 URL —— 生产受信 origin 的来源（host 每次解析前现读）。 */
  getMainWindowFrameUrl: () => string;
  /**
   * T3 金融模式 live 读：发卡门；非 active = 拒发 financial_mode_inactive（fail-closed）。
   * 前置：桌面侧真实 reader（插件 userConfig 投影）由 desktop E2E 装配供给。
   */
  financialMode: () => { active: boolean };
  now?: () => number;
  /** 既有 host（测试/复用注入）；缺省自建。 */
  host?: PayswapDesktopApprovalHost;
}

export interface PayswapDesktopApprovalIpcRegistration {
  /** 装配好的 host（发卡 in-process API —— P2+ request_authorization 接线的调用面）。 */
  host: PayswapDesktopApprovalHost;
  /** 注销（窗口卸载/测试清理）；幂等。 */
  unregister(): void;
}

export interface DesktopPayswapContract {
  /**
   * 装配并注册桌面批准通道（ipcMain.handle —— 真实 IpcMainInvokeEvent 结构满足
   * 法则的映射面，typecheck 即证明）。前置：调用发生在 Electron main 进程装配期。
   * 后置：通道上的每个事件都经过法则三检（expected webContents → main frame →
   * trusted application origin）；无 pending proposal = typed proposal_unknown。
   */
  installPayswapDesktopApprovalIpc(
    options: PayswapDesktopApprovalIpcOptions,
  ): PayswapDesktopApprovalIpcRegistration;

  /**
   * 解析随包的 Windows peer-verification helper 对（resources/payswap-broker-peer/
   * {manifest.json,<binary>}；dev 回退 bundled-tools 相对路径族）并在注入时验证
   * digest（尺寸 + SHA-256 对 manifest 重算；ADR-15 D15.4）。
   * 前置：调用方传入 isPackaged/resourcesPath 与 operator env（缺省 process.env）。
   * 后置：合法且 operator 未设任一供给键 → 返回
   * PAYSWAP_BROKER_HELPER_{PATH,SHA256} 两键 env；任何失配（损坏 manifest/target
   * 失配/digest 失配/缺文件/非 win32/null helper）→ 返回空对象（诚实不注入，
   * agent 落 degraded_refusing）。幂等：纯读取与重算，不落盘。spawn 时的
   * verifyHelperBinary（shared-payswap，D13.4）保持单一验证点。
   */
  resolvePayswapBrokerPeerHelperSupply(
    options: ResolvePayswapBrokerPeerHelperSupplyOptions,
  ): Readonly<Record<string, string>>;
}
