/**
 * PaySwap broker 宿主接线（契约 w2-01 §4.1/§4.2、§7.3、§10.1/§10.2(2)；Step 4 落地）。
 *
 * 协调器（coordinator）是 host 侧集成层 —— broker 运行时的宿主接线半边（读插件注册
 * 表/config/进程观察，layer app；经本模块公开入口 index.ts 导出，bootstrap 各接线面
 * 消费）：
 *
 * - **lazy boot（§3.4）**：首次出现受信官方 PaySwap server 配置时才 boot broker
 *   （每 host 进程一次）；插件禁用（默认 S0b）→ 无受信名 → 不 boot、不注入 —— 子进程
 *   走 Wave 1 fail-closed 无凭据路径。
 * - **per-(server, workspace) 稳定铸造（§4.1）**：同一 live 实例重复注入**同一** tuple ——
 *   连接池按 stableStringify(config) 复用条目（adapters/src/mcp/pool.ts connectionKey），
 *   tuple 抖动会碎片化 pool 并重复 spawn；实例消亡（exit/disable tombstone）后下一次
 *   prepare 铸全新 instanceId（append-only，§10.1）。
 * - **进程观察（§5.2/§10.1/§10.2(1)）**：adapters 层的 stdioProcessObserver 把
 *   (serverName, config, pid) 报上来 —— tuple 从 **config.env** 读回（本协调器铸造的，
 *   host 内存对象，非子进程声明）；铸造记录外的 foreign tuple 一律不注册（fail-closed）。
 *   onStarted → 注册（spawn 表 + 注册表同批）；onClosed → tombstone("exit") + 铸造失效。
 * - **disable 撤销（§10.2(2)）**：revokeForDisable → 注册表 revokePluginInstances
 *   （reason "disabled"）→ 残留调用按 §7.3 row 1 答 financial_mode_disabled（D5.6）。
 * - **boot 失败降级（fail-safe）**：boot 抛错 → onWiringError 上报 + 原样返回未注入的
 *   servers（不注入半组；子进程无凭据 → Wave 1 fail-closed 拒绝路径，§4.4(1)）。
 * - **live 状态 reader（§7.3）**：缺省 reader 每次请求现读合并 config（enabled map +
 *   financialWorkspace opt-in，非子进程 env 快照 —— T2/T3 live-flip 的基础）。
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { McpServerConfig } from "@zcode/contracts";
import { createConfig } from "@zcode/adapters/config";
import {
  createPayswapInstanceRegistry,
  exportPublicKeyBase64,
  mintBrokerBootState,
  PAYSWAP_OFFICIAL_PLUGIN_ID,
  readPayswapBrokerCredentialTupleFromEnv,
  readPayswapFinancialModeFromConfig,
  type PayswapBrokerBootState,
  type PayswapBrokerCredentialTuple,
  type PayswapInstanceRegistry,
} from "@zcode/shared/payswap";
import {
  injectPayswapBrokerMcpServers,
  resolveTrustedOfficialPayswapServerNames,
} from "../mcp-config.js";
import type { PayswapLiveStateReader } from "./dispatch.js";
import type {
  PayswapEntityWorkspaceResolver,
  PayswapSessionScopeResolver,
} from "./session-scope.js";
import {
  bootPayswapBroker,
  type PayswapBrokerBootOptions,
} from "./boot.js";
import type {
  PayswapBrokerAuditEvent,
  PayswapBrokerHandle,
} from "./server.js";

export interface PayswapBrokerCoordinatorOptions {
  /** env 与工作目录（缺省 reader 的 fresh config 读所需；CUA browser-broker 同款注入）。 */
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  /** 实例注册表（缺省 = 协调器自有；协议进程可注入共享实例）。 */
  registry?: PayswapInstanceRegistry;
  /**
   * 预铸造 boot 状态（缺省 = lazy boot 时自铸；测试/集成注入以持有钥对 —— 与 boot 缝
   * 同款纪律，Step 7 链套件的私钥扫描/跨 boot 行需要）。注入时五键组与 broker 签名
   * 同源（hostId/verifyKey 来自同一 bootState）。
   */
  bootState?: PayswapBrokerBootState;
  /** §7.3 live 状态 reader（缺省 = fresh config 读，见 readPayswapLiveStateFromConfig）。 */
  liveStateReader?: PayswapLiveStateReader;
  /**
   * §8.1 会话 resolver（Step 5，ADR-8 D8.6）：构造时初值（app 面在此一次性绑定）；
   * 协议宿主面用 bindSessionScopeResolver 延迟绑定（server 构造晚于协调器）。未绑定
   * → fail-closed（server.ts §8.1 缺省臂）。
   */
  sessionScopeResolver?: PayswapSessionScopeResolver;
  /** §8.3 实体工作区 resolver（Wave 2 生产不接线 —— 无实体存储，§13；测试/P2 用）。 */
  entityWorkspaceResolver?: PayswapEntityWorkspaceResolver;
  /** §11 审计 ingress sink（透传给 broker boot）。 */
  auditSink?: (event: PayswapBrokerAuditEvent) => void;
  /** boot 接缝（测试注入失败臂）。 */
  boot?: (options: PayswapBrokerBootOptions) => Promise<PayswapBrokerHandle>;
  /** 接线故障上报（boot 失败等；fail-safe 降级不抛出）。 */
  onWiringError?: (error: unknown) => void;
}

