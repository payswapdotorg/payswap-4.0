/**
 * PaySwap 签名响应信封（契约 w2-01 §6.2、§6.4、§6.5；ADR-1；rev 2a F1/F4/F7/F16）。
 *
 * 法则（§6.5(2)，normative）：host 对**每一个**响应信封签名 —— 成功体、§6.3 的每个错误
 * 码、degraded 模式拒绝、shutdown 拒绝，全部。v1 **不存在未签名响应模式**；能产出未签名
 * 响应行的实现即违约。
 *
 * 法则（§6.4(3) rev 2a，binding）：信封的 `instanceId`/`seq`/`op` 是 **request-attributed,
 * never claim-echoed** —— 仅当请求通过 §5.5 步骤 1–4（peer 验证 → 解析 → token →
 * 实例/注册表绑定）才填具体值；一切 pre-binding 拒绝（`request_invalid` /
 * `peer_verification_failed` / `unauthorized` / `instance_unknown` / degraded）都带
 * `instanceId: null, seq: null, op: null`。载荷 claim 永不回显进签名信封 —— null-bound
 * 信封永不满足子进程的 §6.5(3d–f) 绑定（signed-refusal oracle 的 fail-closed 解）。
 *
 * 子进程校验序（§6.5(3)(a)–(h)，按序 fail-closed，每步一个机器可读的拒绝原因）：
 * 行长上限 → 解析 → 签名（canonicalization 失败 = 整封拒绝，F16）→ 版本 → host 绑定 →
 * 实例绑定（null-bound 永不满足）→ 序列绑定 → 操作绑定 → 请求摘要绑定（§6.4(2) 字节
 * 区间，不含结尾换行，F4）→ body 形状与内层 seq 一致性。任一步失败 → 整封拒绝，被拒
 * 响应的字段一个都不流向模型或工具结果。
 */

import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJsonStringify, PayswapCanonicalizationError } from "./canonical-json.js";
import { parsePublicKeyBase64 } from "./broker-identity.js";

// ---------------------------------------------------------------------------
// 协议类型（§6.1、§6.2、§6.4）
// ---------------------------------------------------------------------------

/** 六操作闭表（§7.1；N21：无第七个 op）。 */
export const PAYSWAP_BROKER_OPS = [
  "compile_intent",
  "check_eligibility",
  "discover_routes",
  "request_authorization",
  "get_execution_status",
  "get_account_overview",
] as const;
export type PayswapBrokerOp = (typeof PAYSWAP_BROKER_OPS)[number];

/** bridge 失败的 typed 闭集（§6.3；与业务三码 `not_opted_in`/`not_connected`/`financial_mode_disabled` 永不混淆）。 */
export const PAYSWAP_BROKER_ERROR_CODES = [
  "unauthorized",
  "peer_verification_failed",
  "instance_unknown",
  "request_invalid",
  "sequence_duplicate",
  "sequence_gap_exceeded",
  "operation_not_found",
  "session_unresolvable",
  "workspace_mismatch",
  "broker_unavailable",
  "internal_error",
] as const;
export type PayswapBrokerErrorCode = (typeof PAYSWAP_BROKER_ERROR_CODES)[number];

/** §6.2 响应体：成功携带 op 结果，失败携带 typed bridge 错误；内层 seq 是兼容回显。 */
export type PayswapBrokerResponseBody =
  | { ok: true; seq: number; data: unknown }
  | {
      ok: false;
      seq: number;
      error: { code: PayswapBrokerErrorCode; message: string; retryable: boolean };
    };

/** §6.4 签名信封（v1）。`instanceId`/`seq`/`op` 可为 null —— pre-binding 拒绝即 null-bound。 */
export interface PayswapBrokerEnvelope {
  v: 1;
  hostInstanceId: string;
  instanceId: string | null;
  seq: number | null;
  op: PayswapBrokerOp | null;
  requestDigest: string;
  response: PayswapBrokerResponseBody;
}

