/**
 * PaySwap P2.2 —— desktop main 账户运行时装配 + reader 桥服务端（ADR-P2-2
 * Decision 1/2/3 的模块半；入口接线〔main 入口装配 + spawn 时的端口转移〕随
 * 连接流切片与其 desktop Browser E2E 臂落地 —— D12.7 同款「法则与模块先行，
 * 入口接线随活的窗口证明」纪律）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **受监督运行时**：每个桥请求先 warmup（现读键 store —— accountWarmup
 *    法则 1 的逐次现读），键可用性**变化**（absent↔present）才重建 runtime ——
 *    credential service 的 PSP 键材料是构造期快照（services 法则的 env 读取
 *    时机），「按需重建」是 fresh-read 的 honest 组合：钥匙串恢复后无需重启
 *    （ADR-P2-2 Decision 2 的端到端兑现 —— 旧 host-env 交付设计做不到的这一条）。
 *    键状态不变 = 同一实例（doc 06 §2.2 单写者；连接 UI 半〔后续切片〕经
 *    getRuntime 共享同一 service 面）。重建只发生在桥服务端的串行点
 *    （account-reader-bridge 法则 5）—— 无 in-flight 竞态。
 * 2. **env 视图 = 恰 warmup 产物**：runtime 的 env 注入恰 `ZCODE_PAYSWAP_PSP_KEY`
 *    （或空集）—— 不携带 process.env 其它键：PSP 键的政策裁决在桌面装配只认
 *    safeStorage 通道或 fail-closed（server 行的 `ZCODE_CREDENTIAL_SECRET` 不
 *    进入桌面拓扑 —— ADR-P2-2 Decision 2/5）。
 * 3. **fail-safe**：warmup 抛出/键缺席 → 空集 env 装配照常 + onWarmupError 上报
 *    （accountWarmup 法则 2 的组装侧复用）；服务面照常应答（readers 诚实，
 *    Gate E2 typed 拒绝留给操作面，不阻断装配）。
 * 4. **serve = shared 桥法则**（zod 双端校验、reader_error 映射、请求串行、
 *    typed refusal 作数据透传 —— account-reader-bridge 法则全文）。
 * 5. **IO 全注入**：keyStore、runtime 依赖（store 路径/transport/时钟/ID 铸造）、
 *    port 全部注入；本模块无 Electron import（入口适配在接线半）。
 */

import {
  servePayswapReaderBridge,
  type PayswapReaderBridgePort,
  type PayswapReaderBridgeServer,
} from "@zcode/shared/payswap";
import {
  createPayswapAccountRuntime,
  type PayswapAccountRuntime,
  type PayswapAccountRuntimeDependencies,
} from "@zcode/services/node";
import {
  warmupPayswapPspHostEnv,
  type PayswapPspWarmupResult,
} from "./accountWarmup.js";
import type { PayswapPspKeyStore } from "./pspCredentialKeyStore.js";

export interface PayswapDesktopAccountRuntimeOptions {
  /** PSP 键 store（真实装配 = createPayswapPspKeyStore(safeStorage, fs)）。 */
  keyStore: Pick<PayswapPspKeyStore, "ensureUnwrappedKey">;
  /** 预热故障上报（fail-safe 降级不抛出；此处可见）。 */
  onWarmupError?: (error: unknown) => void;
  /** runtime 依赖注入（store 路径/transport/时钟/ID 铸造；env 由本模块持有 —— 法则 2）。 */
  runtimeDependencies?: Omit<PayswapAccountRuntimeDependencies, "env">;
}

export interface PayswapDesktopAccountRuntime {
  /**
   * 现行运行时（warmup 现读 + 按需〔再〕装配 —— 法则 1）。连接 UI 半（后续切片）
   * 经此共享同一账户服务实例（单写者）。
   */
  getRuntime(): Promise<PayswapAccountRuntime>;
  /** 重建计数（0 = 尚未装配；键可用性不变则恒定 —— 法则 1 的可观测面）。 */
  readonly runtimeRebuilds: number;
  /** app-ready 预热（现读组装，结果不缓存 —— accountWarmup 法则 1）。 */
  warmup(): Promise<PayswapPspWarmupResult>;
  /** reader 桥服务端（shared 法则；请求串行内嵌 warmup + 按需重建 —— 法则 1/4）。 */
  serve(port: PayswapReaderBridgePort): PayswapReaderBridgeServer;
}

/**
 * 受监督账户运行时装配（法则 1-5）。无 boot 副作用 —— 首个请求/预热才触达键
 * store；runtime 内部懒装配（store/凭据文件按操作触达）。
 */
export function createPayswapDesktopAccountRuntime(
  options: PayswapDesktopAccountRuntimeOptions,
): PayswapDesktopAccountRuntime {
  let current: { runtime: PayswapAccountRuntime; keyAvailable: boolean } | null = null;
  let rebuilds = 0;

  async function ensureRuntime(): Promise<PayswapAccountRuntime> {
    const warm = await warmupPayswapPspHostEnv({
      keyStore: options.keyStore,
      onWarmupError: options.onWarmupError,
    });
    if (current === null || current.keyAvailable !== warm.keyAvailable) {
      // 法则 2：env 视图恰 warmup 产物（快照 —— fresh-read 经法则 1 的按需重建兑现）。
      current = {
        runtime: createPayswapAccountRuntime({
          ...options.runtimeDependencies,
          env: { ...warm.env },
        }),
        keyAvailable: warm.keyAvailable,
      };
      rebuilds += 1;
    }
    return current.runtime;
  }

  return {
    getRuntime: () => ensureRuntime(),
    get runtimeRebuilds(): number {
      return rebuilds;
    },
    warmup: () =>
      warmupPayswapPspHostEnv({
        keyStore: options.keyStore,
        onWarmupError: options.onWarmupError,
      }),
    serve(port) {
      return servePayswapReaderBridge({
        port,
        accountOverviewReader: async () => {
          const runtime = await ensureRuntime();
          return runtime.accountOverviewReader();
        },
        accountDetailReader: async (connectionId: string) => {
          const runtime = await ensureRuntime();
          return runtime.accountDetailReader(connectionId);
        },
      });
    },
  };
}