export interface PayswapBrokerProcessObserver {
  /** stdio 子进程连接成功（pid 已知）：adapters 层调用，形状保持 payswap 无关。 */
  onStarted(serverName: string, config: McpServerConfig, pid: number): void;
  /** stdio 子进程连接关闭（意外断连或主动关闭）。 */
  onClosed(serverName: string, config: McpServerConfig, pid: number): void;
}

export interface PayswapBrokerCoordinator {
  /** broker handle（未 boot 前 null；boot 失败恒 null —— fail-safe 降级）。 */
  readonly handle: PayswapBrokerHandle | null;
  /** adapters 层接线用的进程观察者（透传给 CreateMcpAdapterOptions.stdioProcessObserver）。 */
  readonly processObserver: PayswapBrokerProcessObserver;
  /**
   * 受信注入（§4.2）：向受信官方 PaySwap server 配置注入五键组（per-(server, workspace)
   * 稳定）；无受信名 / boot 失败 → 原样返回（不 boot / 不注入）。
   */
  injectBrokerCredentials(
    servers: Record<string, McpServerConfig>,
    pluginServers: Record<string, McpServerConfig>,
    scope: { workspaceKey: string },
  ): Promise<Record<string, McpServerConfig>>;
  /**
   * §8.1 会话 resolver 延迟绑定（Step 5，ADR-8 D8.6）：协议宿主面的 server 构造晚于
   * 协调器 —— boot 选项携带读槽位 facade，解析发生在**每次请求**，绑定晚于 boot 也生效
   * （非 boot 快照）。重复绑定以最后一次为准；close 后忽略。
   */
  bindSessionScopeResolver(resolver: PayswapSessionScopeResolver): void;
  /** §10.2(2) disable/uninstall 撤销：tombstone 全部 live 实例（reason "disabled"）。 */
  revokeForDisable(): string[];
  /** 关闭（幂等；进程级协调器随宿主关闭）。 */
  close(): Promise<void>;
}

/** 铸造记录：instanceId → 元数据（观察者据此注册；config.env 的 tuple 是路由键）。 */
interface MintRecord {
  serverName: string;
  workspaceKey: string;
  tuple: PayswapBrokerCredentialTuple;
}

