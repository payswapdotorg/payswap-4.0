/**
 * PaySwap broker 引导（契约 w2-01 §3.1、§3.4、§5.4；ADR-4）。
 *
 * 引导序（normative，ADR-4）：
 * 1. **自探针先于 listener 绑定**：用真实 loopback UDS socket 对（throwaway listener +
 *    self client + accepted —— 非 mock）走完整条对等凭据读取路径；reader 必须把"对端"识别
 *    为 host 自身（pid = process.pid、effective uid = geteuid()）才算子系统可用。探针临时
 *    目录随后清理，不留残骸。
 * 2. 探针失败（任何一步）→ `degraded_refusing`（§5.4）：**socket 照常绑定**（诊断可达），
 *    但每个请求在 peer gate 即拒 `peer_verification_failed` —— 金融服务永不可经未验证
 *    对端触达；token-only 回退被禁止。
 * 3. 端点落位（§3.1(2)/§3.4(1)）：per-boot 0700 目录 + 0600 socket + 绑定前拒绝/移除
 *    既有条目（server.ts 内执行，此处只负责编排与审计）。
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  createPayswapInstanceRegistry,
  type PayswapBrokerBootState,
  type PayswapInstanceRegistry,
  type PayswapSeenRecords,
} from "@zcode/shared/payswap";
import {
  createDefaultPeerCredentialReader,
  createUnavailablePeerCredentialReader,
  hostEffectiveUid,
  type PeerCredentialReader,
} from "./peer-credentials.js";
import {
  resolveDefaultPeerRelayHelper,
  startPayswapPeerRelay,
  type PayswapBrokerRelayTransport,
  type PayswapPeerRelayHelperConfig,
  type PayswapPeerRelayStartResult,
} from "./peer-relay.js";
import { startPayswapWindowsPeerRelay } from "./peer-relay-windows.js";
import {
  createPayswapBrokerServer,
  PAYSWAP_BROKER_DEFAULT_CLOSE_GRACE_MS,
  PAYSWAP_BROKER_DEFAULT_IDLE_TIMEOUT_MS,
  type PayswapBrokerAuditEvent,
  type PayswapBrokerHandle,
  type PayswapBrokerMode,
} from "./server.js";
import type {
  PayswapAccountDetailReader,
  PayswapAccountOverviewReader,
  PayswapLiveStateReader,
} from "./dispatch.js";
import type {
  PayswapEntityWorkspaceResolver,
  PayswapSessionScopeResolver,
} from "./session-scope.js";

export interface PayswapBrokerBootOptions {
  /** P1.2 `mintBrokerBootState` 的产物：host id + Ed25519 钥对 + per-boot endpoint 路径。 */
  bootState: PayswapBrokerBootState;
  /** 实例注册表（§10；缺省 = broker 内部新建 —— 集成接线时 host 传入自己的注册表）。 */
  registry?: PayswapInstanceRegistry;
  /** 对等凭据 reader（缺省 = 平台默认：linux → ss+procfs；其它 → unavailable）。 */
  reader?: PeerCredentialReader;
  /** 平台判定（缺省 process.platform；测试可注入 darwin/win32 走 fail-closed 臂）。 */
  platform?: string;
  /**
   * ADR-13 D13.9：显式 helper-relay 配置（宿主半边测试接缝）。缺省 = 平台/env 解析
   * （`resolveDefaultPeerRelayHelper`：仅 darwin + `PAYSWAP_BROKER_HELPER_{PATH,SHA256}`）。
   * 仅在未注入显式 reader 时生效（显式 reader 是既有测试面，优先）。
   */
  peerRelayHelper?: PayswapPeerRelayHelperConfig;
  /** §3.3(4) 空闲上限（缺省 30 s，SHOULD ≥ 30 s）。 */
  idleTimeoutMs?: number;
  /** ADR-6 close() 兜底宽限（缺省 250 ms）。 */
  closeGraceMs?: number;
  /** §11 审计 ingress sink。 */
  auditSink?: (event: PayswapBrokerAuditEvent) => void;
  /** §7.3 live 状态 reader（Step 4；缺省 → S2 not_connected，见 dispatch.ts）。 */
  liveStateReader?: PayswapLiveStateReader;
  /**
   * §7.3/P2.2 slice 3 account-overview reader：get_account_overview 在 enabled +
   * opted-in 时的连接投影数据源（每次 dispatch 现读）。缺省 → 概览不答数据。
   * 仅当 live 状态**实读**为 opted-in 时被咨询（三码法则优先于数据路径）。
   */
  accountOverviewReader?: PayswapAccountOverviewReader;
  /**
   * ADR-P2-1 account-detail reader：get_account_overview 的 connectionId 收窄数据源
   *（账户服务 getOverviewData —— 验证读 + 能力证据 + 四类别只读数据）。缺省 →
   * detail 数据面诚实缺席。仅当三码法则已判定 opted-in 且状态实读时被咨询。
   */
  accountDetailReader?: PayswapAccountDetailReader;
  /** §8.1 会话 resolver（Step 5；缺省 → fail-closed session_unresolvable，见 server.ts）。 */
  sessionScopeResolver?: PayswapSessionScopeResolver;
  /** §8.3 实体工作区 resolver（Step 5；Wave 2 生产不接线，§13）。 */
  entityWorkspaceResolver?: PayswapEntityWorkspaceResolver;
  /**
   * §9 seen-record 引擎（Step 6，ADR-9）：缺省 = server 内部新建；测试/集成注入共享
   * 实例做状态内省（内存界行）。dedupe scope = broker 实例（§9.2）。
   */
  seenRecords?: PayswapSeenRecords;
}