/** §6.4 wire 形状：一行 JSON = `{ envelope, signature }`，无未签名模式。 */
export interface PayswapBrokerSignedResponse {
  envelope: PayswapBrokerEnvelope;
  /** base64 Ed25519 签名，覆盖 canonical(envelope)（§6.5(2)、§6.4(5)）。 */
  signature: string;
}

/** 行长上限（§3.3(2)/§6.4(4)：MAX_RESPONSE_BYTES = MAX_REQUEST_BYTES = 1 MiB，双侧执行）。 */
export const PAYSWAP_MAX_LINE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// 请求行摘要（§6.4(2)）
// ---------------------------------------------------------------------------

/**
 * 请求行摘要：hex SHA-256，覆盖**精确的请求行字节**（UTF-8，**不含结尾换行** —— §6.4(2)
 * 的字节区间，rev 2a F4 修正后的唯一定义）。host 对收到的行、child 对自己写出的行取同一
 * 区间（§6.5(3g)）；对含换行的区间取的 digest 是另一个值，必须不匹配。
 * 结尾恰有一个换行时按无换行处理（行长协议的行定界符不属于行字节）。
 */
export function requestLineDigest(line: string): string {
  const withoutTerminatingNewline = line.endsWith("\n") ? line.slice(0, -1) : line;
  return createHash("sha256").update(withoutTerminatingNewline, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// host 侧签名（§6.5(2)、§6.4(4) emission cap、§6.4(5) canonicalization）
// ---------------------------------------------------------------------------

/** 签名入参：除 `v`/`hostInstanceId`（由本函数钉住）外的全部信封字段。 */
export type PayswapBrokerEnvelopeBinding = Omit<
  PayswapBrokerEnvelope,
  "v" | "hostInstanceId"
>;

/**
 * 构造并签名 v1 响应信封：canonical(envelope) → Ed25519 → base64。
 *
 * - canonicalization 失败（非 JCS 可序列化值）→ 抛 `PayswapCanonicalizationError`：
 *   host 侧在信封构造处拒绝（§6.4(5) —— 调用方必须以 `internal_error` 应答，绝不签名
 *   协议无法确定性序列化的值）。
 * - emission cap（§6.4(4) rev 2a，F7）：序列化后的完整响应行（`{envelope,signature}` 的
 *   JSON 行）超过 1 MiB → 抛错拒绝签发 —— 合法响应永不做"签了却不可验证"。
 */
export function signResponseEnvelope(
  binding: PayswapBrokerEnvelopeBinding,
  privateKey: KeyObject,
  hostInstanceId: string,
): PayswapBrokerSignedResponse {
  const envelope: PayswapBrokerEnvelope = {
    v: 1,
    hostInstanceId,
    instanceId: binding.instanceId,
    seq: binding.seq,
    op: binding.op,
    requestDigest: binding.requestDigest,
    response: binding.response,
  };
  // §6.4(5)：签名覆盖 canonical JSON —— host 与 child 共用同一实现（canonical-json.ts）。
  const canonicalEnvelope = canonicalJsonStringify(envelope);
  const signature = sign(null, Buffer.from(canonicalEnvelope, "utf8"), privateKey).toString("base64");
  const signed: PayswapBrokerSignedResponse = { envelope, signature };

  const lineBytes = Buffer.byteLength(JSON.stringify(signed), "utf8");
  if (lineBytes > PAYSWAP_MAX_LINE_BYTES) {
    // internal_error 语义：放不下的结果由调用方以 internal_error 应答（后续 wave 分页/收窄，
    // 永不超限发信封）。
    throw new Error(
      `payswap broker response envelope exceeds the 1 MiB line cap (${lineBytes} bytes > ${PAYSWAP_MAX_LINE_BYTES}; contract §6.4(4))`,
    );
  }
  return signed;
}

// ---------------------------------------------------------------------------
// child 侧验签（§6.5(3)(a)–(h) —— 每步一个互不相同的机器可读拒绝原因）
// ---------------------------------------------------------------------------

/** 子进程侧的 in-flight attempt 上下文：本次响应必须精确绑定到它的 (instanceId, seq, op, 请求字节)。 */
export interface PayswapBrokerAttemptContext {
  instanceId: string;
  seq: number;
  op: PayswapBrokerOp;
  /** 本 attempt 实际写出的请求行字节（digest 覆盖它，不含结尾换行，§6.5(3g)）。 */
  sentLine: string;
}

/** 子进程持有的 host-boot 验证材料（受信注入的 `PAYSWAP_BROKER_HOST_ID` / `PAYSWAP_BROKER_VERIFY_KEY`）。 */
export interface PayswapBrokerVerificationMaterial {
  hostId: string;
  verifyKeyBase64: string;
}

/**
 * §6.5(3) 每一步的机器可读拒绝原因（互不相同；§6.5(4) 每行必测）。
 * 前两步是 §5.5 镜像的前置（行长/解析），(a) 拆为未签名/信封缺失/签名无效/canonicalization
 * 失败（F16：child 侧 canonicalization 失败 = 整封拒绝，与签名失败同级）。
 */
export type PayswapBrokerResponseRejectionReason =
  | "response_line_oversize" // §6.4(4)：收到的行 > 1 MiB —— 任何签名检查之前拒绝
  | "response_line_unparseable" // §5.5 镜像：行不是 JSON 对象
  | "envelope_missing" // wire 形状缺 `envelope` 对象
  | "signature_missing" // §6.5(2)：无签名字段 —— 不存在未签名模式
  | "signature_invalid" // (a)：Ed25519 验签失败（伪造 / 篡改 / 旧 boot 钥）
  | "envelope_canonicalization_failed" // (a) 前半：收到的信封无法 canonical 化（F16）
  | "verify_key_invalid" // 注入的验证公钥形状非法（配置面问题，整封拒绝）
  | "version_unsupported" // (b)：`v` 不是子进程实现的版本（fail-closed）
  | "host_instance_mismatch" // (c)：跨 host-boot 绑定失败
  | "instance_mismatch" // (d)：跨实例 / null-bound 信封
  | "sequence_mismatch" // (e)：seq 不绑定当前 in-flight attempt
  | "operation_mismatch" // (f)：op 不绑定当前 in-flight attempt
  | "request_digest_mismatch" // (g)：摘要不绑定本 attempt 写出的精确请求字节
  | "response_body_malformed" // (h)：response 不符合 §6.2 形状
  | "response_body_seq_mismatch" // (h)：body 内层 seq ≠ envelope seq（§6.4(1)）
  | "response_unverifiable"; // 兜底：未预期异常 —— 同样整封拒绝，绝不抛裸错误

export type PayswapBrokerVerificationResult =
  | { ok: true; body: PayswapBrokerResponseBody }
  | { ok: false; reason: PayswapBrokerResponseRejectionReason };

/**
 * 子进程验签入口（§6.5(3) 全序）。**永不抛裸错误、被拒响应的字段永不外露** —— 任何
 * 失败都返回 `{ ok: false, reason }`，调用方据此向上抛 typed retryable 失败并丢弃整封。
 */
export function verifyResponseEnvelope(
  line: string,
  attempt: PayswapBrokerAttemptContext,
  material: PayswapBrokerVerificationMaterial,
): PayswapBrokerVerificationResult {
  try {
    // 前置（§6.4(4)/§5.5 镜像）：行长上限在一切解析与签名检查之前执行。
    if (Buffer.byteLength(line, "utf8") > PAYSWAP_MAX_LINE_BYTES) {
      return { ok: false, reason: "response_line_oversize" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, reason: "response_line_unparseable" };
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, reason: "response_line_unparseable" };
    }

    // §6.5(2)：v1 没有未签名响应模式 —— 缺 `signature` 字符串字段即整封拒绝。
    if (typeof parsed.signature !== "string" || parsed.signature.length === 0) {
      return { ok: false, reason: "signature_missing" };
    }
    const envelope: unknown = parsed.envelope;
    if (!isPlainObject(envelope)) {
      return { ok: false, reason: "envelope_missing" };
    }

    // (a) 前半（F16）：收到的信封先过共享 canonical 实现 —— 失败即整封拒绝，
    // 与签名失败同级（host/child 用同一份代码，两份实现漂移即违约，§6.4(5)）。
    let canonicalEnvelope: string;
    try {
      canonicalEnvelope = canonicalJsonStringify(envelope);
    } catch (error) {
      if (error instanceof PayswapCanonicalizationError) {
        return { ok: false, reason: "envelope_canonicalization_failed" };
      }
      throw error;
    }

    // (a) 后半：注入公钥下的 Ed25519 验签（伪造 / 篡改 / 旧 boot 钥全部死在这里）。
    let verifyKey: KeyObject;
    try {
      verifyKey = parsePublicKeyBase64(material.verifyKeyBase64);
    } catch {
      return { ok: false, reason: "verify_key_invalid" };
    }
    const signatureBytes = Buffer.from(parsed.signature, "base64");
    const signatureValid = verify(
      null,
      Buffer.from(canonicalEnvelope, "utf8"),
      verifyKey,
      signatureBytes,
    );
    if (!signatureValid) {
      return { ok: false, reason: "signature_invalid" };
    }

    // (b) 版本：未知版本 fail-closed（§6.5(3b)）。
    if (envelope.v !== 1) {
      return { ok: false, reason: "version_unsupported" };
    }
    // (c) host 绑定：必须是**当前** boot 的 id（跨 boot 拒绝，§6.5(3c)）。
    if (envelope.hostInstanceId !== material.hostId) {
      return { ok: false, reason: "host_instance_mismatch" };
    }
    // (d) 实例绑定：null-bound 信封（pre-binding 拒绝）永不满足 —— null !== 具体 id。
    if (envelope.instanceId !== attempt.instanceId) {
      return { ok: false, reason: "instance_mismatch" };
    }
    // (e) 序列绑定：必须等于本次 in-flight attempt 的 seq。
    if (envelope.seq !== attempt.seq) {
      return { ok: false, reason: "sequence_mismatch" };
    }
    // (f) 操作绑定。
    if (envelope.op !== attempt.op) {
      return { ok: false, reason: "operation_mismatch" };
    }
    // (g) 请求摘要绑定：child 对自己写出的精确请求行字节（不含结尾换行）取同一 digest。
    if (envelope.requestDigest !== requestLineDigest(attempt.sentLine)) {
      return { ok: false, reason: "request_digest_mismatch" };
    }

    // (h) body 形状（§6.2）+ 内层 seq 与 envelope seq 一致（§6.4(1)）。
    const response: unknown = envelope.response;
    if (!isPlainObject(response) || typeof response.ok !== "boolean") {
      return { ok: false, reason: "response_body_malformed" };
    }
    if (response.ok === true) {
      if (!("data" in response)) {
        return { ok: false, reason: "response_body_malformed" };
      }
    } else {
      const error: unknown = response.error;
      if (
        !isPlainObject(error) ||
        typeof error.code !== "string" ||
        typeof error.message !== "string" ||
        typeof error.retryable !== "boolean"
      ) {
        return { ok: false, reason: "response_body_malformed" };
      }
    }
    if (response.seq !== envelope.seq) {
      return { ok: false, reason: "response_body_seq_mismatch" };
    }

    return { ok: true, body: response as PayswapBrokerResponseBody };
  } catch {
    // 兜底：未预期的异常同样整封拒绝 —— 本函数永不向调用方抛裸错误，被拒响应的
    // 字段一个都不外露（§6.5(3)）。
    return { ok: false, reason: "response_unverifiable" };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
