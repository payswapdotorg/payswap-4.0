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
  PAYSWAP_STRIPE_AUTH_SPEC,
  projectPayswapConnectionStatus,
  type PayswapAccountReadBackOutcome,
  type PayswapAccountReadBackPort,
  type PayswapAccountRefusal,
  type PayswapAuthSpec,
  type PayswapConnectResult,
  type PayswapConnectionRecord,
  type PayswapConnectionStatusProjection,
  type PayswapRefreshResult,
  type PayswapRevokeResult,
} from "@zcode/shared/payswap";
import type { PayswapConnectionRecordStore } from "./connectionRecordStore.js";

/** 凭据端口的 narrowed 面（LocalCredentialService 满足；测试可替身）。 */
export interface PayswapAccountCredentialPort {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PayswapAccountServiceDependencies {
  /** 凭据 store 端口（真实装配 = LocalCredentialService；PSP 键级政策在彼处）。 */
  credentialPort: PayswapAccountCredentialPort;
  /** 连接记录 store（非秘密元数据；本模块是唯一写者）。 */
  connectionStore: PayswapConnectionRecordStore;
  /** 注册的 provider 认证规格（缺省 = [Stripe]；P3 起 per-provider 追加）。 */
  authSpecs?: readonly PayswapAuthSpec[];
  /**
   * provider 读回端口（host 进程内；真实 Stripe 实现随 provider 运行时切片）。
   * 缺席 = refreshEvidence fail-closed typed 拒绝（无 adapter 即无读回，不猜）。
   */
  readBackAccount?: PayswapAccountReadBackPort;
  /** ISO 时间源（缺省 = 真实时钟；测试注入确定性）。 */
  now?(): string;
  /** 连接 ID 铸造（缺省 = shared 法则 mintPayswapConnectionId）。 */
  mintConnectionId?(): string;
}

export interface PayswapAccountService {
  /** 连接一个账户（operator-supplied-secret 流；typed refusal 语义见文件头）。 */
  connect(input: {
    providerId: string;
    operatorSecret: string;
    displayName?: string;
  }): Promise<PayswapConnectResult>;
  /** 撤销连接（delete-local-only；幂等，补清残留秘密）。 */
  revoke(input: { connectionId: string }): Promise<PayswapRevokeResult>;
  /** provider read-back 证据刷新（doc 06 §2.2；状态机语义见文件头）。 */
  refreshEvidence(input: { connectionId: string }): Promise<PayswapRefreshResult>;
  /** 全部连接的状态投影（无秘密）。 */
  listConnections(): Promise<PayswapConnectionStatusProjection[]>;
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
  const connectionStore = dependencies.connectionStore;
  const authSpecs = dependencies.authSpecs ?? [PAYSWAP_STRIPE_AUTH_SPEC];
  const readBackAccount = dependencies.readBackAccount;
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

  return {
    async connect(input) {
      const spec = authSpecs.find((entry) => entry.providerId === input.providerId);
      if (spec === undefined) {
        return refused(
          "unsupported_provider",
          `No PaySwap provider contract is registered for '${input.providerId}'.`,
        );
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
      const connectionId = mintConnectionId();
      // P2 的 operator-supplied-secret 流恰好一种秘密；多秘密种类（client-id/secret
      // 等）随 P3 的 oauth/client-credentials 形态落地，不提前发明。规格未声明任何
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
      // P2 的 operator-supplied-secret 流恰一种秘密；多秘密形态随 P3 落地。
      // 规格未声明秘密种类 = 记录/store 不一致 → fail-closed 拒绝（不猜）。
      const secretKind = record.secretKinds[0];
      if (secretKind === undefined) {
        return refused(
          "read_back_unavailable",
          `The connection record for '${record.connectionId}' carries no secret kinds; nothing to verify.`,
        );
      }
      const storageKey = payswapPspSecretCredentialKey(
        record.providerId,
        record.connectionId,
        secretKind,
      );
      // 秘密读取走凭据端口 load（Gate E2 键级政策在彼处：fail-closed typed 拒绝
      // 映射账户服务 refusal，code 逐字复用 —— 连接 UI 按 code 分流）。
      let secret: string | null;
      try {
        secret = await credentialPort.load(storageKey);
      } catch (error) {
        if (isPayswapPspSecureStorageUnavailableError(error)) {
          return refused(PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE, error.message);
        }
        throw error;
      }
      if (secret === null) {
        // 本地不一致（记录 connected 而键不在）：无 provider 证据不翻状态 ——
        // typed 拒绝；操作员 revoke 或重连处置。
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
  };
}
