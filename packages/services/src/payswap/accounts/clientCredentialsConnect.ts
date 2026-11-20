/**
 * PaySwap P3 provider half —— client-credentials 连接流（PayPal 首落地）的独立
 * 模块（从 accountService 抽出 —— 架构 max-file-lines 上限内保持单一职责）。
 *
 * 法则（与 accountService 文件头的连接流纪律逐字同源）：
 * - 凭据对（client-id + client-secret）各按其秘密种类存凭据 store；模式 =
 *   operator-declared（sandbox/live 凭据不编码环境 —— 连接输入显式携带，不猜）；
 * - 拒绝先于记录：任一秘密存储失败 → typed 拒绝 + 已入库种类补偿删除（绝不留
 *   部分凭据对的孤儿密文）；记录写失败 → 全量补偿删除后原错误上抛；
 * - ADR-P2-3：托管通道当前是单秘密槽（P2 已验收边界）—— 托管在位时多秘密
 *   provider refuse typed custodian_unavailable（绝不部分入库制造损坏状态）。
 */

import {
  payswapConnectionRecordSchema,
  payswapPspSecretCredentialKey,
  PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE,
  PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE,
  projectPayswapConnectionStatus,
  isPayswapCustodianUnavailableError,
  isPayswapPspSecureStorageUnavailableError,
  type PayswapAccountRefusal,
  type PayswapClientCredentialsAuthSpec,
  type PayswapConnectResult,
  type PayswapConnectionRecord,
  type PayswapPspSecretKind,
} from "@zcode/shared/payswap";
import type { PayswapConnectionRecordStore } from "./connectionRecordStore.js";

/**
 * 结构化端口/桥面（与 accountService 的 PayswapAccountCredentialPort /
 * PayswapCustodianBridge 结构兼容 —— 刻意本模块内最小声明，避免模块环：
 * accountService → 本模块 → accountService）。
 */
interface ClientCredentialsCredentialPort {
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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

export interface PayswapClientCredentialsConnectDependencies {
  readonly credentialPort: ClientCredentialsCredentialPort;
  readonly connectionStore: PayswapConnectionRecordStore;
  readonly now: () => string;
  readonly mintConnectionId: () => string;
}

/**
 * 创建 client-credentials 连接流（accountService 的 connect 分支注入点）。
 * 输入/结局语义见上方法则；secretValues 映射是规格声明的秘密种类 → 凭据值
 * （client-id / client-secret —— 新 client-credentials provider 扩此映射）。
 */
export function createPayswapClientCredentialsConnect(
  dependencies: PayswapClientCredentialsConnectDependencies,
): (
  spec: PayswapClientCredentialsAuthSpec,
  input: {
    providerId: string;
    operatorSecret: string;
    clientId?: string;
    mode?: "test" | "live";
    displayName?: string;
  },
) => Promise<PayswapConnectResult> {
  const { credentialPort, connectionStore, now, mintConnectionId } = dependencies;

  return async (spec, input): Promise<PayswapConnectResult> => {
    const clientId = input.clientId?.trim() ?? "";
    if (clientId.length === 0) {
      return refused(
        "validation_failed",
        `The ${spec.providerId} client id is required (the credential pair authenticates as a unit).`,
      );
    }
    const clientSecret = input.operatorSecret.trim();
    if (
      clientSecret.length === 0 ||
      !spec.acquisition.clientSecretFormatCheck.test(clientSecret)
    ) {
      return refused(
        "validation_failed",
        `The supplied secret does not match the expected ${spec.providerId} credential format.`,
      );
    }
    const mode = input.mode;
    if (mode !== "test" && mode !== "live") {
      return refused(
        "validation_failed",
        `The ${spec.providerId} connection requires an explicit sandbox/live mode (the credentials do not encode the environment).`,
      );
    }
    // ADR-P2-3 v1.1：托管在位 = 命名槽（每个秘密种类各一枚槽，槽名 = 凭据
    // 存储键）—— 凭据对可以入库（旧「单秘密槽覆盖」边界由命名槽结构性解决）。
    // 注意：client-credentials 的 refresh 在托管下仍诚实 unavailable（token
    // 交换代理是后续 v1.2 切片）—— 连接可建、可撤销，读面拒绝可见。
    const connectionId = mintConnectionId();
    const secretKinds = [...spec.secretKinds];
    const secretValues: Partial<Record<PayswapPspSecretKind, string>> = {
      "client-id": clientId,
      "client-secret": clientSecret,
    };
    let record: PayswapConnectionRecord;
    try {
      record = payswapConnectionRecordSchema.parse({
        connectionId,
        providerId: spec.providerId,
        mode,
        displayName: input.displayName?.trim() || defaultDisplayName(spec.providerId, mode),
        status: "connected",
        secretKinds,
        createdAt: now(),
        updatedAt: now(),
      });
    } catch (error) {
      return refused(
        "validation_failed",
        `The connection metadata is invalid: ${(error as Error).message}`,
      );
    }
    // 拒绝先于记录：任一秘密存储失败 → typed 拒绝，零落盘（与 operator 流同源）。
    const savedKinds: PayswapPspSecretKind[] = [];
    try {
      for (const secretKind of secretKinds) {
        const value = secretValues[secretKind];
        if (value === undefined) {
          // 规格声明的种类无对应凭据值 = 注册表配置缺陷 → fail-closed。
          throw new Error(`The ${spec.providerId} contract declared secret kind '${secretKind}' without a value.`);
        }
        await credentialPort.save(
          payswapPspSecretCredentialKey(spec.providerId, connectionId, secretKind),
          value,
        );
        savedKinds.push(secretKind);
      }
    } catch (error) {
      // 补偿：删掉已入库的秘密（不留部分凭据对的孤儿密文），再映射 typed 拒绝。
      for (const saved of savedKinds) {
        await credentialPort
          .delete(payswapPspSecretCredentialKey(spec.providerId, connectionId, saved))
          .catch(() => undefined);
      }
      if (isPayswapPspSecureStorageUnavailableError(error)) {
        return refused(PAYSWAP_ACCOUNT_SECURE_STORAGE_REFUSAL_CODE, error.message);
      }
      if (isPayswapCustodianUnavailableError(error)) {
        return refused(PAYSWAP_ACCOUNT_CUSTODIAN_UNAVAILABLE_CODE, error.message);
      }
      throw error;
    }
    // 补偿：记录写失败 → 尽力删除已存凭据对（不留无记录的孤儿密文），原错误上抛。
    try {
      await connectionStore.upsert(record);
    } catch (error) {
      for (const secretKind of secretKinds) {
        await credentialPort
          .delete(payswapPspSecretCredentialKey(spec.providerId, connectionId, secretKind))
          .catch(() => undefined);
      }
      throw error;
    }
    return { kind: "connected", connection: projectPayswapConnectionStatus(record) };
  };
}
