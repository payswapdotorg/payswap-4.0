/**
 * PaySwap P2.2 —— PSP 账户服务（deliverable 06 §2.2「PSP account & credential
 * management」；deliverable 05 §5 认证面的 host-service 半）。
 *
 * 职责与不变量（违反即实现缺陷）：
 * 1. **单一写者**（doc 06 §2.2「Single writer: the account service」）：连接记录
 *    与 PSP 秘密的写路径只经本服务；UI 经 hooks/投影读，adapter 在 host 进程内
 *    读秘密 —— 二者都不是写者。
 * 2. **秘密只落 ICredentialService**：`payswap:psp:<providerId>:<connectionId>:
 *    <secretKind>` 键（Gate E2 键级政策：safeStorage 键/secret 派生通道，否则
 *    fail-closed typed 拒绝）。本服务永不缓存、永不日志、永不投影秘密。
 * 3. **拒绝先于记录**（connect）：凭据 store 拒绝（fail-closed）→ 不写任何连接
 *    记录（「refusals thrown before any disk access」的账户服务投影）；记录写
 *    失败 → 尽力删除已存秘密（不留孤儿 PSP 密文）后上抛。
 * 4. **先标 revoked 再删秘密**（revoke，delete-local-only）：任何中间态都绝不
 *    留下失真的 connected；删秘密失败时记录已是 revoked（幂等重撤销补清残留）。
 * 5. **投影面**（listConnections/connect/revoke/refreshEvidence 的返回）：只有
 *    shared 法则的状态投影（五字段）—— 渲染层/模型侧在类型面上拿不到秘密。
 * 6. **格式检查是防御性的**：formatCheck 通过 ≠ 凭据有效；最终权威是 provider
 *    read-back —— refreshEvidence 经注入的读回端口验证凭据：`verified` 把
 *    `expired` 翻回 `connected`（恢复行）；`auth-failed` 把 `connected` 翻
 *    `expired`（**唯一的 expiry 证据是 provider 的拒绝**）；`unavailable` /
 *    传输异常 / 畸形结局 = typed `read_back_unavailable` 拒绝，状态不变
 *    （unknown ≠ expired，doc 05 §6.4）。`revoked` 终态：不触端口、不读秘密。
 *    **状态变更才写记录**（无变更不写）。秘密缺失（记录 connected 而键不在）
 *    = 本地不一致行：typed 拒绝、状态不变（无 provider 证据不翻状态）。
 *
 * 时间与随机性全注入（now/mintConnectionId）—— 法则级测试确定性。IO 依赖经
 * credentialPort（LocalCredentialService 的面）、connectionStore 与读回端口
 * （readBackAccount）注入。
 */

import {
  derivePayswapSecretKeyMode,
  isPayswapPspSecureStorageUnavailableError,
  mintPayswapConnectionId,
  PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE,
  payswapAccountReadBackOutcomeSchema,
  payswapConnectionRecordSchema,
  payswapPspSecretCredentialKey,
  payswapReadonlyCategoryResultSchemas,
  PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE,
  PAYSWAP_READONLY_CATEGORIES,
  PAYSWAP_STRIPE_AUTH_SPEC,
  projectPayswapConnectionStatus,
  createPayswapCustodianUnavailableError,
  isPayswapClientCredentialsAuthSpec,
  isPayswapCustodianUnavailableError,
  type PayswapAccountDataReadPort,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
  type PayswapAccountRefusal,
  type PayswapClientCredentialsAuthSpec,
  type PayswapAccountOverviewDetail,
  type PayswapReadonlyCategoryResult,
  type PayswapAuthSpec,
  type PayswapConnectResult,
  type PayswapConnectionRecord,
  type PayswapPspSecretKind,
  type PayswapConnectionStatusProjection,
  type PayswapRefreshResult,
  type PayswapRevokeResult,
} from "@zcode/shared/payswap";
import type { PayswapConnectionRecordStore } from "./connectionRecordStore.js";
import { createPayswapClientCredentialsConnect } from "./clientCredentialsConnect.js";

