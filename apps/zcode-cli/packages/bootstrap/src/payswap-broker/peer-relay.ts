/**
 * PaySwap broker peer-helper relay 子系统（契约 w2-01 §5.1/§5.4/§5.5；ADR-13）。
 *
 * macOS §5.1 native 臂的宿主半边 + 两个平台共用的传输缝（Windows §3.2/§5.3 后续 PR 沿用）：
 *
 * 1. **hash 验证的 spawn（D13.4）**：SHA-256 不符/二进制缺席 → 子系统不可用 → 调用方
 *    （boot.ts）落 degraded_refusing —— 绝不在不符时 spawn。
 * 2. **helper 持公共端点（D13.1）**：host 只铸路径（mintBrokerBootState）；per-boot 0700
 *    目录由本模块创建，公共 socket 由 helper 绑定（§3.1(2)/§3.4 在 helper 内执行）。
 * 3. **ingress relay（D13.3）**：host 在同一 0700 目录内持有 ingress.sock（0600）；helper
 *    对每条已建立对等事实的客户端连接开一条 ingress 连接，首行 = 版本化头行
 *    （peer-relay-protocol.ts 单一事实源），随后逐字节透明泵。
 * 4. **一次性 token（D13.4）**：32 字节随机经 0600 token 文件交付（argv 对同 uid 进程
 *    经 ps 可见，故不走 argv）；helper 读后即删；每条 ingress 连接重认证（常时比对）。
 * 5. **真路径自探针（D13.5，ADR-4 的 relay 形态）**：host 作为真实客户端连 helper-held
 *    公共端点，第一条 token 有效的头行必须识别出 host 自身（pid === process.pid 且
 *    uid === geteuid()）—— 任何失败（spawn/hash/头行/token/身份/超时）→ 全拆（杀
 *    helper、关 ingress、删 per-boot 目录）→ verified:false。
 *
 * 平台门（D13.8）：`resolveDefaultPeerRelayHelper` 只在 darwin 解析 env（win32 是后续
 * PR）；显式注入（boot options）不受平台门限制 —— 那是宿主半边测试的接缝。Linux 永远
 * 走直接 ss+procfs reader（peer-credentials.ts），本缝不分叉第二套 Linux 实现。
 *
 * host 侧专用；fail-closed：本模块任何意外都以 { verified:false, reason } 返回，绝不抛出。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  PAYSWAP_BROKER_HELPER_PATH_ENV_KEY,
  PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY,
  type PayswapBrokerBootState,
} from "@zcode/shared/payswap";
import { hostEffectiveUid } from "./peer-credentials.js";
import { readRelayPeerFacts } from "./peer-relay-protocol.js";

/** helper 供给配置（D13.9）：显式注入（测试）或 env 解析（CI/运维）的统一形状。 */
export interface PayswapPeerRelayHelperConfig {
  /** helper 二进制绝对路径（只在 SHA-256 验证通过后 spawn）。 */
  helperPath: string;
  /** 期望的 SHA-256（小写 hex）。 */
  helperSha256: string;
  /** 探针墙钟预算（缺省 5000 ms）。 */
  probeTimeoutMs?: number;
  /**
   * 追加在标准 argv 之后的额外参数（ADR-14 D14.10 的 CI 诊断缝 —— 如 win32 helper 的
   * `--diag <file>`；生产不传。hash 验证面覆盖的是二进制本身，与本参数无关）。
   */
  helperArgs?: string[];
}

/**
 * relay 传输面（server.ts 的 relay 模式消费）：ingress listener 的收养 + 事实源切换 +
 * close 时的 helper/ingress 拆除。`relayToken` 是每条 ingress 连接的认证凭据
 * （peer-relay-protocol.ts 的常时比对）。
 *
 * 平台臂差异面（ADR-14）：`peerUidBasis` 声明对等事实中 uid 维度的信任基础 ——
 * "header"（POSIX 臂：server 对照头行 uid 与 geteuid()，D13.3 原行为）或
 * "transport"（win32 臂：同用户边界由 helper 公共管道的 DACL 在管道口承担，头行 uid
 * 是哨兵 0 非证据，server 跳过 uid 比对；pid 仍来自认证后的头行）。`registerChildPid`
 * 是 win32 §5.3(1) 管道口门的 spawn 表推送面（POSIX 臂不实现 —— 事实只转发，门在
 * host 的 §5.5）。
 */
