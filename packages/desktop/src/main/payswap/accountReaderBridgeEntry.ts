/**
 * PaySwap P2.2（ADR-P2-2 Addendum B —— 桥入口接线的 desktop main 侧半）—— reader 桥
 * 端口铸造：每窗口 host 一个 `MessageChannelMain` —— port1 适配为
 * `PayswapReaderBridgePort` 交给受监督运行时 serve（slice 6 accountRuntimeWiring 的
 * `runtime.serve`），port2 是 spawn 时转移面（desktopHostProcess 的独立 spawn 消息
 * 携带给窗口 host 中继）。
 *
 * 法则（全部住 shared-payswap/account-reader-bridge.ts —— 本模块零语义）：
 * - **端口适配零语义**：postMessage ↔ post；"message" 事件 data ↔ subscribe 投递；
 *   退订真退订；适配器不校验、不改写（zod 校验只住真正的两端）。
 * - **mint = serve + 转移**：每次铸造一个新通道（多窗口 = 多通道，同一受监督运行时
 *   —— 单一账户服务实例，Decision 1；每通道独立串行 = 桥法则 5 的通道级落地）。
 * - **close → stop**：port1 close 事件停对应服务端（端口生命周期不泄漏订阅）。
 * - **fail-safe**：通道工厂抛出 → 返回 null（spawn 路径不因桥缺席而破 —— 桥缺席 =
 *   reader 缺席 = fail-closed 缺省，与 accountWarmup 法则 2 同款纪律）。
 * - MessagePortMain 结构面全注入（通道工厂 + 端口 face）—— 装配级测试无 Electron。
 */

import { MessageChannelMain, type MessagePortMain } from "electron";
import type { PayswapReaderBridgePort } from "@zcode/shared/payswap";
import type { PayswapDesktopAccountRuntime } from "./accountRuntimeWiring.js";

/**
 * MessagePortMain 的结构面（IO 注入纪律 —— 法则级/装配级测试无 Electron；真实
 * Electron MessagePortMain 结构兼容本面）。
 */
export interface PayswapReaderBridgeMessagePortFace {
  postMessage(message: unknown): void;
  start(): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  removeListener(event: "message", listener: (event: { data: unknown }) => void): unknown;
}

/** serve 侧（port1）额外需要 close 事件的订阅面。 */
export interface PayswapReaderBridgeServePortFace extends PayswapReaderBridgeMessagePortFace {
  once(event: "close", listener: () => void): unknown;
}

/** 通道对（真实装配 = Electron MessageChannelMain —— 结构兼容；测试注入内存替身）。 */
export interface PayswapReaderBridgeChannelPair {
  port1: PayswapReaderBridgeServePortFace;
  port2: PayswapReaderBridgeMessagePortFace;
}

/**
 * MessagePortMain → PayswapReaderBridgePort 的结构面适配（零语义映射）。
 */
export function adaptMessagePortMainToPayswapReaderBridgePort(
  port: PayswapReaderBridgeMessagePortFace,
): PayswapReaderBridgePort {
  return {
    post(message) {
      port.postMessage(message);
    },
    subscribe(listener) {
      const handler = (event: { data: unknown }) => listener(event.data);
      port.on("message", handler);
      return () => {
        port.removeListener("message", handler);
      };
    },
  };
}

/**
 * 端口铸造器（每窗口 host 一个通道）：
 * - port1 → `runtime.serve(adapt(port1))` + `start()`（Electron MessagePortMain 的
 *   on("message") 面需显式 start 才开始投递），port1 close → `server.stop()`；
 * - port2 → 返回给调用方作 spawn 转移面（真实装配 = MessagePortMain）；
 * - 通道工厂抛出 → null（fail-safe，见模块头）。
 *
 * 重载：缺省工厂 → 真实 Electron 通道（返回 MessagePortMain）；注入工厂 → 测试替身
 * （返回替身 face —— 装配级测试无 Electron）。
 */
export function createPayswapReaderBridgePortMinter(
  runtime: Pick<PayswapDesktopAccountRuntime, "serve">,
): () => MessagePortMain | null;
export function createPayswapReaderBridgePortMinter<
  TPort2 extends PayswapReaderBridgeMessagePortFace,
>(
  runtime: Pick<PayswapDesktopAccountRuntime, "serve">,
  createChannel: () => { port1: PayswapReaderBridgeServePortFace; port2: TPort2 },
): () => TPort2 | null;
export function createPayswapReaderBridgePortMinter(
  runtime: Pick<PayswapDesktopAccountRuntime, "serve">,
  createChannel?: () => PayswapReaderBridgeChannelPair,
): () => PayswapReaderBridgeMessagePortFace | null {
  return () => {
    let pair: PayswapReaderBridgeChannelPair;
    try {
      pair = (createChannel ?? (() => new MessageChannelMain()))();
    } catch {
      // fail-safe：铸造失败 = 本次不转移（桥缺席语义），spawn 照常。
      return null;
    }
    const server = runtime.serve(adaptMessagePortMainToPayswapReaderBridgePort(pair.port1));
    pair.port1.start();
    pair.port1.once("close", () => server.stop());
    return pair.port2;
  };
}
