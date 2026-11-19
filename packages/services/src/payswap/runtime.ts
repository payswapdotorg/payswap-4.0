/**
 * PaySwap P2.2 —— 账户运行时生产装配（deliverable 06 §2.2「Single writer: the
 * account service」的生产装配半；ADR-P2-1 后续切片）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **单一账户服务实例**：本模块创建**恰一个** `PayswapAccountService`（连接记录
 *    与 PSP 秘密的唯一写者），broker 的两个 reader 面（`accountOverviewReader` =
 *    listConnections、`accountDetailReader` = getOverviewData）绑定到**同一实例**
 *    —— 概览/详图数据与状态机写路径永不出现第二个写者。
 * 2. **凭据通道交付**（Gate E2 §5.2「the `ZCODE_PAYSWAP_PSP_KEY` host-env key
 *    contract as the single source between the desktop writer and the services
 *    reader」）：本模块只消费 env（缺省 process.env）—— safeStorage 解包键由
 *    desktop main 经 hostProcessLocalEnv 交付；env 缺席时装配**照常完成**，拒绝
 *    发生在操作面（connect/load 的 Gate E2 typed 拒绝 —— fail-closed，不猜）。
 * 3. **adapter 装配**：真实 Stripe 读回 adapter + 只读数据 adapter（slice 3/4）
 *    接进账户服务（doc 06 §2.9 provider 运行时；P2 = [stripe]，P3 起 per-provider
 *    追加）。transport 经 `ApiClient`（缺省 = globalThis.fetch + AbortController
 *    超时执行 —— 两 adapter 同款缺省）。
 * 4. **IO 全注入**：env、store 路径、transport、时钟与 ID 铸造全部可注入 ——
 *    法则级测试无网络、无真实 home。缺省值即生产值。
 * 5. **reader 面零转换**：reader 直接返回服务的投影/detail（法则保证无秘密），
 *    本模块永不包装、永不缓存、永不重试（每次调用现读 —— broker dispatch 的
 *    注入面纪律）。
 */

import type { ApiClient } from "@zcode/shared";
import type {
  PayswapAccountOverviewDetail,
  PayswapConnectionStatusProjection,
} from "@zcode/shared/payswap";
import { createCredentialService } from "../credential/credentialService.js";
import {
  CUSTODIAN_SECRET_MARKER,
  createPayswapAccountService,
  type PayswapAccountCredentialPort,
  type PayswapCustodianBridge,
} from "./accounts/accountService.js";
import { createPayswapConnectionRecordStore } from "./accounts/connectionRecordStore.js";
import { createStripeAccountDataReadPort } from "./providers/stripe/readAccountData.js";
import { createStripeAccountReadBackPort } from "./providers/stripe/readBackAccount.js";

export interface PayswapAccountRuntimeDependencies {
  /** host 进程 env（缺省 = process.env；`ZCODE_PAYSWAP_PSP_KEY` 的交付通道）。 */
  env?: NodeJS.ProcessEnv;
  /** 连接记录 store 路径（缺省 = 应用配置目录 + payswap-connections.json）。 */
  resolveStorePath?(): string;
  /** Stripe transport（缺省 = 两 adapter 的真实 fetch + 超时执行缺省）。 */
  apiClient?: ApiClient;
  /** Stripe API 基 URL（缺省 = 生产 https://api.stripe.com）。 */
  stripeApiBase?: string;
  /** ISO 时间源（缺省 = 真实时钟）。 */
  now?(): string;
  /** 连接 ID 铸造（缺省 = shared 法则）。 */
  mintConnectionId?(): string;
  /** ADR-P2-3 custodian 桥（在位 = 密钥只入托管；缺席 = 既有直接路径不变）。 */
  custodianBridge?: PayswapCustodianBridge;
}

/**
 * ADR-P2-3 custodian 桥：桌面 main 注入的 helper 通道（push/get/drop）。在位时
 * accountService 走 custodian 分支 —— 密钥只进 custodian（SYSTEM 服务内存 + 其
 * SYSTEM-DPAPI blob），main 不持明文、不落 enc:v1 槽；Stripe GET 经有界代理。
 * 法则与标记常量住 accountService.js（单一事实源），此处类型转发。
 */
export type { PayswapCustodianBridge } from "./accounts/accountService.js";