export interface PayswapBrokerRelayTransport {
  readonly ingressPath: string;
  readonly relayToken: string;
  /** ingress listen 就绪（POSIX 含 0600 chmod；win32 管道名无文件系统条目）；本对象返回时已 resolve。 */
  readonly listening: Promise<void>;
  /** uid 维度信任基础（见接口头注释；缺省 "header" —— 本臂 darwin）。 */
  readonly peerUidBasis: "header" | "transport";
  /**
   * win32 臂专属（§5.3(1)/ADR-14 D14.8）：把 spawn 表条目（子 pid + 期望映像路径；
   * image=null = 无法核验 → 该 pid 在管道口被弃）推给 helper。POSIX 臂缺省 ——
   * 可选能力面，server 侧以 `relay?.registerChildPid?.(...)` 探测调用。
   */
  registerChildPid?(childPid: number, imagePath: string | null): void;
  /** 生产期连接处理器（server.handleConnection）；探针期的额外连接一律销毁。 */
  setConnectionHandler(handler: (socket: net.Socket) => void): void;
  /** 拆除：SIGTERM→SIGKILL helper + 关闭 ingress listener + 摘除 ingress socket。 */
  stop(): Promise<void>;
}

export interface PayswapPeerRelayStartResult {
  verified: boolean;
  /** verified:false 的降级原因（操作员可见诊断，§11(3)；不含 token/密钥材料）。 */
  reason: string | null;
  probe: { verified: boolean; pid: number | null; uid: number | null };
  relay: PayswapBrokerRelayTransport | null;
}

const UNVERIFIED_PROBE = { verified: false, pid: null, uid: null } as const;

const HELPER_STOP_GRACE_MS = 1_000;
const ENDPOINT_CONNECT_RETRY_MS = 25;
const STDERR_TAIL_LIMIT = 400;

/**
 * 平台/env 解析（D13.8/D13.9 + ADR-14 D14.5）：darwin（C helper）与 win32（C# helper）
 * 共用同一对供给键，由 boot 层按平台分流到各自的 starter；其它平台不解析（Linux 永远
 * 走直接 reader —— 缝不分叉第二套 Linux 实现）。两键齐备才构成供给声明。存在性/hash
 * 校验在 starter 内统一执行（单一验证点）—— 声明了但二进制缺席 → 那里的 degraded 路径。
 */
export function resolveDefaultPeerRelayHelper(
  platform: string,
  env: Record<string, string | undefined>,
): PayswapPeerRelayHelperConfig | null {
  if (platform !== "darwin" && platform !== "win32") return null;
  const helperPath = env[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY]?.trim();
  const helperSha256 = env[PAYSWAP_BROKER_HELPER_SHA256_ENV_KEY]?.trim();
  if (!helperPath || !helperSha256) return null;
  return { helperPath, helperSha256: helperSha256.toLowerCase() };
}

/** SHA-256 验证（D13.4；两平台臂共用）：通过返回 null；否则返回降级原因。hash 不符绝不 spawn。 */
export function verifyHelperBinary(config: PayswapPeerRelayHelperConfig): string | null {
  try {
    const stat = fs.statSync(config.helperPath);
    if (!stat.isFile()) {
      return `helper path is not a regular file: ${config.helperPath}`;
    }
    const actual = createHash("sha256").update(fs.readFileSync(config.helperPath)).digest("hex");
    if (actual !== config.helperSha256.toLowerCase()) {
      return `helper sha256 mismatch for ${config.helperPath} (expected ${config.helperSha256.toLowerCase()}, got ${actual})`;
    }
    return null;
  } catch {
    return `helper binary unavailable at ${config.helperPath}`;
  }
}

/** 到截止时间的端点连接重试（helper 绑定端点有微小延迟；ENOENT/ECONNREFUSED 重试；两臂共用）。 */
export function connectUntilDeadline(endpointPath: string, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (Date.now() > deadline) {
        reject(new Error(`endpoint ${endpointPath} unreachable before deadline`));
        return;
      }
      const socket = net.connect(endpointPath, () => resolve(socket));
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`endpoint ${endpointPath} unreachable before deadline`));
          return;
        }
        setTimeout(attempt, ENDPOINT_CONNECT_RETRY_MS);
      });
    };
    attempt();
  });
}

/** 杀 helper：SIGTERM → 宽限 → SIGKILL 兜底；已死立即返回（幂等；win32 上 kill = 硬终止）。两臂共用。 */
export function stopHelperProcess(helper: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (helper.exitCode !== null || helper.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        helper.kill("SIGKILL");
      } catch {
        /* 已死 */
      }
    }, HELPER_STOP_GRACE_MS);
    timer.unref?.();
    helper.once("exit", done);
    helper.once("error", done);
    try {
      helper.kill("SIGTERM");
    } catch {
      done();
    }
  });
}

