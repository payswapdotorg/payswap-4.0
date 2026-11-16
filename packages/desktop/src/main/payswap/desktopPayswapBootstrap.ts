/**
 * PaySwap 桌面 main 入口装配（ADR-12 D12.7 ——「the real IPC mapping, the production
 * trusted-origin value … arrive with the surface work」；playbook P1.8 desktop Browser
 * E2E run 携带的注册半；P2.2 slice 7 增补连接通道半 —— ADR-P2-2 Decision 4）。
 *
 * 批准通道装配内容（法则住 shared-payswap；desktop-payswap 模块是装配 owner）：
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
 *
 * 连接通道装配内容（P2.2 slice 7 —— installDesktopPayswapConnections）：
 * - 键 store（safeStorage 包裹；路径 pin = CLI 数据根的 app 配置目录 —— ADR-P2-2
 *   附录 C）+ 受监督账户运行时（slice 6 accountRuntimeWiring）+ 连接 IPC 注册
 *   （approvalIpc 模式；受信 origin 同一现读来源）。
 * - 入口接线（main 入口的真实调用 + app-ready 预热）随连接 UI 与其 desktop
 *   Browser E2E 臂落地（D12.7 纪律）。
 */

import { BrowserWindow, ipcMain, safeStorage, webContents, type IpcMain, type MessagePortMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPayswapDesktopApprovalHost,
  PAYSWAP_DESKTOP_CARD_CHANNEL,
} from "@zcode/shared/payswap";
import { getAppConfigDir } from "@zcode/services/node";
import { shouldEnableE2ETestBridge } from "@zcode/shared";
import {
  installPayswapDesktopApprovalIpc,
  PAYSWAP_DESKTOP_APPROVAL_IPC_CHANNEL,
  type PayswapDesktopApprovalIpcRegistration,
} from "./approvalIpc.js";
import { withPayswapCardPush } from "./cardPush.js";
import { createDesktopPayswapFinancialModeReader } from "./financialModeReader.js";
import {
  installPayswapDesktopConnectionIpc,
  type PayswapDesktopConnectionIpcRegistration,
} from "./accountConnectionIpc.js";
import {
  createPayswapDesktopAccountRuntime,
  type PayswapDesktopAccountRuntime,
} from "./accountRuntimeWiring.js";
import { createPayswapReaderBridgePortMinter } from "./accountReaderBridgeEntry.js";
import {
  createPayswapPspKeyStore,
  PAYSWAP_PSP_KEY_STORE_FILE_NAME,
  type PayswapPspKeyStoreDependencies,
  type PayswapPspSafeStoragePort,
} from "./pspCredentialKeyStore.js";
import type { PayswapAccountRuntimeDependencies } from "@zcode/services/node";

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

// ---------------------------------------------------------------------------
// P2.2 连接通道装配（ADR-P2-2 Decision 4 —— 受理面在 main；slice 7）
// ---------------------------------------------------------------------------

export interface InstallDesktopPayswapConnectionsOptions {
  /** 主窗口 URL 的现读来源（生产受信 origin；空/无窗口 = fail-closed 全拒）。 */
  getMainWindowFrameUrl: () => string;
  /** safeStorage 端口（缺省 = Electron safeStorage；测试注入面）。 */
  safeStorage?: PayswapPspSafeStoragePort;
  /** 进程平台（缺省 = process.platform；后端政策的裁决维度 —— 测试注入面）。 */
  platform?: string;
  /** 键 store 依赖（缺省 = node fs + CLI 数据根的 app 配置目录 —— ADR-P2-2 附录 C pin）。 */
  keyStoreDependencies?: Pick<
    PayswapPspKeyStoreDependencies,
    "resolveKeyStorePath" | "readFile" | "writeFile"
  >;
  /** runtime 依赖注入（store 路径/transport/时钟/ID 铸造；env 由 wiring 持有）。 */
  runtimeDependencies?: Omit<PayswapAccountRuntimeDependencies, "env">;
  /** ipcMain（缺省 = Electron ipcMain；测试注入面）。 */
  ipcMain?: Pick<IpcMain, "handle" | "removeHandler">;
  /** 预热/internal 故障观察面（fail-safe 降级不抛出；此处可见）。 */
  onWarmupError?: (error: unknown) => void;
  onInternalError?: (error: unknown) => void;
}

