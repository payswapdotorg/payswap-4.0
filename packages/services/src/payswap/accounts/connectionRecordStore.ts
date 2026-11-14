/**
 * PaySwap P2.2 —— 连接记录 store（deliverable 06 §2.2「State: connection records
 * (non-secret metadata)… Secrets never live here」的持久化半）。
 *
 * 纪律：
 * - **非秘密 store**：本文件只存连接记录（schema 见 shared-payswap
 *   account-connection.ts，strict）；秘密一律走 ICredentialService 的
 *   `payswap:psp:*` 键（Gate E2 政策）。任何把秘密写进本 store 的尝试在
 *   schema 层即拒绝（未知字段）。
 * - **corrupt-refuse-overwrite**：JSON 损坏或记录 schema 违例 → typed 错误上抛，
 *   绝不自动覆盖（与 credentialService / settingService 同族纪律；损坏文件保持
 *   原样供检查）。
 * - **原子私有写 + 跨进程锁**：upsert 在文件锁内读-改-写（与 credentials.json
 *   同款 withFileLock + atomicWritePrivateTextFile —— 多窗口/多进程下无丢写）。
 * - **IO 全注入**：fs 端口与锁端口可注入（law 级测试无真实磁盘耦合）；缺省绑定
 *   node:fs 与 @zcode/shared/node 的真实实现。默认路径 = app 配置目录
 *   `payswap-connections.json`（与 credentials.json 同目录、同 0600 私有模式）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  payswapConnectionRecordSchema,
  type PayswapConnectionRecord,
} from "@zcode/shared/payswap";
import { getAppConfigDir } from "../../paths.js";

/** 连接记录 store 的文件名（app 配置目录内；非秘密元数据，0600 私有模式）。 */
export const PAYSWAP_CONNECTIONS_STORE_FILE_NAME = "payswap-connections.json";

/** typed 损坏错误（corrupt-refuse-overwrite；操作员可检查原文件后处置）。 */
export const PAYSWAP_CONNECTIONS_STORE_CORRUPT_CODE = "PAYSWAP_CONNECTIONS_STORE_CORRUPT" as const;

export interface PayswapConnectionsStoreCorruptError extends Error {
  code: typeof PAYSWAP_CONNECTIONS_STORE_CORRUPT_CODE;
}

export function createPayswapConnectionsStoreCorruptError(detail: string): PayswapConnectionsStoreCorruptError {
  return Object.assign(
    new Error(
      `PaySwap connection records are corrupt and were not overwritten (${detail}); inspect or remove the file manually, then retry`,
    ),
    { code: PAYSWAP_CONNECTIONS_STORE_CORRUPT_CODE },
  );
}

export function isPayswapConnectionsStoreCorruptError(error: unknown): error is PayswapConnectionsStoreCorruptError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PAYSWAP_CONNECTIONS_STORE_CORRUPT_CODE
  );
}

export interface PayswapConnectionRecordStore {
  /** 全部记录（schema 校验后；空 store → 空数组）。 */
  readAll(): Promise<PayswapConnectionRecord[]>;
  /** 按 connectionId 查找；无 → null。 */
  find(connectionId: string): Promise<PayswapConnectionRecord | null>;
  /** 插入或替换一条记录（文件锁内原子读-改-写）。 */
  upsert(record: PayswapConnectionRecord): Promise<void>;
}

export interface PayswapConnectionRecordStoreDependencies {
  /** store 文件路径（缺省 = app 配置目录内固定文件名）。 */
  resolveStorePath?(): string;
  /** 读文件；ENOENT → null（其余错误上抛）。 */
  readFile?(path: string): Promise<string | null>;
  /** 私有模式原子写（0600/等价 ACL）。 */
  writeFile?(path: string, data: string): Promise<void>;
  /** 跨进程文件锁（与 credentials.json 同款纪律）。 */
  withLock?<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

interface BoundPorts {
  resolveStorePath(): string;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  withLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

function bindPorts(dependencies: PayswapConnectionRecordStoreDependencies = {}): BoundPorts {
  return {
    resolveStorePath:
      dependencies.resolveStorePath ??
      (() => join(getAppConfigDir(), PAYSWAP_CONNECTIONS_STORE_FILE_NAME)),
    readFile:
      dependencies.readFile ??
      (async (path) => {
        try {
          return await readFile(path, "utf-8");
        } catch (error) {
          if ((error as { code?: unknown }).code === "ENOENT") return null;
          throw error;
        }
      }),
    writeFile: dependencies.writeFile ?? ((path, data) => atomicWritePrivateTextFile(path, data)),
    withLock: dependencies.withLock ?? ((path, operation) => withFileLock(path, operation)),
  };
}

function parseRecords(raw: string): PayswapConnectionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw createPayswapConnectionsStoreCorruptError(`JSON parse failed: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw createPayswapConnectionsStoreCorruptError("store root is not an array");
  }
  return parsed.map((entry) => {
    const result = payswapConnectionRecordSchema.safeParse(entry);
    if (!result.success) {
      throw createPayswapConnectionsStoreCorruptError(
        `record schema violation: ${JSON.stringify(result.error.issues[0]?.path ?? [])}`,
      );
    }
    return result.data;
  });
}

export function createPayswapConnectionRecordStore(
  dependencies: PayswapConnectionRecordStoreDependencies = {},
): PayswapConnectionRecordStore {
  const ports = bindPorts(dependencies);
  async function loadAll(storePath: string): Promise<PayswapConnectionRecord[]> {
    const raw = await ports.readFile(storePath);
    return raw === null ? [] : parseRecords(raw);
  }
  return {
    async readAll() {
      return loadAll(ports.resolveStorePath());
    },
    async find(connectionId) {
      const records = await loadAll(ports.resolveStorePath());
      return records.find((record) => record.connectionId === connectionId) ?? null;
    },
    async upsert(record) {
      const storePath = ports.resolveStorePath();
      await ports.withLock(storePath, async () => {
        const records = await loadAll(storePath);
        const index = records.findIndex((entry) => entry.connectionId === record.connectionId);
        if (index >= 0) records[index] = record;
        else records.push(record);
        await ports.writeFile(storePath, `${JSON.stringify(records, null, 2)}\n`);
      });
    },
  };
}
