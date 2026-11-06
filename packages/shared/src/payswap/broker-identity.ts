/**
 * PaySwap broker host-boot 身份（契约 w2-01 §6.5(1)、§3.1(2)、§3.4；ADR-1）。
 *
 * 法则（§6.5(1)，normative）：host 在每次 broker boot（host 进程金融服务的启动，即拥有
 * §3.1(3) endpoint 的同一生命周期）生成 **Ed25519** 密钥对（RFC 8032）。**私钥永不离开
 * host 内存** —— 不得进入任何子进程 env、plugin config、manifest、日志、文件、socket，
 * 或任何 broker 请求/响应的任何字段；它唯一存在的位置是签名调用。公钥与 host-boot id
 * （fresh UUID per boot）经 §4.2 受信路径注入官方 PaySwap 子进程
 * （`PAYSWAP_BROKER_VERIFY_KEY` / `PAYSWAP_BROKER_HOST_ID`）。
 *
 * 作用域（ADR-1）：每次 host boot 一对钥，该 boot 的全部实例共享。跨实例混淆已被
 * envelope 的 `instanceId` 绑定排除（§6.5(3d)）；per-instance 签名钥只会增加 host 内存中
 * 的秘密材料而不增加绑定。每次 boot 自动轮换，不存在需要保护/手动轮换的长命钥。
 *
 * 本步只铸 per-boot endpoint 路径字符串（§3.1(2) 的 mkdtemp 式私有目录模式下的 socket
 * 路径，路径不可预测 —— §3.4）；**不创建目录、不建 listener** —— 监听属于 Step 3。
 */

import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** host-boot 状态：签名钥对 + boot id + per-boot endpoint 路径（§6.5(1)、§3.1(2)）。 */
export interface PayswapBrokerBootState {
  /** host-boot UUID v4 —— 响应签名钥的作用域，即 envelope 的 `hostInstanceId`（§6.4）。 */
  hostId: string;
  /** Ed25519 密钥对（KeyObject）。privateKey 只进签名调用，永不出 host 内存（§6.5(1)）。 */
  keyPair: { publicKey: KeyObject; privateKey: KeyObject };
  /** per-boot 私有目录下的 socket 路径（只铸字符串；目录与 listener 属于 Step 3，§3.1(2)）。 */
  endpointPath: string;
}

// mkdtemp 式随机后缀（§3.4：路径不可预测 → pre-planting 实际不可构造）。24 hex 字符熵
// 超过 mkdtemp 的 6 字符，保持同一纪律；目录前缀 `payswap-broker-`（Step 2 测试钉住）。
const ENDPOINT_DIRECTORY_SUFFIX_BYTES = 12;

/**
 * 铸 per-boot broker 状态：fresh UUID v4 host id + fresh Ed25519 密钥对 + per-boot 私有
 * endpoint 路径（ADR-1：每次 boot 全新三元组 —— 无跨 boot 复用）。
 */
export function mintBrokerBootState(): PayswapBrokerBootState {
  const hostId = randomUUID();
  const keyPair = generateKeyPairSync("ed25519");
  const endpointPath = join(
    tmpdir(),
    `payswap-broker-${randomBytes(ENDPOINT_DIRECTORY_SUFFIX_BYTES).toString("hex")}`,
    "broker.sock",
  );
  return { hostId, keyPair, endpointPath };
}

// Ed25519 SubjectPublicKeyInfo (RFC 8410) 的 12 字节 DER 头 —— 后接 raw 32 字节公钥。
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_PUBLIC_KEY_BYTES = 32;

/** 导出 Ed25519 公钥为 RFC 8032 raw 32 字节的 base64（`PAYSWAP_BROKER_VERIFY_KEY` 的值）。 */
export function exportPublicKeyBase64(key: KeyObject): string {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`expected an ed25519 public key, got ${String(key.asymmetricKeyType)}`);
  }
  const spki = key.export({ format: "der", type: "spki" });
  if (!(spki instanceof Buffer) || spki.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_PUBLIC_KEY_BYTES) {
    throw new Error("ed25519 public key export did not yield the RFC 8032 raw 32-byte key");
  }
  return spki.subarray(spki.length - ED25519_RAW_PUBLIC_KEY_BYTES).toString("base64");
}

/** 解析 base64 的 raw 32 字节 Ed25519 公钥为 KeyObject（长度不符即抛错，fail-closed）。 */
export function parsePublicKeyBase64(base64: string): KeyObject {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== ED25519_RAW_PUBLIC_KEY_BYTES) {
    throw new Error(
      `PAYSWAP_BROKER_VERIFY_KEY must decode to a 32-byte Ed25519 public key, got ${raw.length} bytes`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}
