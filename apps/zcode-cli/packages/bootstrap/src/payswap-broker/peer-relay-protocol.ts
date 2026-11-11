/**
 * PaySwap broker peer-helper relay 协议（契约 w2-01 §5.1/§5.3；ADR-13 D13.3）。
 *
 * 这是 host（Node）与 native peer-verification helper（macOS：helper.c；Windows：C# 家族
 * 后续 PR）之间唯一的线路契约，单一事实源：
 *
 * - helper 对每个**已建立对等事实**的客户端连接，向 host 的 ingress socket 开一条连接；
 * - 首行 = 版本化头行 `{"v":1,"t":"<64-hex>","pid":N,"uid":N}\n`（严格形状：恰四键、
 *   v=1、t 是 64 个小写十六进制字符、pid/uid 是 [0, 2^31) 整数；硬上限 512 字节）；
 * - 头行之后是**逐字节的透明泵**直到双向 EOF —— §3.3 的一请求一连接、1 MiB 上限、排空
 *   纪律与半关语义全部在 host 侧的原有实现上不变生效（host 看到的是真实 socket）。
 *
 * 安全性质（ADR-13 D13.6）：relay 事实的信任边界 = 一次性 32 字节 token —— ingress 在
 * per-boot 0700 目录内（同 uid 才可达），每条连接都用 token 重认证（host 侧
 * timingSafeEqual 常时比对，对应 C# 家族的 FixedTimeEquals 纪律）。任何解析失败、形状
 * 不符或 token 不符 → null = 无法建立对端身份（§5.4 fail-closed）。
 *
 * fake-helper 测试接缝（D13.10）：本模块同时被宿主测试的协议忠实 fake（
 * tests/payswap-broker-peer-relay.test.ts）按同一契约实现 —— 平台行只在 darwin 套件经
 * 真实 C helper 证明。
 */

import { timingSafeEqual } from "node:crypto";
import type net from "node:net";
import type { PeerCredentialRead } from "./peer-credentials.js";

/** relay 协议版本（v1；演进 = 升版本号 + ADR）。 */
export const PAYSWAP_RELAY_PROTOCOL_VERSION = 1;

/** 头行硬上限（字节，不含换行）：形状固定的 JSON，512 已是 ~8 倍裕量。 */
export const PAYSWAP_RELAY_HEADER_MAX_BYTES = 512;

/** 一次性 token 的形状：32 字节 → 64 个小写十六进制字符（与 §4.1(1) 的铸造纪律同款）。 */
const RELAY_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** 头行 JSON 的合法键集（严格：多键/缺键/未知键都拒绝）。 */
const RELAY_HEADER_KEYS = ["pid", "t", "uid", "v"] as const;

/**
 * 解析并认证一条 relay 头行。任何失败返回 null（fail-closed，绝不抛出）：
 * 非法 JSON / 非对象 / 键集不符 / v≠1 / token 形状不符 / pid/uid 非法 / token 不等。
 */
export function parseRelayHeaderLine(line: string, expectedTokenHex: string): PeerCredentialRead | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RELAY_HEADER_KEYS.length) return null;
  for (const key of RELAY_HEADER_KEYS) {
    if (!(key in record)) return null;
  }
  if (record.v !== PAYSWAP_RELAY_PROTOCOL_VERSION) return null;
  if (typeof record.t !== "string" || !RELAY_TOKEN_PATTERN.test(record.t)) return null;
  if (!Number.isInteger(record.pid) || (record.pid as number) < 0 || (record.pid as number) > 0x7fffffff) {
    return null;
  }
  if (!Number.isInteger(record.uid) || (record.uid as number) < 0 || (record.uid as number) > 0x7fffffff) {
    return null;
  }
  // 常时比对（ADR-13 D13.4）：长度先等（timingSafeEqual 的前置），再逐字节比对。
  const presented = Buffer.from(record.t, "utf8");
  const expected = Buffer.from(expectedTokenHex, "utf8");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  return { pid: record.pid as number, uid: record.uid as number };
}

/** 头行序列化（helper 侧/fake 侧共用；host 侧仅测试用）。 */
export function serializeRelayHeaderLine(tokenHex: string, pid: number, uid: number): string {
  return `${JSON.stringify({
    v: PAYSWAP_RELAY_PROTOCOL_VERSION,
    t: tokenHex,
    pid,
    uid,
  })}\n`;
}

/** readRelayPeerFacts 的结果：事实 + 同一 chunk 内头行之后的余量（请求行前缀）。 */
export interface RelayFactsRead {
  facts: PeerCredentialRead | null;
  /** 头行之后已到达但未消费的字节（可能为空）—— 交给 §5.5 后续步骤的行读取作前缀。 */
  leftover: Buffer;
}

/**
 * 从一条已接受的 ingress 连接读出**并认证** relay 头行（§5.5 步 (1) 的 relay 形态事实源）。
 * 返回 facts=null = 无法建立对端身份：连接关闭/超时/超限/形状不符/token 不符；连接照常
 * 交给 §5.5 的后续步骤（fail-closed 的拒绝在调用方）。
 *
 * 流语义（硬约束，平台套件全链行钉住）：socket 先 **pause** 再摘监听 —— flowing 模式下
 * 无监听者的流会**静默丢弃**缓冲数据（Node 实测），unshift 的两种顺序都不安全；改为：
 * 显式暂停（后续到达的数据保甡在内部缓冲）+ 头行后的余量经 `leftover` 显式交还，由下一
 * 个读方（server 的 readOneLine）作为前缀拼接 —— 零流魔法，字节序确定。
 */
export function readRelayPeerFacts(
  socket: net.Socket,
  expectedTokenHex: string,
  timeoutMs = 10_000,
): Promise<RelayFactsRead> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let oversize = false;
    let settled = false;
    const timer = setTimeout(() => settle({ facts: null, leftover: buffer }), timeoutMs);
    timer.unref?.();
    const settle = (value: RelayFactsRead): void => {
      if (settled) return;
      settled = true;
      // 先停流（缓冲保留，绝不丢弃），再摘监听；左侧（调用方/readOneLine）负责 resume。
      socket.pause();
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onClose);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const line = Buffer.concat([buffer, chunk.subarray(0, newlineIndex)]).toString("utf8");
        const oversizeLine = oversize || line.length > PAYSWAP_RELAY_HEADER_MAX_BYTES;
        const facts = oversizeLine ? null : parseRelayHeaderLine(line, expectedTokenHex);
        // 头行之后的余量显式交还（不 unshift —— 见函数头注释的流语义说明）。
        settle({ facts, leftover: chunk.subarray(newlineIndex + 1) });
        return;
      }
      if (!oversize) {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > PAYSWAP_RELAY_HEADER_MAX_BYTES) {
          // 超限即停止缓冲；继续排空到换行再统一裁决（与 server.ts readOneLine 同款纪律）。
          oversize = true;
          buffer = Buffer.alloc(0);
        }
      }
    };
    const onEnd = (): void => settle({ facts: null, leftover: buffer });
    const onClose = (): void => settle({ facts: null, leftover: buffer });
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}
