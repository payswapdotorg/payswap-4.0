/**
 * PaySwap 桌面批准通道的 desktop main 入口接线（ADR-12 D12.7 ——「the real IPC
 * mapping, the production trusted-origin value … arrive with the surface work」；
 * playbook P1.8 desktop Browser E2E run 携带的注册半）。
 *
 * 装配内容（法则住 shared-payswap；desktop-payswap 模块是装配 owner）：
 * - `installPayswapDesktopApprovalIpc`：真实 ipcMain.handle 注册（通道无条件注册
 *   是安全的 —— 无 pending proposal 的事件 typed proposal_unknown，fail-closed）。
 * - **生产受信 origin 来源**：主窗口 webContents 的当前 URL（host 每次解析事件前
 *   现读 —— 三检第 3 检不吃构造期快照；无窗口/空 URL = 空集 = 全拒）。
 * - **T3 financialMode live reader**：真实 `~/.zcode/cli/config.json` fresh 读
 *   （financialModeReader —— 与 agent 同一配置文件的 S2 投影）。
 * - **卡面推送**：withPayswapCardPush 绑定 webContents 定向发送 + 全窗口广播。
 * - **E2E 观察桥**（shouldEnableE2ETestBridge 同款门）：测试进程内发卡/撤销/观察
 *   —— P2+ 的 request_authorization 接线落地前的发卡调用方（D12.6：issuance 是
 *   in-process host API；E2E 桥是它在测试环境的入口，不新增任何网络面）。
 */

import { BrowserWindow, ipcMain, webContents } from "electron";
import {
  createPayswapDesktopApprovalHost,
  PAYSWAP_DESKTOP_CARD_CHANNEL,
} from "@zcode/shared/payswap";
import { shouldEnableE2ETestBridge } from "@zcode/shared";
import {
  installPayswapDesktopApprovalIpc,
  PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
  type PayswapDesktopApprovalIpcRegistration,
} from "./approvalIpc.js";
import { withPayswapCardPush } from "./cardPush.js";
import { createDesktopPayswapFinancialModeReader } from "./financialModeReader.js";

/** E2E 观察桥的进程内挂点（仅 shouldEnableE2ETestBridge 为真时存在）。 */
export interface PayswapDesktopApprovalE2EBridge {
  host: ReturnType<typeof withPayswapCardPush>;
  registration: PayswapDesktopApprovalIpcRegistration;
  channel: typeof PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL;
}

/** globalThis 挂点（结构化访问面 —— 测试进程内读取；未挂 = undefined）。 */
type PayswapE2EBridgeGlobal = typeof globalThis & {
  __zcodePayswapDesktopApprovalE2E?: PayswapDesktopApprovalE2EBridge;
};

export interface InstallDesktopPayswapApprovalOptions {
  /** 主窗口 URL 的现读来源（生产受信 origin；空/无窗口 = fail-closed 全拒）。 */
  getMainWindowFrameUrl: () => string;
  /** T3 金融模式 live reader（缺省 = 真实 config fresh 读）。 */
  financialMode?: () => { active: boolean };
  /** E2E 观察桥开关（缺省 = shouldEnableE2ETestBridge(process.env)）。 */
  e2eBridgeEnabled?: boolean;
}

/**
 * desktop main 入口的单一装配调用：注册批准 IPC 通道 + 卡面推送 + （测试模式）
 * E2E 观察桥。幂等（重复调用先注销旧注册）。
 */
export function installDesktopPayswapApproval(
  options: InstallDesktopPayswapApprovalOptions,
): PayswapDesktopApprovalIpcRegistration {
  const financialMode = options.financialMode ?? createDesktopPayswapFinancialModeReader();
  const baseHost = createPayswapDesktopApprovalHost({
    getMainWindowFrameUrl: options.getMainWindowFrameUrl,
    financialMode,
  });
  const host = withPayswapCardPush(baseHost, {
    sendTo(webContentsId, event) {
      const target = webContents.fromId(webContentsId);
      if (target && !target.isDestroyed()) {
        target.send(PAYSWAP_DESKTOP_CARD_CHANNEL, event);
      }
    },
    broadcast(event) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send(PAYSWAP_DESKTOP_CARD_CHANNEL, event);
        }
      }
    },
  });
  const registration = installPayswapDesktopApprovalIpc({
    ipcMain,
    getMainWindowFrameUrl: options.getMainWindowFrameUrl,
    financialMode,
    host,
  });
  if (options.e2eBridgeEnabled ?? shouldEnableE2ETestBridge(process.env)) {
    (globalThis as PayswapE2EBridgeGlobal).__zcodePayswapDesktopApprovalE2E = {
      host,
      registration,
      channel: PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
    };
  }
  return registration;
}
