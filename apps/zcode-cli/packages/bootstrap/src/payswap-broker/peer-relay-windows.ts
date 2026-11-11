/**
 * PaySwap broker peer-helper relay 子系统 —— win32 §5.3 臂（契约 w2-01 §3.2/§5.3/§5.4/§5.5；ADR-14）。
 *
 * 与 ADR-13 的 darwin 臂共用传输缝（PayswapBrokerRelayTransport：ingress 收养 + 事实来自
 * 认证后的头行 + close 时拆除），平台差异面（ADR-14 决策）：
 *
 * 1. **helper 持公共管道（D14.1/§3.2(1)）**：host 只铸 per-boot 随机管道名（§3.2(3)，
 *    mintBrokerBootState("win32")）；公共管道由 C# helper 以 DACL（§3.2(2)：当前用户
 *    SID ReadWrite、无继承、单实例）创建。host 在 verified 模式绝不创建公共管道。
 * 2. **token 与控制行走 stdin（D14.5）**：argv 无秘密（命令行对同用户进程经 WMI 可见
 *    —— win32 的 ps 等价物）；stdin 首行 = 一次性 32 字节 token，此后 append-only 控制
 *    行 {"v":1,"add":<pid>,"image":<path>|null}（严格闭键集）—— registerInstance 时把
 *    spawn 表条目推给 helper 的管道口门（§5.3(1)）。匿名管道对任何第三方不可读 ——
 *    D13.4 的一次性 token 文件竞态窗口在此不存在。
 * 3. **uid 维度由传输承担（D14.7）**：同用户边界 = helper 公共管道的 DACL（§3.2(2)），
 *    头行 uid 是哨兵 0 非证据 → transport 声明 peerUidBasis "transport"，server 跳过
 *    uid 比对（pid 仍来自 token 认证后的头行；探针身份法则 = pid === process.pid）。
 * 4. **真路径自探针（D14.7，D13.5 的 win32 形态）**：host 作为真实客户端连 helper-held
 *    公共管道（生产连接走的同一条内核路径），第一条 token 有效头行必须识别出 host 自身。
 *    任何失败 → 全拆（杀 helper、关 ingress、清测试缝目录）→ verified:false。
 *
 * 端点形状（D14.10 证据边界）：win32 = `\\.\pipe\payswap-broker-relay-<hex>`（ingress，
 * host 持有的多实例命名管道 —— libuv 默认安全描述符，Everyone 只读可连不可写：事实伪造
 * 边界仍是 token，残余记录于 ADR-14 D14.4）；POSIX 测试缝 = mkdtemp 目录内的 ingress.sock
 * （宿主半边在 POSIX CI 上经协议忠实 fake helper 钉住 —— Node 的 net 层对 pipe/UDS 形状
 * 透明）。Linux 永远走直接 ss+procfs reader（D13.8 —— 本模块只经 boot 层的 win32 路由
 * 构造，显式注入的平台测试除外）。
 *
 * host 侧专用；fail-closed：本模块任何意外都以 { verified:false, reason } 返回，绝不抛出。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { PayswapBrokerBootState } from "@zcode/shared/payswap";
import { readRelayPeerFacts } from "./peer-relay-protocol.js";
import {
  closeIngressServer,
  connectUntilDeadline,
  stopHelperProcess,
  verifyHelperBinary,
  type PayswapBrokerRelayTransport,
  type PayswapPeerRelayHelperConfig,
  type PayswapPeerRelayStartResult,
} from "./peer-relay.js";

/** win32 ingress 管道名前缀（§3.2(3) createSocketPath 纪律同款；per-boot 随机后缀）。 */
const WINDOWS_INGRESS_PIPE_PREFIX = "\\\\.\\pipe\\payswap-broker-relay-";

/** POSIX 测试缝的 ingress 目录前缀（mkdtemp 式；D14.10 证据边界）。 */
const POSIX_TEST_INGRESS_DIR_PREFIX = "payswap-relay-win-";

/** relay 头行 uid 的 win32 哨兵（D14.7：非证据 —— 同用户边界由 DACL 承担）。 */
const WINDOWS_UID_SENTINEL = 0;

