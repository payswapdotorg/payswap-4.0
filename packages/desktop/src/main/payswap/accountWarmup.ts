/**
 * PaySwap 桌面 PSP 键预热（P2.2 生产装配半 —— desktop-payswap/CONTRACT.md 的
 * P2 交付段：「解包键经 buildPayswapPspHostEnv 组装为 ZCODE_PAYSWAP_PSP_KEY，
 * 由 spawnHostProcess 的 hostProcessLocalEnv 通道交付 host。入口接线（app-ready
 * 预热 + spawn 注入）随 P2.2 账户服务连接流与其 desktop Browser E2E 臂落地」）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **预热 = 现读组装，永不缓存结论**：每次 `warmupPayswapPspHostEnv` 现读键
 *    store（ensureUnwrappedKey —— store 内部 memoize 成功、不 memoize 失败），
 *    组装结果按次返回 —— safeStorage 恢复/钥匙串修复后无需重启进程。
 * 2. **fail-safe：预热失败永不阻断启动**：safeStorage 不可用 → 空集 env（host
 *    侧对 payswap:psp:* 键按操作 typed 拒绝 —— Gate E2 fail-closed，不猜）；
 *    解包失败（typed unwrap 错误）同样空集 + 上报（onWarmupError），文件原样。
 * 3. **env 键集闭**：产出恰 `ZCODE_PAYSWAP_PSP_KEY`（经 shared 法则
 *    buildPayswapPspHostEnv 单一实现）；空/空白解包键 → 空集（不注入半组）。
 * 4. **IO 全注入**：键 store 端口注入（真实装配 = createPayswapPspKeyStore +
 *    Electron safeStorage；法则级测试无 Electron）。
 */

import { buildPayswapPspHostEnv } from "@zcode/shared/payswap";
import type { PayswapPspKeyStore } from "./pspCredentialKeyStore.js";

export interface PayswapPspWarmupOptions {
  /** PSP 键 store（真实装配 = createPayswapPspKeyStore(safeStorage, fs)。 */
  keyStore: Pick<PayswapPspKeyStore, "ensureUnwrappedKey">;
  /** 预热故障上报（fail-safe 降级不抛出；解包失败/store 异常在此可见）。 */
  onWarmupError?: (error: unknown) => void;
}

export interface PayswapPspWarmupResult {
  /** hostProcessLocalEnv 的追加集（恰 ZCODE_PAYSWAP_PSP_KEY 或空集）。 */
  readonly env: Record<string, string>;
  /** 键是否在场（true = env 携带键；false = 空集 —— Gate E2 拒绝留给操作面）。 */
  readonly keyAvailable: boolean;
}

/**
 * app-ready 预热：确保 safeStorage 包裹键就绪并组装 host 交付 env。
 * fail-safe 见文件头法则 2 —— 任何失败 = 空集 + 上报，永不抛出。
 */
export async function warmupPayswapPspHostEnv(
  options: PayswapPspWarmupOptions,
): Promise<PayswapPspWarmupResult> {
  let unwrappedKey: string | null;
  try {
    unwrappedKey = await options.keyStore.ensureUnwrappedKey();
  } catch (error) {
    options.onWarmupError?.(error);
    return { env: {}, keyAvailable: false };
  }
  const env = buildPayswapPspHostEnv(unwrappedKey);
  return { env, keyAvailable: Object.keys(env).length > 0 };
}
