/**
 * PaySwap broker 连接级行 IO 原语（契约 w2-01 §3.3；ADR-5/D5.4）。
 *
 * 从 server.ts 抽出（架构 max-file-lines 纪律；行为不变 —— peer-verification 套件的
 * 排空/半关/超限行为行全部保持原语义）：
 *
 * - `readOneLine`：单行读取（§3.3）—— 首个换行为止；行长（不含换行）> 1 MiB → oversize
 *   （停止缓冲，继续排空到换行）；对端半关（end）→ 缓冲内容**无换行即非帧**：请求帧按
 *   §3.3(1) 必须换行终止，未终止的残余是对端写入中止的传输噪声，按 closed 丢弃（无响应、
 *   无状态、零审计 outcome —— 也消除每次中止写铸造一个 Ed25519 拒绝信封的放大面）；连接
 *   关闭/超时 → closed（无响应，无状态）。
 * - `drainAfterEnd`：D5.4 排空段封顶 —— end+resume 之后最多 DRAIN_CAP_MS 强断（finally
 *   已释放 live count）。
 */

import { PAYSWAP_MAX_LINE_BYTES } from "@zcode/shared/payswap";
import type net from "node:net";

export type LineRead = { kind: "line"; line: string } | { kind: "oversize" } | { kind: "closed" };

/** failPeer/refuseParsed 后的排空段封顶：半开 socket 最多再存活 5 s（防恶意无限流）。 */
export const DRAIN_CAP_MS = 5_000;

/** D5.4 排空段封顶：end+resume 之后最多 DRAIN_CAP_MS 强断（finally 已释放 live count）。 */
export function drainAfterEnd(socket: net.Socket): void {
  const timer = setTimeout(() => socket.destroy(), DRAIN_CAP_MS);
  timer.unref?.();
  socket.once("close", () => clearTimeout(timer));
}

export function readOneLine(
  socket: net.Socket,
  idleTimer: NodeJS.Timeout,
  prefix?: Buffer,
): Promise<LineRead> {
  return new Promise<LineRead>((resolve) => {
    // prefix 经 onData 恰好一次（buffer 从空开始）：若初始化进 buffer 又喂给 onData 会
    // 双拼（上轮调试的真实教训）—— 字节序唯一性由“恰好一次”保证。
    let buffer = Buffer.alloc(0);
    let oversizePending = false;
    let settled = false;
    const settle = (value: LineRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onClose);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const line = Buffer.concat([buffer, chunk.subarray(0, newlineIndex)]);
        settle(
          oversizePending || line.length > PAYSWAP_MAX_LINE_BYTES
            ? { kind: "oversize" }
            : { kind: "line", line: line.toString("utf8") },
        );
        return;
      }
      if (!oversizePending) {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > PAYSWAP_MAX_LINE_BYTES) {
          // 超限即停止缓冲（防内存放大），继续排空到换行再裁决。
          oversizePending = true;
          buffer = Buffer.alloc(0);
        }
      }
    };
    const onEnd = () => {
      if (oversizePending || buffer.length > PAYSWAP_MAX_LINE_BYTES) {
        settle({ kind: "oversize" });
        return;
      }
      if (buffer.length === 0) {
        settle({ kind: "closed" });
        return;
      }
      // 非空缓冲但从未见到换行 —— §3.3(1) 的帧定义未满足：不是请求，是对端写入中止
      // （子进程终止/SIGKILL/半途中断）。按 closed 丢弃：不解析、不响应、不审计。
      settle({ kind: "closed" });
    };
    const onClose = () => settle({ kind: "closed" });
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onClose);
    // relay 路径的 socket 被头行读取（peer-relay-protocol.ts）显式 pause 过 —— attach
    // 后恢复流动（对未暂停的 socket是 no-op）。ADR-13：头行与请求同 chunk 到达时，
    // 余量已在 prefix 里，此处可能已含完整请求行 —— 经 onData 恰好一次地裁决。
    socket.resume();
    if (prefix && prefix.length > 0) {
      onData(prefix);
    }
  });
}