export interface PayswapDesktopConnectionsInstallation {
  /** 受监督账户运行时（getRuntime 单写者面 + warmup + 桥服务端 —— slice 6）。 */
  runtime: PayswapDesktopAccountRuntime;
  /** 连接 IPC 注册（host + unregister）。 */
  registration: PayswapDesktopConnectionIpcRegistration;
  /**
   * P2.2 slice 9（ADR-P2-2 Addendum B）：为窗口 host spawn 铸造 reader 桥端口（每窗口
   * host 一个通道 —— port1 serve、port2 转移；见 accountReaderBridgeEntry.ts）。铸造
   * 失败返回 null（fail-safe，spawn 照常）。调用方：main/index.ts 的 spawnHostProcess
   * 接线（mintPayswapReaderBridgePort 选项）。
   */
  mintReaderBridgePortForUtilityProcess(): MessagePortMain | null;
}

/**
 * P2.2 连接通道的 desktop main 装配：键 store（safeStorage 包裹）+ 受监督账户
 * 运行时（slice 6 wiring）+ 连接 IPC 注册（approvalIpc 模式）。幂等性由调用方
 * 持有 registration.unregister 管理（与批准装配同款）。
 *
 * 键文件路径 pin（ADR-P2-2 附录 C）：`getAppConfigDir()`（services paths ——
 * `setDataBaseDir` 钉过的 CLI 数据根）+ `payswap-psp-safe-storage-key` —— 与
 * 连接记录 store（getAppConfigDir() 下 payswap-connections.json）、凭据 store 同一解析
 * 基准，桌面装配不另设路径（单一事实源）。
 *
 * 无 boot 副作用：安装不触键 store、不装配 runtime（首请求/app-ready 预热才触达）。
 */
export function installDesktopPayswapConnections(
  options: InstallDesktopPayswapConnectionsOptions,
): PayswapDesktopConnectionsInstallation {
  const keyStoreDependencies: Pick<
    PayswapPspKeyStoreDependencies,
    "resolveKeyStorePath" | "readFile" | "writeFile"
  > = options.keyStoreDependencies ?? {
    resolveKeyStorePath: () => join(getAppConfigDir(), PAYSWAP_PSP_KEY_STORE_FILE_NAME),
    // 端口契约：ENOENT → null（首次落键的分叉判据），其余错误上抛。
    readFile: async (path) => {
      try {
        return await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
  };
  const runtime = createPayswapDesktopAccountRuntime({
    keyStore: createPayswapPspKeyStore({
      safeStorage: options.safeStorage ?? safeStorage,
      platform: options.platform ?? process.platform,
      ...keyStoreDependencies,
    }),
    ...(options.onWarmupError !== undefined ? { onWarmupError: options.onWarmupError } : {}),
    ...(options.runtimeDependencies !== undefined
      ? { runtimeDependencies: options.runtimeDependencies }
      : {}),
  });
  const registration = installPayswapDesktopConnectionIpc({
    ipcMain: options.ipcMain ?? ipcMain,
    getMainWindowFrameUrl: options.getMainWindowFrameUrl,
    getAccountService: async () => (await runtime.getRuntime()).accountService,
    ...(options.onInternalError !== undefined
      ? { onInternalError: options.onInternalError }
      : {}),
  });
  return {
    runtime,
    registration,
    mintReaderBridgePortForUtilityProcess: createPayswapReaderBridgePortMinter(runtime),
  };
}
