/**
 * PaySwap broker POSIX 对等凭据读取 —— Linux 臂（契约 w2-01 §5.1；ADR-3/ADR-4）。
 *
 * 法则（§5.1(1)）：broker 必须在 accept 时读到对端进程的真实 (pid, uid)。Node 的公开 API
 * 既不暴露 SO_PEERCRED 也不允许客户端 socket 预 bind —— 本模块用内核事实源组合出等价读取：
 *
 * 1. accepted socket 的 fd（libuv handle）→ `/proc/self/fd/<fd>` → 本端 socket inode；
 * 2. `ss -xH state established`（iproute2，内核 SOCK_DIAG/netlink 的回答）→
 *    `u_str` 行的 local/peer inode **配对** —— 这是 pure-Node 下唯一可获得两端口配对关系
 *    的内核来源；
 * 3. `/proc/<pid>/fd/*` 全量扫描，找到持有对端 socket inode 的进程 —— **恰一个**持有者
 *    （fd 被转发给第二个进程 = 歧义 = fail-closed）；
 * 4. `/proc/<pid>/status` 的 `Uid:` 行（effective uid）。
 *
 * 安全性质（ADR-3 as-built）：
 * - 每个 pid/uid 都来自内核（procfs / SOCK_DIAG），不采纳线上任何 claim（§5.2(3)）；
 * - `ss` 只从固定绝对路径白名单解析（防 PATH 劫持），带超时与输出上限，解析用严格行正则；
 * - 任何一步失败/超时/歧义 → 返回 null（fail-closed，绝不抛裸错误）—— 由 boot 自探针
 *   （ADR-4）决定 degraded_refusing，由 accept 路径按 §5.4/§5.5 拒绝；
 * - 非 Linux 平台不构造本 reader（`createDefaultPeerCredentialReader` → unavailable）。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import type net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 对端进程身份：内核事实（pid + effective uid），非线上 claim。 */
export interface PeerCredentialRead {
  pid: number;
  uid: number;
}

/**
 * 对等凭据 reader 抽象（§5.1 的"runtime API 或 native helper"escape hatch 的宿主面）。
 * `readAcceptedSocketPeer` 返回 null = 无法建立对端身份（fail-closed，唯一安全语义）。
 */
export interface PeerCredentialReader {
  readonly kind: "linux" | "unavailable";
  readonly detail: string;
  readAcceptedSocketPeer(socket: net.Socket): Promise<PeerCredentialRead | null>;
}

// `ss` 只从固定绝对路径解析（同 uid 攻击者无法用 PATH 注入替身；未命中白名单 = 不可用）。
const SS_BINARY_ALLOWLIST = ["/usr/sbin/ss", "/usr/bin/ss", "/bin/ss", "/sbin/ss"] as const;
const SS_TIMEOUT_MS = 2_000;
const SS_MAX_BUFFER = 8 * 1024 * 1024;
/** 整条读取路径（ss + /proc 扫描）的墙钟上限；超时 = 无法建立身份 = null。 */
const READ_DEADLINE_MS = 2_500;

let cachedSsBinary: string | null | undefined;

function resolveSsBinary(): string | null {
  if (cachedSsBinary !== undefined) return cachedSsBinary;
  cachedSsBinary = null;
  for (const candidate of SS_BINARY_ALLOWLIST) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedSsBinary = candidate;
      break;
    } catch {
      /* 白名单下一个 */
    }
  }
  return cachedSsBinary;
}