/** 关闭 ingress listener：closeAllConnections + 摘除 socket 文件（win32 管道名无条目）+ 宽限兜底。两臂共用。 */
export function closeIngressServer(server: net.Server, ingressPath: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 250);
    timer.unref?.();
    try {
      server.close(done);
      // Node ≥18.2 的强制收尾；旧运行时缺此 API —— 可选调用（类型面经 holder 断言）。
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* 已关闭 */
    }
    try {
      fs.unlinkSync(ingressPath);
    } catch {
      /* ENOENT：本就不在 */
    }
  });
}

/**
 * 启动 helper-relay 子系统并执行真路径自探针（D13.5）。任何失败路径都完成全部拆除后
 * 才返回（杀 helper、关 ingress、删 per-boot 目录 —— 降级 boot 由 server.ts 重建目录
 * 并自持端点，§5.4 诊断可达）。
 */
export async function startPayswapPeerRelay(
  bootState: PayswapBrokerBootState,
  config: PayswapPeerRelayHelperConfig,
): Promise<PayswapPeerRelayStartResult> {
  const endpointPath = bootState.endpointPath;
  const endpointDir = path.dirname(endpointPath);
  const ingressPath = path.join(endpointDir, "ingress.sock");
  const tokenPath = path.join(endpointDir, "token");
  const probeTimeoutMs = config.probeTimeoutMs ?? 5_000;

  // (1) hash 验证的 spawn 前置（D13.4）。
  const hashReason = verifyHelperBinary(config);
  if (hashReason !== null) {
    return { verified: false, reason: hashReason, probe: UNVERIFIED_PROBE, relay: null };
  }

  // (2) per-boot 目录（§3.1(2)：0700 钉死，umask 无关）。
  try {
    fs.mkdirSync(endpointDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(endpointDir, 0o700);
  } catch (error) {
    return {
      verified: false,
      reason: `endpoint directory unavailable: ${String((error as Error).message)}`,
      probe: UNVERIFIED_PROBE,
      relay: null,
    };
  }

  // (3) ingress listener（host 自持，同目录）+ 可交换的连接 sink。
  let connectionSink: ((socket: net.Socket) => void) | null = null;
  const ingress = net.createServer();
  ingress.on("error", () => {
    /* listen 失败经 listening promise 冒泡；此后为传输噪声吞没 */
  });
  ingress.on("connection", (socket) => {
    socket.on("error", () => {});
    const sink = connectionSink;
    if (sink === null) {
      socket.destroy();
      return;
    }
    sink(socket);
  });
  const ingressListening = new Promise<void>((resolve, reject) => {
    ingress.once("error", reject);
    ingress.listen(ingressPath, () => {
      ingress.off("error", reject);
      try {
        fs.chmodSync(ingressPath, 0o600);
      } catch (error) {
        reject(error as Error);
        return;
      }
      resolve();
    });
  });
  ingressListening.catch(() => {
    /* 冒泡由下方 await 承接 */
  });

  let helper: ChildProcess | null = null;
  let stderrTail = "";

  /** 全拆除（失败路径专用）：杀 helper → 关 ingress → 删 per-boot 目录（含 token 文件）。 */
  const teardown = async (reason: string): Promise<PayswapPeerRelayStartResult> => {
    if (helper !== null) {
      await stopHelperProcess(helper);
    }
    await closeIngressServer(ingress, ingressPath);
    try {
      fs.rmSync(endpointDir, { recursive: true, force: true });
    } catch {
      /* 尽力而为；server.ts 降级路径的 §3.4 unlink 是 belt */
    }
    const exitNote =
      helper !== null && helper.exitCode !== null
        ? `; helper exited early (code ${helper.exitCode})`
        : "";
    const stderrNote = stderrTail.length > 0 ? `; helper stderr: ${stderrTail}` : "";
    return {
      verified: false,
      reason: `${reason}${exitNote}${stderrNote}`,
      probe: UNVERIFIED_PROBE,
      relay: null,
    };
  };

  try {
    await ingressListening;
  } catch (error) {
    return teardown(`ingress listen failed: ${String((error as Error).message)}`);
  }

  // (4) 一次性 token 文件（0600；helper 读后即删 —— argv 对同 uid 经 ps 可见故不走 argv）。
  const relayToken = randomBytes(32).toString("hex");
  try {
    const fd = fs.openSync(tokenPath, "w", 0o600);
    try {
      fs.writeSync(fd, relayToken);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tokenPath, 0o600);
  } catch (error) {
    return teardown(`one-shot token file unwritable: ${String((error as Error).message)}`);
  }

  // (5) spawn helper（hash 已验证）。env 透传：helper 是 hash 钉死的自有二进制（比 ss 的
  //     绝对路径白名单更强的锚），不消费 env；透传同时是协议忠实 fake（测试接缝）的载体。
  try {
    helper = spawn(
      config.helperPath,
      [
        "--endpoint",
        endpointPath,
        "--ingress",
        ingressPath,
        "--parent-pid",
        String(process.pid),
        "--token-file",
        tokenPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: process.env },
    );
  } catch (error) {
    helper = null;
    return teardown(`helper spawn failed: ${String((error as Error).message)}`);
  }
  helper.stderr?.on("data", (chunk: Buffer) => {
    if (stderrTail.length < STDERR_TAIL_LIMIT) {
      stderrTail += chunk.toString("utf8").slice(0, STDERR_TAIL_LIMIT - stderrTail.length);
    }
  });
  helper.on("error", () => {
    /* spawn/运行期错误经探针失败路径裁决（exitNote/stderrNote 带诊断） */
  });

  // (6) 真路径自探针（D13.5）：host 作为真实客户端连公共端点 → 第一条 ingress 头行
  //     必须识别出 host 自身。探针期的后续连接一律销毁（0700 目录内同 uid 竞争者窗口，
  //     ADR-13 residuals：竞争者赢得首条 → 身份不符 → fail-closed 降级）。
  const probeDeadline = Date.now() + probeTimeoutMs;
  let probeFirstTaken = false;
  // holder 对象：闭包内赋值 + 显式判空 —— 规避 let 闭包赋值的控制流收窄陷阱（boot.ts 同款）。
  const probeIngressResolve: { resolve: ((socket: net.Socket) => void) | null } = { resolve: null };
  const firstIngressConnection = new Promise<net.Socket>((resolve) => {
    probeIngressResolve.resolve = resolve;
  });
  connectionSink = (socket) => {
    if (probeFirstTaken) {
      socket.destroy();
      return;
    }
    probeFirstTaken = true;
    probeIngressResolve.resolve?.(socket);
  };

  let probeClient: net.Socket | null = null;
  try {
    probeClient = await connectUntilDeadline(endpointPath, probeDeadline);
  } catch {
    const result = await teardown(
      `public endpoint not reachable within ${probeTimeoutMs}ms (helper did not bind)`,
    );
    probeClient?.destroy();
    return result;
  }

  let probeOutcome: "pending" | "settled" | "timeout" = "pending";
  const relayRead = firstIngressConnection.then(async (socket) => {
    const read = await readRelayPeerFacts(
      socket,
      relayToken,
      Math.max(200, probeDeadline - Date.now()),
    );
    return { socket, facts: read.facts };
  });
  // 超时兜底：迟到的首条连接必须销毁（无泄漏、无状态，§3.3(4)）。
  relayRead.then(({ socket }) => {
    if (probeOutcome === "timeout") socket.destroy();
  }).catch(() => {});
  const timeoutRead = new Promise<{ socket: null; facts: null }>((resolve) => {
    const timer = setTimeout(() => {
      probeOutcome = "timeout";
      resolve({ socket: null, facts: null });
    }, Math.max(200, probeDeadline - Date.now()));
    timer.unref?.();
  });

  const probeRelay = await Promise.race([relayRead, timeoutRead]);
  probeOutcome = "settled";
  if (probeRelay.socket !== null) {
    // 拆探针双 socket（无状态：§9.2/§3.3(4)；helper 侧泵随 EOF 自然终结）。
    probeRelay.socket.destroy();
  }
  probeClient?.destroy();

  const hostUid = hostEffectiveUid();
  const facts = probeRelay.facts;
  const verified =
    facts !== null && hostUid !== null && facts.pid === process.pid && facts.uid === hostUid;
  if (!verified) {
    const factsNote =
      facts === null
        ? "no token-valid relay header arrived"
        : `relayed identity ${JSON.stringify(facts)} did not identify the host`;
    return teardown(`probe failed: ${factsNote}`);
  }

  const helperRef = helper;
  const transport: PayswapBrokerRelayTransport = {
    ingressPath,
    relayToken,
    listening: ingressListening,
    peerUidBasis: "header",
    setConnectionHandler(handler) {
      connectionSink = handler;
    },
    async stop() {
      await stopHelperProcess(helperRef);
      await closeIngressServer(ingress, ingressPath);
    },
  };
  // helper 运行期死亡（探针后）：无状态可救 —— 端点随 helper 消失，新连接不可达
  //（fail-closed by construction，ADR-13 consequences）；已建立的 relay 由各自的 socket
  // 生命周期收尾。这里只保证不产生未处理事件。
  helperRef.once("exit", () => {});
  return {
    verified: true,
    reason: null,
    probe: { verified: true, pid: facts.pid, uid: facts.uid },
    relay: transport,
  };
}
