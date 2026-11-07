/**
 * PaySwap server 侧 operator 存储（addendum §1.6.3 —— server 部署的状态 owner；
 * ADR-11）。
 *
 * 职责（法则实现住 shared-payswap —— 单一实现纪律；本模块是 server 侧的组装与
 * 生命周期 owner）：
 * - 持久化：operator/凭据 digest/角色绑定经上游 private-persistence 纪律落盘
 *   （0600 + 原子 rename —— atomicWritePrivateTextFile）；损坏/不可读 → typed
 *   加载失败（fail-closed：financial 激活拒绝，绝不静默清空 operator 表）。
 *   sessions/challenges 是内存态（重启即失效 —— 期望语义）。
 * - 两级握手的 level-2 评估：经 shared 法则 evaluatePayswapOperatorUpgrade
 *   （header 优先于 cookie；两者同呈时以 header 为准、失败不回退 —— 无凭据选购）。
 * - rotation 窗口收尾：每次升级评估前 sweep（关闭过窗 record 铸的 session 的
 *   连接、失效其 challenges）—— 无定时器的主动收尾。
 * - 撤销的连接关闭：revokeOperatorCredential/revokeOperator 级联结果驱动
 *   server 侧 socket 关闭（1008）。
 * - operator-session cookie 铸造：HttpOnly + SameSite=Strict + Path=/ws +
 *   Max-Age=会话生命周期（§1.6.3 item 7 的浏览器传输）。
 */

import { readFileSync } from "node:fs";
import {
  atomicWritePrivateTextFile,
} from "@zcode/shared/node";
import {
  createPayswapOperatorRegistry,
  evaluatePayswapOperatorUpgrade,
  PAYSWAP_OPERATOR_SESSION_COOKIE_NAME,
  type PayswapChallengeIssueInput,
  type PayswapChallengeResolutionInput,
  type PayswapChallengeResolutionVerdict,
  type PayswapCredentialVerdict,
  type PayswapIssuedChallenge,
  type PayswapOperatorRegistry,
  type PayswapOperatorRegistryOptions,
  type PayswapOperatorUpgradeVerdict,
  type PayswapProvisionOperatorInput,
  type PayswapProvisionedOperator,
  type PayswapRevocationResult,
  type PayswapRotatedCredential,
} from "@zcode/shared/payswap";

/** 可关闭的服务端 socket 最小面（ws.WebSocket 满足；测试可用 stub）。 */
export interface PayswapClosableSocket {
  close(code?: number, reason?: string): void;
  once(event: "close", listener: () => void): unknown;
}

export interface PayswapOperatorStoreOptions extends PayswapOperatorRegistryOptions {
  /**
   * 持久化状态文件路径；缺省 = 纯内存（测试/无持久化部署）。加载失败（存在但损坏/
   * 不可读）→ 构造抛 typed 错误（fail-closed）。ENOENT = 空注册表（新部署）。
   */
  stateFilePath?: string;
}

export interface PayswapOperatorSessionCookieMint {
  sessionId: string;
  operatorId: string;
  setCookie: string;
}

export interface PayswapOperatorStore {
  provisionOperator(input: PayswapProvisionOperatorInput): Promise<PayswapProvisionedOperator>;
  rotateOperatorCredential(operatorId: string): Promise<PayswapRotatedCredential>;
  revokeOperatorCredential(recordId: string): Promise<PayswapRevocationResult>;
  revokeOperator(operatorId: string): Promise<PayswapRevocationResult>;
  verifyCredential(token: string): PayswapCredentialVerdict;
  /** level-2 升级评估（level-1 = 全局中间件的前置条件，恒 authorized）。 */
  upgradeAuth(input: {
    operatorToken?: string;
    cookieHeader?: string;
  }): PayswapOperatorUpgradeVerdict;
  /** operator-session 端点的 cookie 铸造（凭据无效 → null）。 */
  mintOperatorSessionCookie(token: string): PayswapOperatorSessionCookieMint | null;
  issueOperatorChallenge(input: PayswapChallengeIssueInput): PayswapIssuedChallenge | null;
  resolveOperatorChallenge(input: PayswapChallengeResolutionInput): PayswapChallengeResolutionVerdict;
  /** 内省（测试/运维）：当前 session 记录及其存活态。 */
  activeSessions(): ReadonlyArray<{ sessionId: string; operatorId: string; live: boolean }>;
  /** 升级成功后绑定连接（撤销/过窗收尾时 server 侧关闭）。 */
  bindConnection(sessionId: string, socket: PayswapClosableSocket): void;
}

