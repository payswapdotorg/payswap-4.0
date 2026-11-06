/**
 * PaySwap broker server —— UDS 线路协议宿主（契约 w2-01 §3、§4.5、§5.5、§6.3、§8、§10、
 * §11；ADR-5/ADR-6/ADR-8）。host 侧专用：listener、accept 检查序、签名响应、生命周期。
 *
 * 检查序（§5.5，normative，不可重排）：
 *   (1) 对等验证（§5.1 —— uid 等值 + pid ∈ host spawn 表；impostor 在**任何载荷字节被
 *       解析之前**丢弃）→ (shutting-down 检查：broker_unavailable，§6.3) → (2) 载荷解析 +
 *       1 MiB 上限（§3.3(2)）+ §6.1 `.strict()` 请求 schema（Step 4：未知键/op 越枚举/
 *       token 形状/seq/sessionId —— pre-binding，null-bound）→ (3) token 时序安全比对
 *       （§4.5，比对对象是**对端 pid 映射的实例**的 token，不是线上 claim 的）→
 *       (4) 实例/注册表绑定（§5.2(3)：claim 被核对，永不被采纳；tombstone 原因分裂：
 *       exit/superseded → instance_unknown；disabled → D5.6 流通到 dispatch）→
 *       (4.5) §8 会话解析 + 工作区隔离（Step 5，ADR-8：live 实例经注入 resolver 权威
 *       下游解析 sessionId hint，判定字段 = 注册条目 sessionScope；实体引用对照
 *       workspace；disable 撤销臂绕过 —— 无 resolver 即 fail-closed
 *       session_unresolvable，§8.1 resolved-not-asserted）→ (5) 重放检查（Step 6，
 *       未落地）→ (6) dispatch（Step 4：§7 闭集六操作表 + §7.3 三码法则 live 读；
 *       per-op params 违例与 reader 故障为绑定后拒绝，request-attributed）。
 *
 * fail-closed 纪律：
 * - degraded_refusing（§5.4）：socket 照常绑定（诊断可达），每个请求 peer gate 即拒
 *   `peer_verification_failed`；
 * - 一切响应都经 `signResponseEnvelope` 签名（§6.5(2)：v1 无未签名模式）；pre-binding
 *   拒绝一律 null-bound（§6.4(3)）；
 * - failPeer（ADR-5/D5.4）：`socket.end(line)` + `socket.resume()` —— 写完错误行后半关，
 *   消费-丢弃剩余字节、绝不解析；否决 `destroy()`（RST 竞态会让对端读不到错误行）。
 *
 * close()（ADR-6）：进入 shutting-down → 停止接纳 → **先**摘除 socket 路径（新连接从此
 * 找不到端点，§3.4/§10.3）→ 等待 live 连接归零，至多 closeGraceMs（默认 250ms）兜底强断
 * → finally 无条件清理 socket 文件 + per-boot 目录；幂等。
 */

import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  PAYSWAP_MAX_LINE_BYTES,
  payswapBrokerRequestSchema,
  requestLineDigest,
  signResponseEnvelope,
  type PayswapBrokerBootState,
  type PayswapBrokerErrorCode,
  type PayswapBrokerOp,
  type PayswapBrokerResponseBody,
  type PayswapInstanceRegistry,
  type PayswapInstanceRegistryEntry,
} from "@zcode/shared/payswap";
import type { PeerCredentialReader } from "./peer-credentials.js";
import { hostEffectiveUid } from "./peer-credentials.js";
import {
  createPayswapBrokerDispatch,
  type PayswapBrokerDispatch,
  type PayswapInstanceBinding,
  type PayswapLiveStateReader,
} from "./dispatch.js";
import {
  isSessionWithinBindingScope,
  type PayswapEntityWorkspaceResolver,
  type PayswapSessionScopeResolver,
} from "./session-scope.js";