/** 降级返回的探针占位（与 peer-relay.ts 同款；本地常量，避免跨臂私有面耦合）。 */
const UNVERIFIED_PROBE = { verified: false, pid: null, uid: null } as const;

/** 控制行缓冲上限（Belt：JSON 一行本就远小于此；超限 = 形状破坏 → 放弃本行）。 */
const CONTROL_LINE_MAX_BYTES = 4096;

/**
 * 铸 ingress 端点（平台感知）：
 * - win32：`\\.\pipe\payswap-broker-relay-<24-hex>`（内核对象，无文件系统条目）；
 * - POSIX（测试缝）：mkdtemp 目录内的 ingress.sock —— 宿主半边在 POSIX CI 上可证。
 */
function mintIngressEndpoint(): { ingressPath: string; cleanupDir: string | null } {
  if (process.platform === "win32") {
    return {
      ingressPath: `${WINDOWS_INGRESS_PIPE_PREFIX}${randomBytes(12).toString("hex")}`,
      cleanupDir: null,
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), POSIX_TEST_INGRESS_DIR_PREFIX));
  return { ingressPath: path.join(dir, "ingress.sock"), cleanupDir: dir };
}

/** spawn-table 控制行（D14.5 严格形状：恰三键 v/add/image；image 为 string|null）。 */
function serializeSpawnTableLine(childPid: number, imagePath: string | null): string {
  return `${JSON.stringify({ v: 1, add: childPid, image: imagePath })}\n`;
}

/**
 * 启动 win32 helper-relay 子系统并执行真路径自探针（ADR-14 D14.7）。任何失败路径都完成
 * 全部拆除后才返回（杀 helper、关 ingress、清 POSIX 测试缝目录 —— 降级 boot 由
 * server.ts 重建端点并自持，§5.4 诊断可达）。
 */