/** 凭据端口的 narrowed 面（LocalCredentialService 满足；测试可替身）。 */
export interface PayswapAccountCredentialPort {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * ADR-P2-3 custodian 桥（可选注入）：在位时密钥只入托管（SYSTEM 服务内存 + 其
 * SYSTEM-DPAPI blob），main 不持明文、不落 enc:v1 槽。语义：
 *   - push = credentialPort.save 的托管形态（connect 时恰一次，槽 = 凭据存储键）；
 *   - load = 占位标记（"custodian-managed" + 槽后缀）—— 读取经 apiClient 标记
 *     路由进托管有界代理（服务端按槽补真 Bearer）；
 *   - drop = revoke 时按记录声明的秘密种类逐槽清托管（内存 + blob 全删）。
 * v1.1 命名槽：slot = 凭据存储键（provider + 随机连接 id + 种类 —— 非秘密）；
 * slot 缺省（undefined）= 旧版单槽（wire 行为逐字不变 —— 既有电池/还原面全绿）。
 */
export interface PayswapCustodianBridge {
  push(key: string, slot?: string): Promise<void>;
  /** v1.2：host 可选（缺省 api.stripe.com —— 旧 wire 逐字不变）；per-host 路径
   *  闭集在服务端强制（PayStack = /balance|/transaction|/customer|/dispute）。 */
  get(path: string, slot?: string, host?: string): Promise<{ status: number; body: string }>;
  /** v1.2 PayPal token 交换代理：URL 闭集在服务端强制（恰两枚官方 token URL）；
   *  Basic 凭据从两个命名槽现读 —— 明文绝不经桌面。应答 {status, body}。
   *  body = 非秘密 form 体（grant_type=client_credentials —— 有界透传）。 */
  post(url: string, userSlot: string, passSlot: string, body: string): Promise<{ status: number; body: string }>;
  drop(slot?: string): Promise<void>;
}

export const CUSTODIAN_SECRET_MARKER = "custodian-managed";

/** 再导出（custodian typed 错误属于账户服务词汇面 —— desktop 桥/runtime 共用）。 */
export { createPayswapCustodianUnavailableError };

/**
 * ADR-P2-3 fail-closed 凭据端口（custodian-required 且托管缺席）：load/save 一律
 * typed 拒绝（`custodian_unavailable`）—— 结构与行为双保证：本端口没有任何
 * legacy 存储依赖，不存在可写的 enc:v1 槽。delete 例外地转发 legacy 删除
 *（调用方注入 deleteOnlyDelete —— 只删不写的单向破坏操作）：撤销必须永远可用
 *（法则 4），并顺手清理策略切换前残留的 legacy 键；它不可能引入写入回退。
 */
export function createCustodianRequiredRefusingCredentialPort(options: {
  /** legacy 凭据服务的 delete 面（仅撤销清理；load/save 永不触达）。 */
  deleteOnlyDelete(key: string): Promise<void>;
}): PayswapAccountCredentialPort {
  const refuse = (): never => {
    throw createPayswapCustodianUnavailableError(
      "The PaySwap credential custodian is required on this platform but is not available " +
        "(not installed, not running, or registration was refused). No legacy credential " +
        "storage is used; set up the custodian service or reconnect to proceed.",
    );
  };
  return {
    load: async () => refuse(),
    save: async () => refuse(),
    delete: (key) => options.deleteOnlyDelete(key),
  };
}

export interface PayswapAccountServiceDependencies {
  /** 凭据 store 端口（真实装配 = LocalCredentialService；PSP 键级政策在彼处）。 */
  credentialPort: PayswapAccountCredentialPort;
  /** ADR-P2-3 custodian 桥（缺席 = 既有直接路径不变）。 */
  custodianBridge?: PayswapCustodianBridge;
  /** 连接记录 store（非秘密元数据；本模块是唯一写者）。 */
  connectionStore: PayswapConnectionRecordStore;
  /** 注册的 provider 认证规格（缺省 = [Stripe]；P3 起 per-provider 追加）。 */
  authSpecs?: readonly PayswapAuthSpec[];
  /**
   * provider 读回端口（host 进程内；真实 Stripe 实现随 provider 运行时切片）。
   * 缺席 = refreshEvidence fail-closed typed 拒绝（无 adapter 即无读回，不猜）。
   */
  readBackAccount?: PayswapAccountReadBackPort;
  /**
   * 只读数据端口（ADR-P2-1；真实 Stripe 实现随 provider 运行时切片）。缺席 =
   * getOverviewData 的四类别一律 unavailable（fail-closed，不猜 —— 概览仍回答
   * 连接投影与能力证据，数据面诚实缺席）。
   */
  readAccountData?: PayswapAccountDataReadPort;
  /** ISO 时间源（缺省 = 真实时钟；测试注入确定性）。 */
  now?(): string;
  /** 连接 ID 铸造（缺省 = shared 法则 mintPayswapConnectionId）。 */
  mintConnectionId?(): string;
}

export interface PayswapAccountService {
  /**
   * 连接一个账户（typed refusal 语义见文件头）。operator-supplied-secret 流 =
   * operatorSecret（前缀区分模式）；P3 client-credentials 流（client-credentials
   * 规格）= operatorSecret 携带 client secret + clientId 必填 + mode 显式声明
   * （sandbox/live 凭据不编码环境 —— 不猜）。
   */
  connect(input: {
    providerId: string;
    operatorSecret: string;
    clientId?: string;
    mode?: "test" | "live";
    displayName?: string;
  }): Promise<PayswapConnectResult>;
  /** 撤销连接（delete-local-only；幂等，补清残留秘密）。 */
  revoke(input: { connectionId: string }): Promise<PayswapRevokeResult>;
  /** provider read-back 证据刷新（doc 06 §2.2；状态机语义见文件头）。 */
  refreshEvidence(input: { connectionId: string }): Promise<PayswapRefreshResult>;
  /** 全部连接的状态投影（无秘密）。 */
  listConnections(): Promise<PayswapConnectionStatusProjection[]>;
  /**
   * ADR-P2-1 只读对话面：验证读（refreshEvidence 同一状态机）+ 能力证据 +
   * 四类别只读数据（全部现读；法则与结局词汇见 account-data.ts）。
   */
  getOverviewData(input: { connectionId: string }): Promise<PayswapAccountOverviewDetail>;
}

function refused(code: PayswapAccountRefusal["code"], message: string): {
  kind: "refused";
  refusal: PayswapAccountRefusal;
} {
  return { kind: "refused", refusal: { code, message } };
}

function defaultDisplayName(providerId: string, mode: "test" | "live"): string {
  return `${providerId} (${mode})`;
}

export function createPayswapAccountService(
  dependencies: PayswapAccountServiceDependencies,
): PayswapAccountService {
  const credentialPort = dependencies.credentialPort;
  const custodianBridge = dependencies.custodianBridge;
  const connectionStore = dependencies.connectionStore;
  const authSpecs = dependencies.authSpecs ?? [PAYSWAP_STRIPE_AUTH_SPEC];
  const readBackAccount = dependencies.readBackAccount;
  const readAccountData = dependencies.readAccountData;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const mintConnectionId = dependencies.mintConnectionId ?? mintPayswapConnectionId;

  /** 删除该连接的全部已存秘密（delete 对任意键可用 —— Gate E2 法则）。 */
  async function deleteSecrets(record: PayswapConnectionRecord): Promise<void> {
    for (const secretKind of record.secretKinds) {
      await credentialPort.delete(
        payswapPspSecretCredentialKey(record.providerId, record.connectionId, secretKind),
      );
    }
  }

  /**
   * ADR-P2-3 revoke 臂：清托管（内存 + blob 全删）。托管清除失败（blob 删除不可
   * 证实）= typed `custodian_unavailable` 拒绝 —— 记录已是 revoked（法则 4 先于
   * 清除），但绝不把「保管未证实清除」伪装成成功撤销（A3.6：撤销必须证实）。
   */
  async function dropCustodyOrRefuse(record: PayswapConnectionRecord): Promise<
    { kind: "refused"; refusal: PayswapAccountRefusal } | undefined
  > {
    if (custodianBridge === undefined) return undefined;
    try {
      // v1.1：按记录声明的秘密种类逐一清命名槽（槽名 = 各自的凭据存储键）。
      // 绝不 drop 旧版单槽 —— 那可能属于其它（升级前）连接的保管。
      for (const secretKind of record.secretKinds) {
        await custodianBridge.drop(
          payswapPspSecretCredentialKey(record.providerId, record.connectionId, secretKind),
        );
      }
    } catch (error) {
      if (isPayswapCustodianUnavailableError(error)) {
        return refused(
          PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE,
          "The connection record is revoked, but the credential custodian could not be " +
            "cleared (" +
            error.message +
            "); retry revoke until the custody drop is confirmed.",
        );
      }
      throw error;
    }
    return undefined;
  }

    // P3 client-credentials 连接流（PayPal 首落地）—— 独立模块（架构上限内的
  // 单一职责抽出）：凭据对存储 + operator-declared 模式（v1.1 命名槽下凭据对可入托管）。
  const connectWithClientCredentials = createPayswapClientCredentialsConnect({
    credentialPort,
    connectionStore,
    now,
    mintConnectionId,
  });

  return {
    async connect(input) {
      const spec = authSpecs.find((entry) => entry.providerId === input.providerId);
      if (spec === undefined) {
        return refused(
          "unsupported_provider",
          `No PaySwap provider contract is registered for '${input.providerId}'.`,
        );
      }
      // P3 client-credentials 形态（PayPal 首落地）：凭据对 + operator-declared
      // 模式。operator-supplied-secret 流在其分支之后，行为逐字不变。
      if (isPayswapClientCredentialsAuthSpec(spec)) {
        return connectWithClientCredentials(spec, input);
      }
      const secret = input.operatorSecret.trim();
      if (!secret || !spec.acquisition.formatCheck.test(secret)) {
        return refused(
          "validation_failed",
          `The supplied secret does not match the expected ${spec.providerId} key format.`,
        );
      }
      const mode = derivePayswapSecretKeyMode(secret, spec);
      if (mode === null) {
        // 皮带扣：formatCheck 通过但无模式前缀（规格自相矛盾时 fail-closed，不猜）。
        return refused(
          "validation_failed",
          `The supplied ${spec.providerId} key does not carry a recognizable test/live prefix.`,
        );
      }
      // P3：operator-declared 模式与 key-prefix 推导并存时必须一致（不猜、不静默）。
      if (input.mode !== undefined && input.mode !== mode) {
        return refused(
          "validation_failed",
          `The declared '${input.mode}' mode does not match the ${spec.providerId} key's prefix-derived mode ('${mode}'); connect without the declared mode or use the matching environment's key.`,
        );
      }
      const connectionId = mintConnectionId();
      // P2 的 operator-supplied-secret 流恰好一种秘密。规格未声明任何
      // 秘密种类 = 注册表配置缺陷 → fail-closed 拒绝（不猜）。
      const secretKind = spec.secretKinds[0];
      if (secretKind === undefined) {
        return refused(
          "unsupported_provider",
          `The ${spec.providerId} contract declares no secret kinds; refusing to connect.`,
        );
      }
      const storageKey = payswapPspSecretCredentialKey(spec.providerId, connectionId, secretKind);
      let record: PayswapConnectionRecord;
      try {
        record = payswapConnectionRecordSchema.parse({
          connectionId,
          providerId: spec.providerId,
          mode,
          displayName: input.displayName?.trim() || defaultDisplayName(spec.providerId, mode),
          status: "connected",
          secretKinds: [secretKind],
          createdAt: now(),
          updatedAt: now(),
        });
      } catch (error) {
        // 记录构造失败 = 显示名越界等调用方输入问题 → typed 拒绝（未触任何 store）。
        return refused(
          "validation_failed",
          `The connection metadata is invalid: ${(error as Error).message}`,
        );
      }
      // 拒绝先于记录：凭据 store 的 fail-closed typed 错误映射为账户服务 refusal
      // （code 逐字复用 Gate E2 常量 —— 连接 UI 按 code 分流，永不匹配 message）。
      try {
        await credentialPort.save(storageKey, secret);
      } catch (error) {
        if (isPayswapPspSecureStorageUnavailableError(error)) {
          return refused(PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE, error.message);
        }
        // ADR-P2-3 fail-closed：custodian-required 的托管缺席/拒绝 = typed 拒绝
        //（绝不静默回退 legacy 存储 —— 拒绝先于记录，未触任何 store）。
        if (isPayswapCustodianUnavailableError(error)) {
          return refused(PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE, error.message);
        }
        throw error;
      }
      // 补偿：记录写失败 → 尽力删除已存秘密（不留无记录的孤儿 PSP 密文），原错误上抛。
      try {
        await connectionStore.upsert(record);
      } catch (error) {
        await credentialPort.delete(storageKey).catch(() => undefined);
        throw error;
      }
      return { kind: "connected", connection: projectPayswapConnectionStatus(record) };
    },

    async revoke(input) {
      const record = await connectionStore.find(input.connectionId);
      if (record === null) {
        return refused(
          "unknown_connection",
          `No PaySwap connection exists with id '${input.connectionId}'.`,
        );
      }
      if (record.status === "revoked") {
        // 幂等：已撤销连接的重复撤销不抛错；补清可能残留的秘密（删键对缺失键安全）。
        await deleteSecrets(record).catch(() => undefined);
        const dropOutcome = await dropCustodyOrRefuse(record);
        if (dropOutcome !== undefined) return dropOutcome;
        return { kind: "revoked", connection: projectPayswapConnectionStatus(record) };
      }
      // 先标 revoked（任何中间态绝不留下失真的 connected），再删秘密。
      const revoked: PayswapConnectionRecord = {
        ...record,
        status: "revoked",
        updatedAt: now(),
      };
      await connectionStore.upsert(revoked);
      await deleteSecrets(record);
      const dropOutcome = await dropCustodyOrRefuse(record);
      if (dropOutcome !== undefined) return dropOutcome;
      return { kind: "revoked", connection: projectPayswapConnectionStatus(revoked) };
    },

    async listConnections() {
      const records = await connectionStore.readAll();
      return records.map(projectPayswapConnectionStatus);
    },

    async refreshEvidence(input): Promise<PayswapRefreshResult> {
      const record = await connectionStore.find(input.connectionId);
      if (record === null) {
        return refused(
          "unknown_connection",
          `No PaySwap connection exists with id '${input.connectionId}'.`,
        );
      }
      // revoked 终态：delete-local-only 已删秘密，无凭据可验 —— 不触端口、不读
      // 秘密，直回投影（doc 05 §5「A revoked connection can never keep a stale
      // "connected" status」—— revoked 记录永不回退）。
      if (record.status === "revoked") {
        return { kind: "revoked", connection: projectPayswapConnectionStatus(record) };
      }
      // 端口缺席 = 无 provider 读回 adapter：fail-closed typed 拒绝（不猜）。
      if (readBackAccount === undefined) {
        return refused(
          "read_back_unavailable",
          `No PaySwap provider read-back adapter is registered for '${record.providerId}'.`,
        );
      }
      // P2 的 operator-supplied-secret 流恰一种秘密；P3 client-credentials 记录
      // 携带凭据对（[0] = 主秘密，client-id 作为可选另一半随端口输入）。规格未
      // 声明秘密种类 = 记录/store 不一致 → fail-closed 拒绝（不猜）。
      const secretKind = record.secretKinds[0];
      if (secretKind === undefined) {
        return refused(
          "read_back_unavailable",
          `The connection record for '${record.connectionId}' carries no secret kinds; nothing to verify.`,
        );
      }
      // 全部声明种类现读凭据端口（Gate E2 键级政策在彼处：fail-closed typed 拒绝
      // 映射账户服务 refusal，code 逐字复用 —— 连接 UI 按 code 分流）。
      const credentialValues = new Map<PayswapPspSecretKind, string>();
      for (const kind of record.secretKinds) {
        let value: string | null;
        try {
          value = await credentialPort.load(
            payswapPspSecretCredentialKey(record.providerId, record.connectionId, kind),
          );
        } catch (error) {
          if (isPayswapPspSecureStorageUnavailableError(error)) {
            return refused(PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE, error.message);
          }
          throw error;
        }
        if (value === null) {
          // 本地不一致（记录 connected 而键不在）：无 provider 证据不翻状态 ——
          // typed 拒绝；操作员 revoke 或重连处置。
          return refused(
            "read_back_unavailable",
            `The stored secret for connection '${record.connectionId}' is missing; revoke and re-connect, then retry.`,
          );
        }
        credentialValues.set(kind, value);
      }
      const secret = credentialValues.get(secretKind);
      if (secret === undefined) {
        // 不可达（上面逐种类检查过）—— 皮带扣。
        return refused(
          "read_back_unavailable",
          `The stored secret for connection '${record.connectionId}' is missing; revoke and re-connect, then retry.`,
        );
      }
      // 端口调用 + 结局 strict 校验：畸形结局无证据 = fail-closed typed 拒绝
      //（unknown ≠ expired）；传输异常同样不是 expiry 证据（doc 05 §6.4）。
      let outcome: PayswapAccountReadBackOutcome;
      try {
        const rawOutcome = await readBackAccount({
          providerId: record.providerId,
          mode: record.mode,
          secretKind,
          secret,
          clientId: credentialValues.get("client-id"),
        });
        const parsed = payswapAccountReadBackOutcomeSchema.safeParse(rawOutcome);
        if (!parsed.success) {
          return refused(
            "read_back_unavailable",
            `The provider read-back adapter for '${record.providerId}' returned a malformed outcome.`,
          );
        }
        outcome = parsed.data;
      } catch (error) {
        return refused(
          "read_back_unavailable",
          `The provider read-back for '${record.providerId}' could not be completed: ${
            (error as Error).message
          }`,
        );
      }
      if (outcome.kind === "unavailable") {
        // unknown ≠ expired：读回不可用永不翻状态。
        return refused("read_back_unavailable", outcome.detail);
      }
      if (outcome.kind === "verified") {
        // 恢复行：expired → connected（provider 证据翻回）；connected 保持 →
        // 状态变更才写（无变更不写，记录无 churn）。
        if (record.status === "expired") {
          const restored = payswapConnectionRecordSchema.parse({
            ...record,
            status: "connected",
            updatedAt: now(),
          });
          await connectionStore.upsert(restored);
          return {
            kind: "verified",
            connection: projectPayswapConnectionStatus(restored),
            providerAccountId: outcome.providerAccountId,
          };
        }
        return {
          kind: "verified",
          connection: projectPayswapConnectionStatus(record),
          providerAccountId: outcome.providerAccountId,
        };
      }
      // auth-failed：唯一的 expiry 证据是 provider 的拒绝。已 expired 再拒绝 →
      // 状态不变（无写）；connected → expired（先落记录 —— 状态即真相）。
      if (record.status === "expired") {
        return { kind: "expired", connection: projectPayswapConnectionStatus(record) };
      }
      const expired = payswapConnectionRecordSchema.parse({
        ...record,
        status: "expired",
        updatedAt: now(),
      });
      await connectionStore.upsert(expired);
      return { kind: "expired", connection: projectPayswapConnectionStatus(expired) };
    },

    async getOverviewData(input): Promise<PayswapAccountOverviewDetail> {
      const record = await connectionStore.find(input.connectionId);
      if (record === null) {
        return refused(
          "unknown_connection",
          `No PaySwap connection exists with id '${input.connectionId}'.`,
        );
      }
      // revoked 终态：零端口触达，直回投影（与 refreshEvidence 同一终态法）。
      if (record.status === "revoked") {
        return { kind: "revoked", connection: projectPayswapConnectionStatus(record) };
      }
      // 端口缺席 = 无 provider 读回 adapter：fail-closed typed 拒绝（不猜）。
      if (readBackAccount === undefined) {
        return {
          kind: "refused",
          refusal: {
            code: "read_back_unavailable",
            message: `No PaySwap provider read-back adapter is registered for '${record.providerId}'.`,
          },
        };
      }
      const secretKind = record.secretKinds[0];
      if (secretKind === undefined) {
        return {
          kind: "refused",
          refusal: {
            code: "read_back_unavailable",
            message: `The connection record for '${record.connectionId}' carries no secret kinds; nothing to read.`,
          },
        };
      }
      // P3 client-credentials 记录携带凭据对 —— 全部声明种类现读（与
      // refreshEvidence 同一多种类装载纪律），clientId 随端口输入。
      const credentialValues = new Map<PayswapPspSecretKind, string>();
      for (const kind of record.secretKinds) {
        let value: string | null;
        try {
          value = await credentialPort.load(
            payswapPspSecretCredentialKey(record.providerId, record.connectionId, kind),
          );
        } catch (error) {
          if (isPayswapPspSecureStorageUnavailableError(error)) {
            return {
              kind: "refused",
              refusal: { code: PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE, message: error.message },
            };
          }
          throw error;
        }
        if (value === null) {
          // 本地不一致（记录 connected 而键不在）：无 provider 证据不翻状态。
          return {
            kind: "refused",
            refusal: {
              code: "read_back_unavailable",
              message: `The stored secret for connection '${record.connectionId}' is missing; revoke and re-connect, then retry.`,
            },
          };
        }
        credentialValues.set(kind, value);
      }
      const secret = credentialValues.get(secretKind);
      if (secret === undefined) {
        // 不可达（上面逐种类检查过）—— 皮带扣。
        return {
          kind: "refused",
          refusal: {
            code: "read_back_unavailable",
            message: `The stored secret for connection '${record.connectionId}' is missing; revoke and re-connect, then retry.`,
          },
        };
      }
      // 验证读（与 refreshEvidence 同一状态机）：401 → 翻 expired 并持久化后回答
      // expired（无数据可读）；verified → 状态机落地后携证据继续四类别读。
      let outcome: PayswapAccountReadBackOutcome;
      try {
        const rawOutcome = await readBackAccount({
          providerId: record.providerId,
          mode: record.mode,
          secretKind,
          secret,
          clientId: credentialValues.get("client-id"),
        });
        const parsed = payswapAccountReadBackOutcomeSchema.safeParse(rawOutcome);
        if (!parsed.success) {
          return {
            kind: "refused",
            refusal: {
              code: "read_back_unavailable",
              message: `The provider read-back adapter for '${record.providerId}' returned a malformed outcome.`,
            },
          };
        }
        outcome = parsed.data;
      } catch (error) {
        return {
          kind: "refused",
          refusal: {
            code: "read_back_unavailable",
            message: `The provider read-back for '${record.providerId}' could not be completed: ${
              (error as Error).message
            }`,
          },
        };
      }
      if (outcome.kind === "unavailable") {
        return {
          kind: "refused",
          refusal: { code: "read_back_unavailable", message: outcome.detail },
        };
      }
      if (outcome.kind === "auth-failed") {
        // 唯一 expiry 证据：connected → expired（先落记录）；已 expired → 无写。
        if (record.status !== "expired") {
          const expired = payswapConnectionRecordSchema.parse({
            ...record,
            status: "expired",
            updatedAt: now(),
          });
          await connectionStore.upsert(expired);
          return { kind: "expired", connection: projectPayswapConnectionStatus(expired) };
        }
        return { kind: "expired", connection: projectPayswapConnectionStatus(record) };
      }
      // verified：能力证据缺席 = 概览 detail 面 fail-closed（证据永不缺席时才答数据）。
      if (outcome.evidence === undefined) {
        return {
          kind: "refused",
          refusal: {
            code: "read_back_unavailable",
            message: `The provider read-back for '${record.providerId}' returned no capability evidence; refusing the overview detail.`,
          },
        };
      }
      // 恢复行：expired → connected（provider 证据翻回；状态变更才写）。
      let currentRecord = record;
      if (record.status === "expired") {
        const restored = payswapConnectionRecordSchema.parse({
          ...record,
          status: "connected",
          updatedAt: now(),
        });
        await connectionStore.upsert(restored);
        currentRecord = restored;
      }
      // 四类别只读数据（全部现读；端口缺席 = 诚实 unavailable，不猜）。类别级
      // 401 短路剩余类别（law：readAccountData 头注 §2 —— 被拒秘密不重发），
      // 未发起的类别填诚实 unavailable 占位 —— detail 载荷必须恒带全部四键
      // （桥 per-op 法则 schema .strict() 的键闭集）。
      const data: Record<string, PayswapReadonlyCategoryResult> = {};
      let categoryReadRejected401 = false;
      for (const category of PAYSWAP_READONLY_CATEGORIES) {
        if (categoryReadRejected401) {
          data[category] = {
            status: "unavailable",
            detail: `not attempted: an earlier category read was rejected with HTTP 401 (${record.providerId})`,
          };
          continue;
        }
        if (readAccountData === undefined) {
          data[category] = {
            status: "unavailable",
            detail: `No PaySwap provider data-read adapter is registered for '${record.providerId}'.`,
          };
          continue;
        }
        let result: PayswapReadonlyCategoryResult;
        try {
          const rawResult = await readAccountData({
            providerId: record.providerId,
            mode: record.mode,
            secretKind,
            secret,
            clientId: credentialValues.get("client-id"),
            category,
          });
          const parsed = payswapReadonlyCategoryResultSchemas[category].safeParse(rawResult);
          result = parsed.success
            ? (parsed.data as PayswapReadonlyCategoryResult)
            : {
                status: "unavailable",
                detail: `The provider data-read adapter for '${record.providerId}' returned a malformed ${category} result.`,
              };
        } catch (error) {
          // adapter 装配错配（抛出）→ typed 拒绝面：unavailable（不猜、不响亮崩溃）。
          result = {
            status: "unavailable",
            detail: `The ${category} read for '${record.providerId}' could not be completed: ${
              (error as Error).message
            }`,
          };
        }
        data[category] = result;
        if (result.status === "auth-failed") {
          categoryReadRejected401 = true;
        }
      }
      return {
        kind: "detail",
        connection: projectPayswapConnectionStatus(currentRecord),
        evidence: outcome.evidence,
        data: data as Readonly<Record<(typeof PAYSWAP_READONLY_CATEGORIES)[number], PayswapReadonlyCategoryResult>>,
      };
    },
  };
}
