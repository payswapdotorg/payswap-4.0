/**
 * PaySwap P2.2（ADR-P2-2 Addendum B —— 桥入口接线的窗口 host 侧半）—— reader 桥
 * 透明中继：main 转移端口 ↔ agent stdio 通知帧的双向转发。
 *
 * 法则（全部住 shared-payswap/account-reader-bridge.ts —— 本模块零桥语义）：
 * - **透明**：桥消息作为不透明载荷双向转发 —— 不校验、不改写、不解释语义（zod
 *   校验只住真正的两端：agent stub 与 desktop main 服务端；「中继不是端」）。唯一的
 *   读取面是 callId 路由键（readPayswapReaderBridgeCallId —— 恰一字段，不作合法性
 *   裁决；callId 不可读的帧仍被透明转发，由端法则静默忽略）。
 * - **路由**：请求方向（agent → main）按观察学习 callId → client；响应方向（main →
 *   agent）按表路由到请求来源 client。未知 callId 的响应丢弃（stub 时限是桥法则 6
 *   的权威面 —— 不投递错端、不广播）。
 * - **缺席与故障有别**：main 端口未接时 agent 请求丢弃 + 可见 warn（不伪造、不缓存
 *   —— spawn env 标记只在端口在活时注入，本分支是防御性兜底）；端口在活后的中继
 *   故障 = 桥法则 3 的 throw 语义（stub 时限）。
 * - **生命周期**：client 关闭 → 该 client 的路由条目清理；dispose → 双向停止。
 * - IO 全注入（端口 face + client face 全结构面）—— 法则级测试无 Electron、无真实
 *   protocol client。
 */

import {
  PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD,
  readPayswapReaderBridgeCallId,
} from "@zcode/shared/payswap";

/** main 转移端口的接收面（Electron MessagePortMain 结构兼容）。 */
export interface PayswapReaderBridgeMainPortFace {
  postMessage(message: unknown): void;
  start(): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

/** agent protocol client 的中继挂接面（ZCodeProtocolClient 结构兼容子集）。 */
export interface PayswapReaderBridgeRelayClientFace {
  onNotification(
    listener: (message: { method: string; params?: unknown }) => void,
  ): { dispose(): unknown };
  notify(method: typeof PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, params?: unknown): Promise<void>;
  onClose(listener: () => void): { dispose(): unknown };
}

export interface PayswapReaderBridgeRelayOptions {
  /** 故障可见面（丢弃等降级不抛出；此处可见）。 */
  logger?: {
    info?: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

export interface PayswapReaderBridgeRelay {
  /** main 转移端口接管（每窗口 host 恰一次；重复到达 = 替换旧面 —— host 重初始化防御）。 */
  attachMainPort(port: PayswapReaderBridgeMainPortFace): void;
  /** agent protocol client 挂接（所有泳道；进程管理器 tap 调用）。 */
  attachProtocolClient(client: PayswapReaderBridgeRelayClientFace): void;
  /** main 端口在活（agent spawn env 可用性标记的唯一来源 —— Addendum B 缺席判据）。 */
  isAvailable(): boolean;
  /** 终结：双向停止（host 关闭路径调用；幂等）。 */
  dispose(): void;
}

interface ClientRegistration {
  readonly client: PayswapReaderBridgeRelayClientFace;
  readonly subscriptions: Array<{ dispose(): unknown }>;
}

export function createPayswapReaderBridgeRelay(
  options?: PayswapReaderBridgeRelayOptions,
): PayswapReaderBridgeRelay {
  const warn = options?.logger?.warn ?? (() => {});
  /** main 面（未接 = null —— 请求丢弃 + warn）。 */
  let mainPort: PayswapReaderBridgeMainPortFace | null = null;
  /** 路由表：callId → 请求来源 client（观察学习；client 关闭时清理）。 */
  const routing = new Map<string, PayswapReaderBridgeRelayClientFace>();
  const clients = new Set<ClientRegistration>();
  let disposed = false;

  function detachMainPort(): void {
    mainPort = null;
  }

  return {
    attachMainPort(port) {
      if (disposed) {
        warn("[payswap-reader-bridge-relay] relay disposed; dropping late main port");
        return;
      }
      if (mainPort !== null) {
        // host 重初始化防御：替换旧面（旧端口随转移语义已属本 host；关闭由对端驱动）。
        options?.logger?.info?.(
          "[payswap-reader-bridge-relay] replacing previous main port (host re-init?)",
        );
        detachMainPort();
      }
      port.start();
      port.once("close", () => {
        detachMainPort();
      });
      port.on("message", (event) => {
        const payload = event.data;
        // 路由读（唯一读取面）：callId → 请求来源 client。未知/不可读 → 丢弃（stub
        // 时限是桥法则 6 的权威面；不广播 —— 桥响应只回请求来源）。
        const callId = readPayswapReaderBridgeCallId(payload);
        const client = callId !== null ? routing.get(callId) : undefined;
        if (client === undefined) {
          warn(
            `[payswap-reader-bridge-relay] dropping bridge frame with no routable callId (learned=${routing.size})`,
          );
          return;
        }
        // 透明转发：params 原样（notify 的 transport 失败 → 丢弃，stub 时限兜底）。
        void client
          .notify(PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD, payload)
          .catch(() => undefined);
      });
      mainPort = port;
    },

    attachProtocolClient(client) {
      if (disposed) return;
      const subscriptions: Array<{ dispose(): unknown }> = [];
      subscriptions.push(
        client.onNotification((message) => {
          if (message.method !== PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD) return;
          // 路由学习：callId 可读才登记（不可读帧仍透明转发 —— 端法则静默忽略）。
          const callId = readPayswapReaderBridgeCallId(message.params);
          if (callId !== null) {
            routing.set(callId, client);
          }
          if (mainPort === null) {
            // 缺席分支（防御性 —— spawn env 标记只在端口在活时注入）。
            warn("[payswap-reader-bridge-relay] dropping bridge frame: main port not attached");
            return;
          }
          // 透明转发：payload 原样上端口（不校验、不改写）。
          mainPort.postMessage(message.params);
        }),
      );
      subscriptions.push(
        client.onClose(() => {
          for (const [callId, owner] of routing) {
            if (owner === client) routing.delete(callId);
          }
        }),
      );
      clients.add({ client, subscriptions });
    },

    isAvailable() {
      return mainPort !== null;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      detachMainPort();
      for (const registration of clients) {
        for (const subscription of registration.subscriptions) {
          try {
            subscription.dispose();
          } catch {
            // best effort：client 可能已自行释放。
          }
        }
      }
      clients.clear();
      routing.clear();
    },
  };
}
