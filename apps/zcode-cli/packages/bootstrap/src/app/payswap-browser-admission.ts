/**
 * PaySwap P1.8 —— Gate E3 的 BrowserControlPort 准入包装（addendum §5.3；法则住
 * `@zcode/shared/payswap` 的 browser-admission —— 本文件只接线与映射，不复刻法则）。
 *
 * 接线点：create-app 的 `options.browserControlPort`（app 装配处一次性包装；下游
 * 的 runtime 浏览器工具、node_repl browser broker、workflow actor 子端口全部经此
 * —— 模型控制的浏览器命令在本 app 的唯一汇合点）。
 *
 * 判定时机与范围：
 * - **per-command live 读**（fresh config → `isPayswapFinancialModeActive`，spawn-wiring
 *   的 broker live reader 同款纪律）：拒绝随 config 变化即时翻转（§2.1 拒绝码
 *   live 语义 / T2 同款），无快照陈旧窗口。
 * - 只对**携带 URL 的导航命令**（`navigate` —— BrowserCommand 面上唯一的导航命令）
 *   求值；其余命令零求值直通（保真面最小化：读 config 的成本与回归面都只落在
 *   导航上）。playwright `waitForURL` 是等待谓词不是导航；`evaluate` 表达式内嵌
 *   fetch 的 URL 不在命令边界可寻址 —— P2+ 桌面深度（见测试文件的 scope boundary）。
 * - 拒绝映射为 Browser 面已有的 typed `navigation_blocked` 错误码（上游
 *   managed-browser URL 检查同码，`page-command.ts` 的 isAllowedManagedBrowserUrl
 *   先例），内层端口不被调用（无上游 dispatch）。
 * - `forChildSession` 派生的子端口同样过门：子代理（dwf / workflow actor）的导航
 *   不得绕过；子端口的其余方法（tabOwner 语义下的生命周期覆写）原样保留。
 */

import type { BrowserControlPort, BrowserCommandResult } from "@zcode/contracts";
import { createConfig } from "@zcode/adapters/config";
import {
  admitPayswapModelBrowserNavigation,
  isPayswapFinancialModeActive,
  type PayswapPspProviderHostRecord,
} from "@zcode/shared/payswap";

export interface PayswapBrowserAdmissionOptions {
  /** 被包装的上游端口（app 装配处的 options.browserControlPort）。 */
  port: BrowserControlPort;
  /** env 与工作目录（缺省 reader 的 fresh config 读所需；spawn-wiring 同款注入）。 */
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  /**
   * 金融模式 live reader 注入缝（测试/协议宿主注入；缺省 = fresh config 读 →
   * isPayswapFinancialModeActive —— 与 broker live reader、E1 hook 门同一投影，
   * 单一实现纪律）。每次 navigate 求值（无缓存）。
   */
  readFinancialMode?: () => boolean;
  /**
   * PSP host 记录注入缝（缺省 = shared 的种子记录，deliverable 04 §195 的
   * dated evidence；P2/P3 扩表入口）。
   */
  providerHostRecords?: readonly PayswapPspProviderHostRecord[];
}

/**
 * 把 Gate E3 的模型臂法则接到一个真实 BrowserControlPort 上：`navigate` 命令过
 * `admitPayswapModelBrowserNavigation`，拒绝返回 typed `navigation_blocked`
 * （内层端口不被调用），其余方法与命令逐字节直通。
 */
export function wrapBrowserControlPortWithPayswapBrowserAdmission(
  input: PayswapBrowserAdmissionOptions,
): BrowserControlPort {
  const readFinancialMode =
    input.readFinancialMode ??
    (() => {
      const { config } = createConfig({
        env: input.env,
        workingDirectory: input.workingDirectory,
      });
      return isPayswapFinancialModeActive(config.plugins ?? {});
    });

  const refuseNavigation = (url: string): BrowserCommandResult | undefined => {
    const verdict = admitPayswapModelBrowserNavigation({
      financialModeActive: readFinancialMode(),
      url,
      records: input.providerHostRecords,
    });
    if (verdict.admitted) return undefined;
    return {
      ok: false,
      error: {
        code: "navigation_blocked",
        message:
          verdict.host === null
            ? "PaySwap financial mode: navigation target could not be verified as a non-PSP host"
            : `PaySwap financial mode: model-controlled navigation to PSP API host '${verdict.host}' is not allowed (provider API access belongs to the adapters)`,
      },
      elapsedMs: 0,
    };
  };

  const wrapExecute = (
    execute: BrowserControlPort["execute"],
  ): BrowserControlPort["execute"] => {
    return async (execInput) => {
      if (execInput.command.method === "navigate") {
        const refusal = refuseNavigation(execInput.command.url);
        if (refusal) return refusal;
      }
      return await execute(execInput);
    };
  };

  const wrapped: BrowserControlPort = {
    list: (listInput) => input.port.list(listInput),
    execute: wrapExecute(input.port.execute),
  };
  // 可选生命周期方法按上游存在性转发（缺席保持缺席 —— 上游 CLI headless CDP 端口
  // 没有 forChildSession 的同款语义）。
  if (input.port.turnEnded) wrapped.turnEnded = input.port.turnEnded.bind(input.port);
  if (input.port.closeSession) wrapped.closeSession = input.port.closeSession.bind(input.port);
  if (input.port.forChildSession) {
    wrapped.forChildSession = (childInput) => {
      const childPort = input.port.forChildSession!(childInput);
      const wrappedChild: BrowserControlPort = {
        list: childPort.list,
        execute: wrapExecute(childPort.execute),
      };
      if (childPort.turnEnded) wrappedChild.turnEnded = childPort.turnEnded;
      if (childPort.closeSession) wrappedChild.closeSession = childPort.closeSession;
      return wrappedChild;
    };
  }
  return wrapped;
}