export function createPayswapBrokerCoordinator(
  options: PayswapBrokerCoordinatorOptions = {},
): PayswapBrokerCoordinator {
  const registry = options.registry ?? createPayswapInstanceRegistry();
  const boot = options.boot ?? bootPayswapBroker;
  const liveStateReader: PayswapLiveStateReader =
    options.liveStateReader ??
    (() => readPayswapLiveStateFromConfig(createConfig({ env: options.env, workingDirectory: options.workingDirectory }).config));
  // §8.1 会话 resolver 的可变槽位（ADR-8 D8.6）：boot 选项携带 facade（每次请求现读槽位），
  // 构造初值与延迟绑定（bindSessionScopeResolver）共用同一槽位 —— 绑定晚于 lazy boot
  // 也生效；未绑定 = null → fail-closed（server.ts 缺省臂）。
  const sessionScope: { resolver: PayswapSessionScopeResolver | null } = {
    resolver: options.sessionScopeResolver ?? null,
  };
  const sessionScopeFacade: PayswapSessionScopeResolver = (hint) =>
    sessionScope.resolver === null ? null : sessionScope.resolver(hint);

  let bootState: PayswapBrokerBootState | null = null;
  let handle: PayswapBrokerHandle | null = null;
  let bootPromise: Promise<PayswapBrokerHandle> | null = null;
  let closed = false;
  /** instanceId → mint（live 期间的稳定铸造）。 */
  const minted = new Map<string, MintRecord>();
  /** `${serverName}\0${workspaceKey}` → instanceId（prepare 时的 tuple 复用路由）。 */
  const mintByScope = new Map<string, string>();

  function ensureBooted(): Promise<PayswapBrokerHandle> {
    bootPromise ??= (async () => {
      const state = options.bootState ?? mintBrokerBootState();
      const broker = await boot({
        bootState: state,
        registry,
        liveStateReader,
        sessionScopeResolver: sessionScopeFacade,
        ...(options.entityWorkspaceResolver !== undefined
          ? { entityWorkspaceResolver: options.entityWorkspaceResolver }
          : {}),
        ...(options.auditSink ? { auditSink: options.auditSink } : {}),
      });
      bootState = state;
      handle = broker;
      return broker;
    })();
    return bootPromise;
  }

  /** per-(server, workspace) 的 get-or-mint；实例非 live（tombstone/未知）→ 铸新。 */
  function tupleFor(serverName: string, workspaceKey: string): PayswapBrokerCredentialTuple | null {
    if (bootState === null || handle === null) return null;
    const scopeKey = `${serverName} ${workspaceKey}`;
    const existingId = mintByScope.get(scopeKey);
    if (existingId !== undefined) {
      const record = minted.get(existingId);
      const lookup = registry.lookup(existingId);
      // 复用条件：铸造记录在 + 注册表未判死（pending（尚未观察到 spawn）或 live 均可）。
      // tombstone（onClosed/revoke 已删铸造；外部直改注册表的 belt）→ 全新 instanceId（§10.1）。
      if (record !== undefined && (lookup === undefined || lookup.status === "live")) {
        return record.tuple;
      }
      mintByScope.delete(scopeKey);
      minted.delete(existingId);
    }
    const tuple: PayswapBrokerCredentialTuple = {
      socket: handle.endpointPath,
      token: randomBytes(32).toString("hex"),
      instanceId: randomUUID(),
      hostId: bootState.hostId,
      verifyKeyBase64: exportPublicKeyBase64(bootState.keyPair.publicKey),
    };
    minted.set(tuple.instanceId, { serverName, workspaceKey, tuple });
    mintByScope.set(scopeKey, tuple.instanceId);
    return tuple;
  }

  function instanceIdFromConfig(config: McpServerConfig): string | null {
    const env = (config as { env?: Record<string, string | undefined> }).env;
    if (!env) return null;
    const tuple = readPayswapBrokerCredentialTupleFromEnv(env);
    return tuple?.instanceId ?? null;
  }

  const processObserver: PayswapBrokerProcessObserver = {
    onStarted(serverName, config, pid) {
      const instanceId = instanceIdFromConfig(config);
      if (instanceId === null) return; // 无 PaySwap 凭据的 server（含冒名）—— 与本协调器无关。
      const record = minted.get(instanceId);
      if (record === undefined) {
        // 非本协调器铸造（foreign/stale tuple）—— 不注册，fail-closed（§5.5 步 (1) 会拒）。
        return;
      }
      handle?.registerInstance({
        instanceId,
        token: record.tuple.token,
        childPid: pid,
        pluginRegistrationIdentity: PAYSWAP_OFFICIAL_PLUGIN_ID,
        workspace: record.workspaceKey,
        // §8.2（Step 5 落地）：sessionScope = 实例可解析 scope。Wave 2 本地桌面模型里
        // = 工作区键（该工作区的全部会话可解析；sessionId hint 只能收窄到其中之一）。
        // Wave 3 服务端 operator-principal 可将其收窄到工作区之下，判定在 server.ts
        // §8（isSessionWithinBindingScope —— 只认 sessionScope 字段）。
        sessionScope: record.workspaceKey,
        spawnedAt: Date.now(),
      });
      void serverName;
    },
    onClosed(_serverName, config, _pid) {
      const instanceId = instanceIdFromConfig(config);
      if (instanceId === null) return;
      if (!minted.has(instanceId)) return;
      // §10.2(1)：子进程退出 → tombstone("exit")；铸造失效 → 下次 prepare 铸全新实例。
      registry.tombstone(instanceId, "exit");
      minted.delete(instanceId);
      for (const [scopeKey, id] of mintByScope) {
        if (id === instanceId) mintByScope.delete(scopeKey);
      }
    },
  };

  return {
    get handle() {
      return handle;
    },
    processObserver,
    bindSessionScopeResolver(resolver) {
      // close 后忽略（进程生命周期已终）；未 close 时槽位替换即时生效（facade 现读）。
      if (!closed) {
        sessionScope.resolver = resolver;
      }
    },
    async injectBrokerCredentials(servers, pluginServers, scope) {
      if (closed) return servers;
      const trustedNames = resolveTrustedOfficialPayswapServerNames(servers, pluginServers);
      if (trustedNames.size === 0) {
        return servers; // 插件禁用/未装 → 无受信名 → 不 boot、不注入（§4.2 fail-closed 门）。
      }
      try {
        await ensureBooted();
      } catch (error) {
        // fail-safe 降级：不注入（子进程走 Wave 1 无凭据拒绝路径），接线故障上报。
        options.onWiringError?.(error);
        return servers;
      }
      let injected = servers;
      for (const name of trustedNames) {
        const tuple = tupleFor(name, scope.workspaceKey);
        if (tuple === null) continue;
        injected = injectPayswapBrokerMcpServers(injected, tuple, new Set([name]));
      }
      return injected;
    },
    revokeForDisable() {
      // §10.2(2)：撤销全部 live 实例；铸造全部失效（禁用后无受信名，不会再注入）。
      const revoked = registry.revokePluginInstances(PAYSWAP_OFFICIAL_PLUGIN_ID);
      minted.clear();
      mintByScope.clear();
      return revoked;
    },
    async close() {
      closed = true;
      minted.clear();
      mintByScope.clear();
      if (handle !== null) {
        await handle.close();
      }
    },
  };
}

