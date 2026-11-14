/**
 * PaySwap P2.2（ADR-P2-2 Addendum B —— 桥入口接线的 agent 侧半）—— stdio 帧适配器：
 * 把既有 stdio 协议（ZCodeStdioTransport 的 NDJSON 通知帧）适配为
 * `PayswapReaderBridgePort`（shared 桥法则的 stub 注入面）。
 *
 * 法则（全部住 shared-payswap/account-reader-bridge.ts —— 本模块零语义）：
 * - **不透明载荷**：桥消息作为通知帧（`PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD`）的
 *   params 双向转发；本适配器不校验、不改写、不解释 params（zod 校验只住真正的两端
 *   —— agent stub 与 desktop main 服务端）。
 * - **旁路**：入站桥帧经 `consumeNotification` 被 ZCodeProtocolNdjsonConnection 的
 *   sideband 通道同步消费 —— 不进串行处理队列（get_account_overview 工具在生成请求
 *   handler 内执行时，排队等待 = 桥响应永远到不了 = 15 s 时限死锁；这是传输形态的
 *   成立判据，不是优化）。
 * - **缺席判据**：spawn env 标记 `ZCODE_PAYSWAP_READER_BRIDGE` 在活才由入口构造本
 *   适配器（zcode-protocol-entrypoint.ts）；标记缺席 = reader 缺席 = fail-closed 缺省。
 * - 出站 send 全注入（IO 注入纪律；法则级测试无 stdio、无进程）。
 */

import {
  PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
  type PayswapReaderBridgeMessage,
  type PayswapReaderBridgePort,
} from "@zcode/shared/payswap";

/**
 * 入站通知的最小结构面（ZCodeProtocolNotification 的结构子集 —— 本模块零 @zcode/shared
 * 耦合：适配器只认方法名，不触碰其余协议形态；结构兼容由接线点保证）。
 */
export interface PayswapBridgeCarrierNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface PayswapStdioBridgePortOptions {
  /**
   * 出站半边：把桥消息发往窗口 host（调用方负责装进协议通知帧 ——
   * `{method: PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params}`；params = 桥消息本体）。
   */
  send: (message: PayswapReaderBridgeMessage) => void;
}

export interface PayswapStdioBridgePort {
  /** 桥法则的 stub 注入面（post → 出站 send；subscribe → 入站投递）。 */
  readonly port: PayswapReaderBridgePort;
  /**
   * 入站 sideband 消费面（ZCodeProtocolNdjsonConnection 的 consumeNotification 接线）：
   * 桥方法通知 → params 原样投递订阅者并返回 true（已消费，旁路串行队列与 server
   * dispatch）；其余通知返回 false（协议层正常分发）。
   */
  consumeNotification(message: PayswapBridgeCarrierNotification): boolean;
  /** 终结：清空订阅（挂起呼叫由 stub 自身的 dispose/时限兜底 —— 桥法则 3/6）。 */
  dispose(): void;
}

/**
 * 构造 stdio 帧适配器（零语义：路由面只有方法名等值比较，payload 原样双向）。
 */
export function createPayswapStdioBridgePort(
  options: PayswapStdioBridgePortOptions,
): PayswapStdioBridgePort {
  const listeners = new Set<(message: unknown) => void>();
  let disposed = false;
  return {
    port: {
      post(message) {
        if (disposed) return; // dispose 后静默丢弃（stub 的 dispose 才是挂起呼叫的权威面）
        options.send(message);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    consumeNotification(message) {
      if (message.method !== PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD) {
        return false; // 非桥帧：交还协议层正常分发
      }
      if (disposed) return true; // 仍认领（不进协议层），但不再投递
      // params 原样投递（不校验 —— stub 的 subscribe 面按法则静默忽略非响应消息）。
      for (const listener of listeners) {
        listener(message.params);
      }
      return true;
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