export const PAYSWAP_OPERATOR_STORE_LOAD_FAILED_CODE = "payswap_operator_registry_load_failed";

function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === PAYSWAP_OPERATOR_SESSION_COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function createPayswapOperatorStore(
  options: PayswapOperatorStoreOptions = {},
): PayswapOperatorStore {
  const stateFilePath = options.stateFilePath;
  let initialStateJson = options.initialStateJson;
  if (stateFilePath !== undefined && initialStateJson === undefined) {
    try {
      initialStateJson = readFileSync(stateFilePath, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") {
        throw new Error(PAYSWAP_OPERATOR_STORE_LOAD_FAILED_CODE, { cause: error });
      }
      initialStateJson = undefined;
    }
  }

  const registry: PayswapOperatorRegistry = createPayswapOperatorRegistry({
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.sessionLifetimeMs !== undefined
      ? { sessionLifetimeMs: options.sessionLifetimeMs }
      : {}),
    ...(options.rotationGraceMs !== undefined ? { rotationGraceMs: options.rotationGraceMs } : {}),
    ...(initialStateJson !== undefined ? { initialStateJson } : {}),
  });

  const sessionLifetimeMs = options.sessionLifetimeMs ?? 15 * 60_000;

  /** session → 已绑定 socket（连接关闭时自清理）。 */
  const connections = new Map<string, Set<PayswapClosableSocket>>();

  function closeSocketsOf(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const sockets = connections.get(sessionId);
      if (!sockets) continue;
      for (const socket of sockets) {
        socket.close(1008, "payswap_operator_revoked");
      }
      connections.delete(sessionId);
    }
  }

  async function persist(): Promise<void> {
    if (stateFilePath === undefined) return;
    await atomicWritePrivateTextFile(stateFilePath, registry.serializeState());
  }

  const store: PayswapOperatorStore = {
    async provisionOperator(input) {
      const provisioned = registry.provisionOperator(input);
      await persist();
      return provisioned;
    },

    async rotateOperatorCredential(operatorId) {
      const rotated = registry.rotateOperatorCredential(operatorId);
      await persist();
      return rotated;
    },

    async revokeOperatorCredential(recordId) {
      const revocation = registry.revokeOperatorCredential(recordId);
      await persist();
      closeSocketsOf(revocation.closedSessions);
      return revocation;
    },

    async revokeOperator(operatorId) {
      const revocation = registry.revokeOperator(operatorId);
      await persist();
      closeSocketsOf(revocation.closedSessions);
      return revocation;
    },

    verifyCredential(token) {
      return registry.verifyCredential(token);
    },

    upgradeAuth({ operatorToken, cookieHeader }) {
      // rotation 窗口收尾搭每次升级评估（无定时器）。
      const swept = registry.sweepRotationWindows();
      closeSocketsOf(swept.closedSessions);
      return evaluatePayswapOperatorUpgrade({
        level1Authorized: true,
        readOperatorCredential: () => {
          if (operatorToken !== undefined) {
            return { kind: "operator_token", token: operatorToken };
          }
          const sessionCookie = parseSessionCookie(cookieHeader);
          if (sessionCookie !== undefined) {
            return { kind: "session_cookie", sessionId: sessionCookie };
          }
          return undefined;
        },
        registry,
      });
    },

    mintOperatorSessionCookie(token) {
      const swept = registry.sweepRotationWindows();
      closeSocketsOf(swept.closedSessions);
      const minted = registry.mintSessionForCredential(token);
      if (minted === null) return null;
      const maxAgeSeconds = Math.floor(sessionLifetimeMs / 1000);
      const setCookie =
        `${PAYSWAP_OPERATOR_SESSION_COOKIE_NAME}=${minted.sessionId}; Path=/ws; ` +
        `HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
      return { sessionId: minted.sessionId, operatorId: minted.operatorId, setCookie };
    },

    issueOperatorChallenge(input) {
      return registry.issueChallenge(input);
    },

    resolveOperatorChallenge(input) {
      return registry.resolveChallenge(input);
    },

    activeSessions() {
      return registry.listSessions();
    },

    bindConnection(sessionId, socket) {
      const verdict = registry.verifySession(sessionId);
      if (verdict.status !== "live") return;
      let sockets = connections.get(sessionId);
      if (!sockets) {
        sockets = new Set();
        connections.set(sessionId, sockets);
      }
      sockets.add(socket);
      socket.once("close", () => {
        sockets!.delete(socket);
        if (sockets!.size === 0) connections.delete(sessionId);
      });
    },
  };

  return store;
}