export interface PayswapBrokerProbeResult {
  verified: boolean;
  pid: number | null;
  uid: number | null;
}

/**
 * 自探针（ADR-4）：真实 loopback UDS 对上走完整读取路径，reader 必须识别出 host 自身。
 * 任何失败 → { verified: false }（fail-closed 的唯一来源）。
 */
async function probePeerCredentialReader(
  reader: PeerCredentialReader,
): Promise<PayswapBrokerProbeResult> {
  const probeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "payswap-broker-probe-"));
  const probePath = path.join(probeDir, "probe.sock");
  // holder 对象：闭包内赋值 + finally 内清理 —— 规避 let 闭包赋值的控制流收窄陷阱。
  const sockets: { server?: net.Server; client?: net.Socket; accepted?: net.Socket } = {};
  try {
    const accepted = await new Promise<net.Socket | null>((resolve) => {
      sockets.server = net.createServer((connection) => {
        sockets.accepted = connection;
        resolve(connection);
      });
      sockets.server.once("error", () => resolve(null));
      sockets.server.listen(probePath, () => {
        sockets.client = net.connect(probePath, () => {
          /* connected —— 等 accepted */
        });
        sockets.client.once("error", () => {
          /* 探针失败在下游统一裁决 */
        });
      });
      // 探针自身 5s 上限：子系统在不可用平台上挂死 = 不可用。
      setTimeout(() => resolve(null), 5_000).unref();
    });
    if (accepted === null) return { verified: false, pid: null, uid: null };
    const read = await reader.readAcceptedSocketPeer(accepted);
    if (read === null) return { verified: false, pid: null, uid: null };
    // 对端就是 host 自己 —— 识别结果必须精确等于自身身份（geteuid 缺席 = 无法判据）。
    const hostUid = hostEffectiveUid();
    const verified =
      hostUid !== null && read.pid === process.pid && read.uid === hostUid;
    return { verified, pid: read.pid, uid: read.uid };
  } catch {
    return { verified: false, pid: null, uid: null };
  } finally {
    try {
      sockets.accepted?.destroy();
      sockets.client?.destroy();
      await new Promise<void>((resolve) => {
        const server = sockets.server;
        if (server === undefined) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    } catch {
      /* 探针清理失败不外泄 —— finally 的目录删除才是硬保证 */
    }
    try {
      await fs.promises.rm(probeDir, { recursive: true, force: true });
    } catch {
      /* rm force 尽力而为；探针目录无凭据材料（§11(2) 不受影响） */
    }
  }
}

/**
 * 引导 PaySwap broker：自探针 →（可用 | degraded）→ 端点绑定（server.ts 的 §3.1/§3.4
 * 落位）→ 返回 handle。listen 失败（端点被占且不可移除等）会 reject —— 调用方不获得
 * 半启动的 broker。
 */
export async function bootPayswapBroker(options: PayswapBrokerBootOptions): Promise<PayswapBrokerHandle> {
  const platform = options.platform ?? process.platform;
  const registry = options.registry ?? createPayswapInstanceRegistry();
  const idleTimeoutMs = options.idleTimeoutMs ?? PAYSWAP_BROKER_DEFAULT_IDLE_TIMEOUT_MS;
  const closeGraceMs = options.closeGraceMs ?? PAYSWAP_BROKER_DEFAULT_CLOSE_GRACE_MS;
  const auditSink = options.auditSink ?? (() => {});

  // (1) 对等验证子系统（ADR-13/ADR-14）：优先尝试 helper-relay（darwin §5.1 臂 = C helper
  //     + UDS 缝；win32 §5.3 臂 = C# helper + 命名管道缝 —— 同一传输面，平台分流）；
  //     不可用/未验证 → 直接 reader 路径（Linux ss+procfs；其它平台 unavailable）→
  //     degraded_refusing（§5.4）。显式 reader 注入（既有测试面）跳过 relay。平台门
  //     （D13.8/D14.5）：Linux 永远走直接 reader，缝不分叉第二套 Linux 实现。
  const relayCapablePlatform = platform === "darwin" || platform === "win32";
  const relayConfig =
    options.reader === undefined && relayCapablePlatform
      ? (options.peerRelayHelper ?? resolveDefaultPeerRelayHelper(platform, process.env))
      : null;
  let relay: PayswapBrokerRelayTransport | null = null;
  let relayFailureReason: string | null = null;
  let probe: PayswapBrokerProbeResult = { verified: false, pid: null, uid: null };
  let reader: PeerCredentialReader;

  if (relayConfig !== null) {
    // 平台分流（D14.5）：darwin → POSIX 缝 starter；win32 → 管道缝 starter（token/
    // 控制行走 stdin、spawn 表推送、uid 由 DACL 承担 —— ADR-14）。
    const started: PayswapPeerRelayStartResult =
      platform === "win32"
        ? await startPayswapWindowsPeerRelay(options.bootState, relayConfig)
        : await startPayswapPeerRelay(options.bootState, relayConfig);
    if (started.verified && started.relay !== null) {
      relay = started.relay;
      probe = started.probe;
    } else {
      // D13.5：任何失败 → helper/ingress 已拆；降级原因带平台前缀（§11(3) 操作员可见）。
      relayFailureReason = `${platform}: peer-credential subsystem unavailable (helper relay: ${
        started.reason ?? "did not verify (no reason recorded)"
      })`;
    }
  }

  let mode: PayswapBrokerMode;
  let degradedReason: string | null;
  if (relay !== null) {
    mode = "peer_verified";
    degradedReason = null;
    reader = createUnavailablePeerCredentialReader("helper-relay transport active (reader unused)");
  } else {
    reader = options.reader ?? createDefaultPeerCredentialReader(platform);
    // 自探针先于 listener 绑定（ADR-4）。
    probe = await probePeerCredentialReader(reader);
    mode = probe.verified ? "peer_verified" : "degraded_refusing";
    degradedReason = probe.verified
      ? null
      : (relayFailureReason ??
        `${platform}: peer-credential subsystem unavailable (reader=${reader.kind}:${reader.detail})`);
  }

  // §11(3)：degraded 状态在入口记录原因（操作员可见诊断）；拒绝只带 typed code。
  auditSink({
    ts: Date.now(),
    outcome: "boot",
    code: probe.verified ? "peer_verified" : "degraded_refusing",
    instanceId: null,
    seq: null,
    op: null,
    peerPid: null,
  });

  // (2) 端点落位 + listener（server.ts 执行 §3.1(2)/§3.4(1)）；degraded 也绑定（§5.4）。
  //     relay 模式：server 采用 ingress listener（公共端点由 helper 持有）。
  const { handle, listening } = createPayswapBrokerServer({
    bootState: options.bootState,
    registry,
    reader,
    ...(relay !== null ? { relay } : {}),
    mode,
    degradedReason,
    probe,
    idleTimeoutMs,
    closeGraceMs,
    auditSink,
    liveStateReader: options.liveStateReader,
    accountOverviewReader: options.accountOverviewReader,
    accountDetailReader: options.accountDetailReader,
    sessionScopeResolver: options.sessionScopeResolver,
    entityWorkspaceResolver: options.entityWorkspaceResolver,
    seenRecords: options.seenRecords,
  });
  await listening;
  return handle;
}