/** `/proc/self/fd/<fd>` → `socket:[inode]`；非 socket fd / 读取失败 → null。 */
function readSocketInodeOfFd(fd: number): number | null {
  try {
    const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
    const match = /^socket:\[(\d+)\]$/.exec(link);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** `ss -xH state established` 的 u_str 行：local/peer 各两个 token（addr + inode）。 */
const SS_USTR_ROW_PATTERN = /^u_str\s+\d+\s+\d+\s+\S+\s+(\d+)\s+\S+\s+(\d+)/;

/**
 * SOCK_DIAG 配对：本端 inode → 对端 socket inode。ss 行样例（-H 去 header、state 过滤后
 * State 列被省略）：`u_str 0 0 * 20152 * 20153`。绑定路径的 socket 行 local 列是路径本身
 * （`/tmp/x.sock 316`），正则的 `(\S+)` token 对两种形态都成立。
 */
async function findEstablishedPeerInode(localInode: number): Promise<number | null> {
  const ssBinary = resolveSsBinary();
  if (ssBinary === null) return null;
  try {
    const { stdout } = await execFileAsync(ssBinary, ["-xH", "state", "established"], {
      timeout: SS_TIMEOUT_MS,
      maxBuffer: SS_MAX_BUFFER,
      encoding: "utf8",
      // 不继承调用方 env —— ss 只需要内核回答，不需要任何用户可控输入。
      env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin" },
    });
    for (const line of stdout.split("\n")) {
      const match = SS_USTR_ROW_PATTERN.exec(line);
      if (match && Number(match[1]) === localInode) {
        return Number(match[2]);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 全量 `/proc/<pid>/fd` 扫描：谁持有该 socket inode。**恰一个**持有者才返回 ——
 * 空集（对端已死 / 越权不可读即异 uid）或多集（fd 被转发 → 身份歧义）都 fail-closed。
 */
function scanSocketHolders(socketInode: number, deadline: number): number[] {
  const target = `socket:[${socketInode}]`;
  const holders: number[] = [];
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    if (Date.now() > deadline) return []; // 墙钟上限 —— 慢系统 = 无法建立身份
    const pid = Number(entry);
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      // EACCES = 异 uid 进程（0700 端点目录下本就不该出现；无法枚举即不可信）→ 跳过。
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === target) {
          holders.push(pid);
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return holders;
}

/** `/proc/<pid>/status` 的 `Uid:` 行 → effective uid（第二列）。不可读 → null。 */
function readEffectiveUid(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
    return match ? Number(match[2]) : null; // real, [effective], saved, fs
  } catch {
    return null;
  }
}

/**
 * host 自身的 effective uid（§5.1(2) 比对基准）。平台不暴露 `geteuid`（如 win32 的
 * @types/node 可选面）→ null = 无法建立"uid 等值"判据 = fail-closed。
 */
export function hostEffectiveUid(): number | null {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

/** Linux 对等凭据 reader（§5.1 POSIX 臂的唯一实现；host 侧专用）。 */
export function createLinuxPeerCredentialReader(): PeerCredentialReader {
  return {
    kind: "linux",
    detail: "ss(SOCK_DIAG) pairing + /proc holder scan + /proc/<pid>/status uid",
    async readAcceptedSocketPeer(socket) {
      try {
        const deadline = Date.now() + READ_DEADLINE_MS;
        // libuv handle fd：非公开 API 但自 libuv 起稳定；缺失 = 无法建立身份。
        const fd = (socket as { _handle?: { fd?: number } | null })._handle?.fd;
        if (typeof fd !== "number" || fd < 0) return null;
        const acceptedInode = readSocketInodeOfFd(fd);
        if (acceptedInode === null) return null;
        const peerInode = await findEstablishedPeerInode(acceptedInode);
        if (peerInode === null) return null;
        const holders = scanSocketHolders(peerInode, deadline);
        if (holders.length !== 1) return null;
        const uid = readEffectiveUid(holders[0]);
        if (uid === null) return null;
        return { pid: holders[0], uid };
      } catch {
        // 读取路径的任何意外都 = 无法建立身份（§5.4 fail-closed），绝不抛出。
        return null;
      }
    },
  };
}

/** 显式不可用的 reader（平台无实现 / 测试强制 degraded / 未来 native helper 缺位）。 */
export function createUnavailablePeerCredentialReader(reason: string): PeerCredentialReader {
  return {
    kind: "unavailable",
    detail: reason,
    async readAcceptedSocketPeer() {
      return null;
    },
  };
}

/**
 * 平台默认 reader（§5.1(1) 的"runtime 暴露则用之，否则 fail-closed"）：
 * - linux → ss+procfs reader；
 * - 其它平台（darwin 的 SecCode/getpeereid native helper、win32 的 pipe helper 均为
 *   后续 wave 的 native 工作）→ unavailable —— §5.4：无法建立对端身份的平台拒绝服务。
 */
export function createDefaultPeerCredentialReader(platform: string = process.platform): PeerCredentialReader {
  if (platform === "linux") {
    return createLinuxPeerCredentialReader();
  }
  return createUnavailablePeerCredentialReader(`no peer-credential reader for platform ${platform}`);
}