/** 审计 ingress 事件（§11 —— Wave 2 形状：结构化本地审计，P7 ledger 的前芽）。 */
export interface PayswapBrokerAuditEvent {
  ts: number;
  outcome: "boot" | "dispatched" | "refused" | "shutdown";
  /** 拒绝码（typed，闭集）或 degraded 原因；dispatched 时缺省。 */
  code?: string;
  instanceId: string | null;
  seq: number | null;
  op: string | null;
  /** §5.2 已验证的对端 pid（验证失败前为 null）。 */
  peerPid: number | null;
}

export type PayswapBrokerMode = "peer_verified" | "degraded_refusing";

/** §3.3(4)：空闲上限 SHOULD ≥ 30s（慢组装的合法调用永不竞速它）。 */
export const PAYSWAP_BROKER_DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** ADR-6：close() 对 stuck live 连接的兜底宽限。 */
export const PAYSWAP_BROKER_DEFAULT_CLOSE_GRACE_MS = 250;

export interface PayswapBrokerHandle {
  readonly mode: PayswapBrokerMode;
  readonly degradedReason: string | null;
  readonly endpointPath: string;
  readonly probe: { verified: boolean; pid: number | null; uid: number | null };
  /** 当前 live 连接数（ADR-6 live count 的只读面）。 */
  readonly liveConnectionCount: number;
  /** spawn 表注册（§5.2/§10.1）：同一 live instanceId 的重复注册被忽略（append-only）。 */
  registerInstance(entry: PayswapInstanceRegistryEntry): void;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface PayswapBrokerServerOptions {
  bootState: PayswapBrokerBootState;
  registry: PayswapInstanceRegistry;
  reader: PeerCredentialReader;
  mode: PayswapBrokerMode;
  degradedReason: string | null;
  probe: { verified: boolean; pid: number | null; uid: number | null };
  idleTimeoutMs: number;
  closeGraceMs: number;
  auditSink: (event: PayswapBrokerAuditEvent) => void;
  /** §7.3 live 状态 reader（Step 4；缺省 → S2 not_connected，见 dispatch.ts）。 */
  liveStateReader?: PayswapLiveStateReader;
  /**
   * §8.1 会话 resolver（Step 5，ADR-8 D8.2）：live 实例请求的 sessionId hint 经此权威
   * 下游解析。**缺省 = fail-closed**（无 resolver → 一切 live 请求 session_unresolvable
   * —— 会话被解析而非被声明；与 liveStateReader 的宽松缺省不同：会话是每次 dispatch
   * 的解析根，未解析的请求不得触及业务层）。disable 撤销臂不经此（D5.6 绕过）。
   */
  sessionScopeResolver?: PayswapSessionScopeResolver;
  /**
   * §8.3 实体工作区 resolver（Step 5）：params 命名实体的归属工作区；null = 未命名/未知
   * （落到三码法则）。Wave 2 生产不接线（无实体存储，§13）；端口与法则由注入行证明，
   * P2 接线。抽错 → internal_error（D7.7 同款分类）。
   */
  entityWorkspaceResolver?: PayswapEntityWorkspaceResolver;
}

// §6.1 `.strict()` 请求 schema（Step 4）—— 未知键/op 越枚举/token 形状/seq/sessionId
// 的 pre-binding 拒绝全部经此（null-bound，§6.4(3)）；三码业务拒绝的单一事实源在
// `@zcode/shared/payswap/operations.ts`（与插件契约同文的注释在那儿）。

/** failPeer/refuseParsed 后的排空段封顶：半开 socket 最多再存活 5 s（防恶意无限流）。 */
const DRAIN_CAP_MS = 5_000;

// Step-3 临时 dispatch 已随 Step 4 退役：三码业务拒绝的单一事实源现在在
// `@zcode/shared/payswap/operations.ts`（payswapBusinessRefusal）。

/** spawn 表条目：pid → {instanceId, token}（§5.2；注册表是 liveness 权威，本表是路由）。 */
interface SpawnTableEntry {
  instanceId: string;
  token: string;
  childPid: number;
}

type LineRead = { kind: "line"; line: string } | { kind: "oversize" } | { kind: "closed" };

export interface PayswapBrokerServer {
  handle: PayswapBrokerHandle;
  /** listen 就绪（含 0600 chmod）；失败（端点被占且不可移除等）在此 reject。 */
  listening: Promise<void>;
}

export function createPayswapBrokerServer(options: PayswapBrokerServerOptions): PayswapBrokerServer {
  const {
    bootState,
    registry,
    reader,
    mode,
    degradedReason,
    probe,
    idleTimeoutMs,
    closeGraceMs,
    auditSink,
    liveStateReader,
    sessionScopeResolver,
    entityWorkspaceResolver,
  } = options;
  const endpointPath = bootState.endpointPath;
  const endpointDir = path.dirname(endpointPath);
  const privateKey = bootState.keyPair.privateKey;
  // §7 闭集 dispatch 表（Step 4）—— per-request 调用，无共享可变状态。
  const dispatch: PayswapBrokerDispatch = createPayswapBrokerDispatch({ liveStateReader });

  // §3.1(2)：per-boot 0700 目录（mkdir mode 受 umask 影响 → chmod 钉死）。
  fs.mkdirSync(endpointDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(endpointDir, 0o700);

  // §3.4(1)：绑定前拒绝或移除既有文件系统条目 —— 移除（unlink），绝不静默采纳；
  // 无法移除（如目录）→ boot 失败（refuse 臂）。
  try {
    fs.unlinkSync(endpointPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `payswap broker endpoint path is occupied and not removable (contract §3.4(1)): ${endpointPath}`,
      );
    }
  }

  let shuttingDown = false;
  let liveConnections = 0;
  let closePromise: Promise<void> | null = null;
  const liveSockets = new Set<net.Socket>();
  /** pid → 实例路由（§5.2 spawn 表；注册表 liveness 是权威，见 registerInstance）。 */
  const spawnTable = new Map<number, SpawnTableEntry>();

  const server = net.createServer((socket) => {
    void handleConnection(socket);
  });

  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpointPath, () => {
      server.off("error", reject);
      try {
        // §3.1(2)：socket 0600（umask 无关，显式钉死）。
        fs.chmodSync(endpointPath, 0o600);
      } catch (error) {
        reject(error as Error);
        return;
      }
      resolve();
    });
  });
  listening.catch(() => {
    /* listen 失败由 bootPayswapBroker 的 await 冒泡；此处仅防止未处理 rejection */
  });

  function audit(
    outcome: PayswapBrokerAuditEvent["outcome"],
    fields: Partial<Pick<PayswapBrokerAuditEvent, "code" | "instanceId" | "seq" | "op" | "peerPid">> = {},
  ): void {
    // §11(2)：token / verify key / endpoint path 永不入审计；拒绝只带 typed code，无栈迹。
    auditSink({
      ts: Date.now(),
      outcome,
      instanceId: fields.instanceId ?? null,
      seq: fields.seq ?? null,
      op: fields.op ?? null,
      peerPid: fields.peerPid ?? null,
      ...("code" in fields && fields.code !== undefined ? { code: fields.code } : {}),
    });
  }

  /** 签名一个 null-bound 拒绝信封（§6.4(3)：pre-binding 拒绝的绑定字段全 null）。 */
  function signedNullBoundRefusal(code: PayswapBrokerErrorCode, retryable: boolean): string {
    const signed = signResponseEnvelope(
      {
        instanceId: null,
        seq: null,
        op: null,
        requestDigest: "",
        response: {
          ok: false,
          seq: 0,
          error: { code, message: `payswap broker refusal: ${code}`, retryable },
        },
      },
      privateKey,
      bootState.hostId,
    );
    return `${JSON.stringify(signed)}\n`;
  }

  /**
   * failPeer（ADR-5/D5.4）：end+resume —— 错误行完整写出的半关，随后消费-丢弃剩余字节、
   * 绝不解析（§5.5：未知 pid 在任何载荷字节被解析之前丢弃）。剩余流由 idle timer 封顶。
   */
  function failPeer(socket: net.Socket, code: PayswapBrokerErrorCode, peerPid: number | null): void {
    audit("refused", { code, peerPid });
    drainAfterEnd(socket);
    try {
      socket.end(signedNullBoundRefusal(code, false));
      socket.resume();
    } catch {
      socket.destroy();
    }
  }

  /** 解析后的拒绝（request_invalid / unauthorized / instance_unknown / broker_unavailable）。 */
  function refuseParsed(
    socket: net.Socket,
    code: PayswapBrokerErrorCode,
    retryable: boolean,
    fields: { peerPid: number | null; instanceId?: string | null; seq?: number | null; op?: string | null },
  ): void {
    audit("refused", { code, peerPid: fields.peerPid, instanceId: fields.instanceId ?? null, seq: fields.seq ?? null, op: fields.op ?? null });
    drainAfterEnd(socket);
    try {
      socket.end(signedNullBoundRefusal(code, retryable));
      socket.resume();
    } catch {
      socket.destroy();
    }
  }

  /**
   * 绑定后拒绝（Step 4）：per-op params 违例 / dispatch 层 internal_error —— 绑定字段
   * （instanceId/seq/op/digest）齐全且已验证，请求归属信封签名后回给对端（§6.4(3)
   * 只对 pre-binding 拒绝要求 null-bound）。
   */
  async function respondRequestAttributedError(
    socket: net.Socket,
    code: PayswapBrokerErrorCode,
    retryable: boolean,
    fields: {
      peerPid: number | null;
      instanceId: string;
      seq: number;
      op: PayswapBrokerOp;
      line: string;
    },
  ): Promise<void> {
    audit("refused", {
      code,
      peerPid: fields.peerPid,
      instanceId: fields.instanceId,
      seq: fields.seq,
      op: fields.op,
    });
    drainAfterEnd(socket);
    try {
      const signed = signResponseEnvelope(
        {
          instanceId: fields.instanceId,
          seq: fields.seq,
          op: fields.op,
          requestDigest: requestLineDigest(fields.line),
          response: {
            ok: false,
            seq: fields.seq,
            error: { code, message: `payswap broker refusal: ${code}`, retryable },
          },
        },
        privateKey,
        bootState.hostId,
      );
      socket.end(`${JSON.stringify(signed)}\n`);
      socket.resume();
    } catch {
      // 签名/序列化失败退到 null-bound（无细节外泄）。
      try {
        socket.end(signedNullBoundRefusal(code, retryable));
        socket.resume();
      } catch {
        socket.destroy();
      }
    }
  }

  /** D5.4 排空段封顶：end+resume 之后最多 DRAIN_CAP_MS 强断（finally 已释放 live count）。 */
  function drainAfterEnd(socket: net.Socket): void {
    const timer = setTimeout(() => socket.destroy(), DRAIN_CAP_MS);
    timer.unref?.();
    socket.once("close", () => clearTimeout(timer));
  }

  /**
   * 单行读取（§3.3）：读到首个换行为止；行长（不含换行）> 1 MiB → oversize（停止缓冲，
   * 继续排空到换行）；对端半关（end）→ 缓冲内容按行处理（JSON 尾随空白合法，digest 与
   * child 侧 `requestLineDigest` 的换行规范化一致）；连接关闭/超时 → closed（无响应，无状态）。
   */
  function readOneLine(socket: net.Socket, idleTimer: NodeJS.Timeout): Promise<LineRead> {
    return new Promise<LineRead>((resolve) => {
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
        settle({ kind: "line", line: buffer.toString("utf8") });
      };
      const onClose = () => settle({ kind: "closed" });
      socket.on("data", onData);
      socket.on("end", onEnd);
      socket.on("close", onClose);
      socket.on("error", onClose);
    });
  }

  async function handleConnection(socket: net.Socket): Promise<void> {
    liveConnections += 1;
    liveSockets.add(socket);
    // §3.3(4)：空闲上限（无状态的静默关闭；failPeer 的排空段也被它封顶）。
    const idleTimer = setTimeout(() => {
      socket.destroy();
    }, idleTimeoutMs);
    socket.on("close", () => {
      liveSockets.delete(socket);
    });
    let verifiedPid: number | null = null;
    try {
      // (1) 对等验证（§5.5 之首）—— degraded 模式下 peer gate 恒失败（§5.4）。
      if (mode === "degraded_refusing") {
        failPeer(socket, "peer_verification_failed", null);
        return;
      }
      const peer = await reader.readAcceptedSocketPeer(socket);
      const hostUid = hostEffectiveUid();
      if (peer === null || hostUid === null || peer.uid !== hostUid) {
        failPeer(socket, "peer_verification_failed", peer?.pid ?? null);
        return;
      }
      const mapped = spawnTable.get(peer.pid);
      if (mapped === undefined) {
        // 未知 pid：host 自己没有 spawn 过它 —— impostor，丢弃且不解析（§5.2/§6.3）。
        failPeer(socket, "peer_verification_failed", peer.pid);
        return;
      }
      verifiedPid = peer.pid;

      // (2) 载荷解析 + 上限（§3.3(2)）。
      const read = await readOneLine(socket, idleTimer);
      if (read.kind === "closed") {
        return; // 空闲超时/对端消失：无状态静默关闭（§3.3(4)）
      }
      // shutting-down 检查（§6.3 broker_unavailable 臂）：peer gate 之后、解析之前 ——
      // 在**行到达时**判定（关闭开始后到达的请求不再解析/分发；peer gate 仍然先行）。
      if (shuttingDown) {
        refuseParsed(socket, "broker_unavailable", true, { peerPid: verifiedPid });
        return;
      }
      if (read.kind === "oversize") {
        refuseParsed(socket, "request_invalid", false, { peerPid: verifiedPid });
        return;
      }
      const line = read.line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        refuseParsed(socket, "request_invalid", false, { peerPid: verifiedPid });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        refuseParsed(socket, "request_invalid", false, { peerPid: verifiedPid });
        return;
      }
      // §6.1 `.strict()` 请求 schema（Step 4）：未知键 / op 越枚举 / token 形状 / seq /
      // sessionId / trace 形状 —— pre-binding 拒绝（null-bound，§6.4(3)）。
      const parsedRequest = payswapBrokerRequestSchema.safeParse(parsed);
      if (!parsedRequest.success) {
        refuseParsed(socket, "request_invalid", false, { peerPid: verifiedPid });
        return;
      }
      const request = parsedRequest.data;
      const claimedInstanceId = request.instanceId;
      const claimedToken = request.token;
      const seq = request.seq;
      const op = request.op;

      // (3) token 验证（§4.5）：长度检查 + 时序安全比对；比对对象 = **对端 pid 映射实例**
      // 的 token —— 跨实例 token（含偷来的 token）在此死亡（N20）。
      const tokenBuffer = Buffer.from(claimedToken, "utf8");
      const expectedBuffer = Buffer.from(mapped.token, "utf8");
      if (
        tokenBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(tokenBuffer, expectedBuffer)
      ) {
        refuseParsed(socket, "unauthorized", false, { peerPid: verifiedPid });
        return;
      }

      // (4) 实例/注册表绑定（§5.2(3)/§10.1）：claim 被核对，永不被采纳。
      const lookup = registry.lookup(mapped.instanceId);
      // tombstone 原因分裂（§10.2 + ADR-5 D5.6，Step 4）：exit/superseded →
      // instance_unknown（pid-reuse 竞态与 dead-child token 臂，§10.2(1)）；
      // disabled → 绑定流通到 dispatch，按 financial_mode_disabled 业务拒绝回答
      // （§7.3 row 1 —— 注册表撤销是权威，§10.2(2)）。tombstoned 查询无 entry 字段 ——
      // childPid 一致性 belt 只对 live 条目执行；disabled 臂的 pid 归属由 spawn 表
      // （pid → instance 路由，registerInstance 写入）+ claim 匹配共同保证。
      let instanceBinding: PayswapInstanceBinding = "live";
      if (lookup === undefined) {
        refuseParsed(socket, "instance_unknown", false, {
          peerPid: verifiedPid,
          instanceId: claimedInstanceId,
        });
        return;
      }
      if (lookup.status === "tombstoned") {
        if (lookup.reason !== "disabled" || claimedInstanceId !== mapped.instanceId) {
          refuseParsed(socket, "instance_unknown", false, {
            peerPid: verifiedPid,
            instanceId: claimedInstanceId,
          });
          return;
        }
        instanceBinding = "disabled_revocation";
      } else if (claimedInstanceId !== mapped.instanceId || lookup.entry.childPid !== peer.pid) {
        refuseParsed(socket, "instance_unknown", false, {
          peerPid: verifiedPid,
          instanceId: claimedInstanceId,
        });
        return;
      }

      // (4.5) §8 会话解析 + 工作区隔离（Step 5，ADR-8）：live 实例专有 —— disable 撤销臂
      // 绕过（D5.6：注册表撤销是权威，被撤销实例无会话/实体 oracle，residual 调用答
      // financial_mode_disabled）。两拒绝都是**绑定后**的 request-attributed 桥接错误
      // （§6.3）—— 会话/实体失败先于三码法则（§7.3 是业务答案，预设解析成功）。
      // `lookup.status === "live"` ≡ `instanceBinding === "live"`（disabled 臂在上方
      // tombstoned 分支内改写并直落至此；exit/superseded 与 disabled 不匹配臂已 return）。
      const opValue = op as PayswapBrokerOp;
      if (lookup.status === "live") {
        // §8.1/§8.2 会话解析：hint 经 resolver 权威解析后须落在注册条目的 sessionScope
        // 内（hint 只能收窄永不放宽；判定字段是 sessionScope，不是 workspace）。无
        // resolver = fail-closed（无法权威解析即拒绝 —— 绝不从载荷采纳会话身份）。
        let resolvedSession = null as Awaited<ReturnType<PayswapSessionScopeResolver>>;
        if (sessionScopeResolver !== undefined) {
          try {
            resolvedSession = await sessionScopeResolver(request.sessionId);
          } catch {
            // requireSession 模式的 typed 失败即"不可解析"（域答案）；无细节外泄。
            resolvedSession = null;
          }
        }
        if (
          resolvedSession === null ||
          !isSessionWithinBindingScope({ sessionScope: lookup.entry.sessionScope }, resolvedSession)
        ) {
          await respondRequestAttributedError(socket, "session_unresolvable", false, {
            peerPid: verifiedPid,
            instanceId: mapped.instanceId,
            seq,
            op: opValue,
            line,
          });
          return;
        }
        // §8.3 实体隔离：params 命名实体归属工作区 ≠ 注册条目 workspace → mismatch。
        // resolver 缺席 = 无实体存储（Wave 2 生产形状，§13）—— 空真通过。
        if (entityWorkspaceResolver !== undefined) {
          let entityWorkspace: string | null;
          try {
            entityWorkspace = await entityWorkspaceResolver(opValue, request.params);
          } catch {
            // 未预期的 host 侧失败：typed internal_error，无细节外泄（D7.7 同款）。
            await respondRequestAttributedError(socket, "internal_error", false, {
              peerPid: verifiedPid,
              instanceId: mapped.instanceId,
              seq,
              op: opValue,
              line,
            });
            return;
          }
          if (entityWorkspace !== null && entityWorkspace !== lookup.entry.workspace) {
            await respondRequestAttributedError(socket, "workspace_mismatch", false, {
              peerPid: verifiedPid,
              instanceId: mapped.instanceId,
              seq,
              op: opValue,
              line,
            });
            return;
          }
        }
      }

      // (5) 重放检查 —— Step 6（§9），本步未落地（§12.1 顺序约束：水标引擎后行）。
      // §8 拒绝（步 4.5）不经此处 —— §9.3(1) 的 accepted-for-dispatch 边界在 dedupe，
      // pre-dispatch 拒绝不烧序列（ADR-8 D8.1）。

      // (6) dispatch（§7 闭集六操作表 + §7.3 三码法则，Step 4）。per-op params 违例与
      // reader 故障是**绑定后**的桥接拒绝：request-attributed（绑定字段齐全，§6.4(3)
      // 只对 pre-binding 拒绝要求 null-bound）。
      const outcome = await dispatch.resolveRequest(
        { instanceId: mapped.instanceId, seq, op: opValue, params: request.params },
        { instanceBinding },
      );
      if (outcome.kind === "refused") {
        await respondRequestAttributedError(socket, outcome.code, outcome.retryable, {
          peerPid: verifiedPid,
          instanceId: mapped.instanceId,
          seq,
          op: opValue,
          line,
        });
        return;
      }
      try {
        const signed = signResponseEnvelope(
          {
            instanceId: mapped.instanceId,
            seq,
            op: opValue,
            requestDigest: requestLineDigest(line),
            response: outcome.body,
          },
          privateKey,
          bootState.hostId,
        );
        audit("dispatched", { instanceId: mapped.instanceId, seq, op: opValue, peerPid: verifiedPid });
        socket.end(`${JSON.stringify(signed)}\n`); // §3.3(1)/(3)：应答后服务端收尾
        socket.resume(); // 一请求一连接：首行之后的字节一律排空丢弃
      } catch {
        // canonicalization 失败 / emission cap（§6.4(4)）→ internal_error null-bound。
        refuseParsed(socket, "internal_error", false, { peerPid: verifiedPid, instanceId: mapped.instanceId, seq, op: opValue });
      }
    } catch {
      // 兜底（§6.3 internal_error）：未预期的 host 侧失败 —— 无细节外泄。
      try {
        socket.end(signedNullBoundRefusal("internal_error", false));
        socket.resume();
      } catch {
        socket.destroy();
      }
    } finally {
      // ADR-6：live count 无条件释放（含一切提前 return/异常路径）。
      clearTimeout(idleTimer);
      liveConnections -= 1;
      liveSockets.delete(socket);
    }
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      shuttingDown = true;
      audit("shutdown");
      // 停止接纳 + 先摘路径：新连接从此解析不到端点（§3.4/§10.3 —— stale endpoint 不可达）。
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
      try {
        fs.unlinkSync(endpointPath);
      } catch {
        /* ENOENT：本就不在 */
      }
      // ADR-6：live 连接归零或宽限兜底（250ms 默认）—— 卡死连接不阻塞关闭。
      const startedAt = Date.now();
      while (liveConnections > 0 && Date.now() - startedAt < closeGraceMs) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (const socket of liveSockets) {
        socket.destroy();
      }
      // finally 语义：socket 文件 + per-boot 目录无条件清理（§3.1(3)：目录随 listener 消亡）。
      try {
        fs.unlinkSync(endpointPath);
      } catch {
        /* ENOENT */
      }
      try {
        fs.rmSync(endpointDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不阻断 close 幂等完成 */
      }
    })();
    return closePromise;
  }

  const handle: PayswapBrokerHandle = {
    mode,
    degradedReason,
    endpointPath,
    probe,
    get liveConnectionCount() {
      return liveConnections;
    },
    registerInstance(entry) {
      // append-only 纪律（§10.1）：live 同 id 的重复注册被忽略（re-spawn 必须是新
      // instanceId）；注册表是 liveness/墓碑权威，spawn 表只做 pid → 实例路由。
      const existing = registry.lookup(entry.instanceId);
      if (existing !== undefined) {
        return;
      }
      registry.register(entry);
      spawnTable.set(entry.childPid, {
        instanceId: entry.instanceId,
        token: entry.token,
        childPid: entry.childPid,
      });
    },
    get closed() {
      return closePromise !== null;
    },
    close,
  };
  return { handle, listening };
}