export interface PayswapAccountRuntime {
  /** 账户服务（连接/撤销/证据刷新/概览 —— 唯一写者实例）。 */
  readonly accountService: ReturnType<typeof createPayswapAccountService>;
  /** broker 的概览 reader 面（listConnections 的绑定 —— 每次调用现读）。 */
  readonly accountOverviewReader: () => Promise<PayswapConnectionStatusProjection[]>;
  /** broker 的 detail reader 面（getOverviewData 的绑定 —— 每次调用现读）。 */
  readonly accountDetailReader: (connectionId: string) => Promise<PayswapAccountOverviewDetail>;
}

/**
 * 创建账户运行时（生产装配）。单一服务实例 + 两个绑定 reader 面；凭据通道经 env
 * 交付（法则 2）。本模块无 boot 副作用（懒装配 —— store/凭据文件按操作触达）。
 */

/** Authorization 头读取（HeadersInit 三形态；缺省 ""）。 */
function readAuthorizationHeader(init?: RequestInit): string {
  const headers = init?.headers;
  if (headers === undefined) return "";
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get("Authorization") ?? "";
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) {
      if (name.toLowerCase() === "authorization") return value;
    }
    return "";
  }
  const record = headers as Record<string, string>;
  for (const [name, value] of Object.entries(record)) {
    if (name.toLowerCase() === "authorization") return value;
  }
  return "";
}

export function createPayswapAccountRuntime(
  dependencies: PayswapAccountRuntimeDependencies = {},
): PayswapAccountRuntime {
  const env = dependencies.env ?? process.env;
  const credentialPort = createCredentialService({ env });
  const connectionStore = createPayswapConnectionRecordStore({
    resolveStorePath: dependencies.resolveStorePath,
  });
  const custodianBridge = dependencies.custodianBridge;
  // ADR-P2-3 custodian 凭据端口：save = push（connect 时恰一次，密钥入托管）；
  // load = 占位标记（读取经标记路由 transport 转发托管代理）；delete = no-op
  //（托管清除走 revoke 分支的 drop）。在位时 main 全程不持明文、不落 enc:v1 槽。
  const custodianCredentialPort: PayswapAccountCredentialPort = custodianBridge
    ? {
        // 占位密钥带 sk_test_ 前缀：adapter 的 mode 推导（derivePayswapSecretKeyMode）
        // 照常成立（P2 仅 test 模式连接）；真实 Bearer 由 custodian 服务端补。
        load: async () => `sk_test_${CUSTODIAN_SECRET_MARKER}`,
        save: async (_key, value) => {
          await custodianBridge.push(value);
        },
        delete: async () => {},
      }
    : credentialPort;
  // ADR-P2-3：custodian 在位 → apiClient 包装为标记路由 transport —— 携占位
  // Bearer（"custodian-managed"）的 GET 转发托管代理（服务端补真 Bearer + 路径
  // 闭集 + pid 门）；其余 fetch 原样（行为不变）。代理应答以 status/body 重铸
  // Response（两 adapter 只消费 status/json —— 形状契约不变）。
  const apiClient: ApiClient | undefined = custodianBridge
    ? {
        async request(input, requestInit) {
          const url = typeof input === "string" ? input : input.toString();
          const auth = readAuthorizationHeader(requestInit);
          if (!auth.endsWith(CUSTODIAN_SECRET_MARKER)) {
            const fallback = dependencies.apiClient ?? { request: (i, r) => fetch(i, r) };
            return fallback.request(input, requestInit);
          }
          const parsed = new URL(url);
          const reply = await custodianBridge.get(parsed.pathname + parsed.search);
          return new Response(reply.body, {
            status: reply.status === 0 ? 502 : reply.status,
          });
        },
      }
    : dependencies.apiClient;
  const readBackAccount = createStripeAccountReadBackPort({
    apiClient,
    accountUrl: dependencies.stripeApiBase
      ? `${dependencies.stripeApiBase.replace(/\/+$/, "")}/v1/account`
      : undefined,
  });
  const readAccountData = createStripeAccountDataReadPort({
    apiClient,
    apiBase: dependencies.stripeApiBase,
  });
  const accountService = createPayswapAccountService({
    credentialPort: custodianCredentialPort,
    connectionStore,
    readBackAccount,
    readAccountData,
    now: dependencies.now,
    mintConnectionId: dependencies.mintConnectionId,
  });
  return {
    accountService,
    accountOverviewReader: () => accountService.listConnections(),
    accountDetailReader: (connectionId: string) => accountService.getOverviewData({ connectionId }),
  };
}