export async function startPayswapWindowsPeerRelay(
  bootState: PayswapBrokerBootState,
  config: PayswapPeerRelayHelperConfig,
): Promise<PayswapPeerRelayStartResult> {
  const endpointPath = bootState.endpointPath;
  const probeTimeoutMs = config.probeTimeoutMs ?? 5_000;

  // (1) hash 验证的 spawn 前置（D13.4/D14.5 共用纪律）：不符绝不 spawn。
  const hashReason = verifyHelperBinary(config);
  if (hashReason !== null) {
    return { verified: false, reason: hashReason, probe: UNVERIFIED_PROBE, relay: null };
  }

  // (2) ingress 端点（平台感知铸造）+ 可交换的连接 sink。
  const { ingressPath, cleanupDir } = mintIngressEndpoint();
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
      if (cleanupDir !== null) {
        try {
          fs.chmodSync(ingressPath, 0o600);
        } catch (error) {
          reject(error as Error);
          return;
        }
      }
      resolve();
    });
  });
  ingressListening.catch(() => {
    /* 冒泡由下方 await 承接 */
  });

  let helper: ChildProcess | null = null;
  let stderrTail = "";

  /** 全拆除（失败路径专用）：杀 helper → 关 ingress → 清 POSIX 测试缝目录。 */
  const teardown = async (reason: string): Promise<PayswapPeerRelayStartResult> => {
    if (helper !== null) {
      await stopHelperProcess(helper);
    }
    await closeIngressServer(ingress, ingressPath);
    if (cleanupDir !== null) {
      try {
        fs.rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
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

  // (3) spawn helper（hash 已验证；argv 无秘密 —— token/控制行走 stdin，D14.5）。
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
        "--parent-image",
        process.execPath,
        // 诊断缝（helperArgs）：标准 argv 之后的追加参数（D14.10 —— CI 的 --diag 等；
        // 生产不传）。
        ...(config.helperArgs ?? []),
      ],
      { stdio: ["pipe", "ignore", "pipe"], env: process.env },
    );
  } catch (error) {
    helper = null;
    return teardown(`helper spawn failed: ${String((error as Error).message)}`);
  }
  helper.on("error", () => {
    /* spawn/运行期错误经探针失败路径裁决（exitNote/stderrNote 带诊断） */
  });
  helper.stderr?.on("data", (chunk: Buffer) => {
    if (stderrTail.length < 400) {
      stderrTail += chunk.toString("utf8").slice(0, 400 - stderrTail.length);
    }
  });

  // (4) 一次性 token 经 stdin 首行交付（D14.5：匿名管道对第三方不可读；helper 收到
  //     合法 token 才创建公共管道）。stdin 此后保持开放承载控制行。stdio 显式
  //     ["pipe", ...] —— 运行时 stdin 必在；类型面经判空守卫（null = spawn 异形 → 降级）。
  const relayToken = randomBytes(32).toString("hex");
  const helperStdin = helper.stdin;
  if (helperStdin === null) {
    return teardown("helper stdin unavailable (spawn did not provide a pipe)");
  }
  helperStdin.on("error", () => {
    /* helper 死亡后的写入噪声 —— 探针/运行期裁决在别处 */
  });
  try {
    helperStdin.write(`${relayToken}\n`);
  } catch (error) {
    return teardown(`one-shot token delivery failed: ${String((error as Error).message)}`);
  }

  // (5) 真路径自探针（D14.7）：host 作为真实客户端连公共管道 → 第一条 ingress 头行
  //     必须识别出 host 自身（pid 法则；uid 是哨兵非证据）。探针期的后续连接一律销毁。
  const probeDeadline = Date.now() + probeTimeoutMs;
  let probeFirstTaken = false;
  // holder 对象：闭包内赋值 + 显式判空 —— 规避 let 闭包赋值的控制流收窄陷阱（peer-relay.ts 同款）。
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

  // 探针身份法则（win32 形态，D14.7）：pid 必须 = host 自身；uid 是哨兵（0），不参与
  // 判定 —— 同用户边界由 helper 公共管道的 DACL 在管道口承担（§3.2(2)）。
  const facts = probeRelay.facts;
  const verified = facts !== null && facts.pid === process.pid;
  if (!verified) {
    const factsNote =
      facts === null
        ? "no token-valid relay header arrived"
        : `relayed identity ${JSON.stringify(facts)} did not identify the host`;
    return teardown(`probe failed: ${factsNote}`);
  }

  const helperRef = helper;
  const transport: PayswapBrokerRelayTransport & { registerChildPid(childPid: number, imagePath: string | null): void } = {
    ingressPath,
    relayToken,
    listening: ingressListening,
    peerUidBasis: "transport",
    registerChildPid(childPid, imagePath) {
      // D14.5/D14.8：spawn 表推送。helper 已死时 write 报 error（上方吞没器接管）；
      // 超限的病态输入直接放弃（fail-closed：该 pid 在管道口保持不可核验 = 弃）。
      const line = serializeSpawnTableLine(childPid, imagePath);
      if (line.length > CONTROL_LINE_MAX_BYTES) return;
      const stdin = helperRef.stdin;
      if (stdin !== null && helperRef.exitCode === null && helperRef.signalCode === null) {
        stdin.write(line);
      }
    },
    setConnectionHandler(handler) {
      connectionSink = handler;
    },
    async stop() {
      // 优雅先行：stdin EOF（host 终结）→ helper 自退；宽限后硬终止兜底（win32 kill）。
      try {
        helperRef.stdin?.end();
      } catch {
        /* 已死 */
      }
      await stopHelperProcess(helperRef);
      await closeIngressServer(ingress, ingressPath);
      if (cleanupDir !== null) {
        try {
          fs.rmSync(cleanupDir, { recursive: true, force: true });
        } catch {
          /* 尽力而为 */
        }
      }
    },
  };
  // helper 运行期死亡（探针后）：无状态可救 —— 管道对象随 helper 句柄消失，新连接不可达
  //（fail-closed by construction）；已建立的 relay 由各自的 socket 生命周期收尾。
  helperRef.once("exit", () => {});
  return {
    verified: true,
    reason: null,
    probe: { verified: true, pid: facts.pid, uid: WINDOWS_UID_SENTINEL },
    relay: transport,
  };
}
