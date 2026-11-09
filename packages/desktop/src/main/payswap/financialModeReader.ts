/**
 * PaySwap 桌面 financialMode reader（addendum §2.2 T3 的桌面 live 读半；ADR-12
 * D12.7 ——「the real renderer-side `financialMode` reader land[s] with the desktop
 * Browser E2E arm」）。
 *
 * 法则（单一实现在 shared-payswap hook-admission —— 本模块只做桌面侧 IO 供给）：
 * - **fresh config 读**（spawn-wiring per-request 纪律）：每次 issueProposal 前
 *   现读 `~/.zcode/cli/config.json`（zcode-cli adapters/config 的 DEFAULT_BASE_DIR
 *   同一文件 —— 桌面 main 与 agent 同 HOME，读的是同一份配置），投影 =
 *   `isPayswapFinancialModeActive(config.plugins)`。**不吃构造期快照**（T2/T3 的
 *   per-session 翻转语义由 fresh read 承载）。
 * - **fail-closed**：文件缺失/JSON 畸形/读取异常 → `active: false`（无法证明 S2
 *   = 拒发 —— 法则缺省姿态同款）。本模块永不抛错（发卡门只吃 boolean）。
 * - 桌面 main 不依赖 zcode-cli 的 config 工厂（依赖方向纪律）：这里只读该文件
 *   的 `plugins` 段（`readPayswapFinancialModeFromConfig` 的结构输入面），
 *   路径解析与 exportLogs 既有实践一致（`~/.zcode/cli`）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPayswapFinancialModeActive } from "@zcode/shared/payswap";

/** reader 的环境注入面（缺省 process.env；测试可注入）。 */
export interface DesktopPayswapFinancialModeEnv {
  HOME?: string | undefined;
}

/** `~/.zcode/cli/config.json` 的解析（失败 = null —— fail-closed 唯一出口）。 */
function readCliConfigPlugins(
  env: DesktopPayswapFinancialModeEnv,
): { plugins?: Record<string, unknown> } | null {
  const home = env.HOME?.trim();
  if (!home) return null;
  try {
    const raw = readFileSync(join(home, ".zcode", "cli", "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as { plugins?: Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * 桌面 financialMode live reader：每次调用现读真实 config 文件并投影 S2。
 * 任何失败 → `active: false`（fail-closed；T3 缺省拒发姿态）。
 */
export function createDesktopPayswapFinancialModeReader(
  env: DesktopPayswapFinancialModeEnv = process.env,
): () => { active: boolean } {
  return () => {
    const config = readCliConfigPlugins(env);
    if (!config) return { active: false };
    const plugins = config.plugins;
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
      return { active: false };
    }
    return { active: isPayswapFinancialModeActive(plugins) };
  };
}