/** 合并 config 形状的最小投影（fresh read 的输出侧）。 */
interface PayswapLiveConfigShape {
  plugins?: {
    enabledPlugins?: Record<string, boolean>;
    options?: Record<string, Record<string, unknown>>;
  };
}

/**
 * app 面的 §8.1 单会话 resolver（Step 5，ADR-8 D8.6）：独立 app（createZCodeApp 自有
 * 协调器）恰有一个会话 —— 本 app 的 sessionId；hint 与其相等即解析进 app 的工作区，
 * 其它 hint 一律 null（fail-closed）。协议宿主面不用本工厂（server 构造后经
 * bindSessionScopeResolver 绑 requireSession 模式的多会话 resolver）。
 */
export function createSingleSessionScopeResolver(
  sessionId: string,
  workspaceKey: string,
): PayswapSessionScopeResolver {
  return (hint) => (hint === sessionId ? { workspaceKey } : null);
}

/**
 * §7.3 live 状态的纯读：委托 shared 的单一投影（readPayswapFinancialModeFromConfig
 * —— P1.8 起 Gate E1 的 hook 准入门与 broker live reader 共用同一实现，两处投影
 * 永不漂移）。其它插件的配置永不串扰（投影只读官方 PaySwap 插件两键）。
 */
export function readPayswapLiveStateFromConfig(
  config: PayswapLiveConfigShape,
): { pluginEnabled: boolean; financialWorkspace: boolean } {
  return readPayswapFinancialModeFromConfig(config.plugins ?? {});
}
