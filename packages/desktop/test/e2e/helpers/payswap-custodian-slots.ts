import { createHash } from "node:crypto";
import { payswapPspSecretCredentialKey } from "@zcode/shared/payswap";

/**
 * Custodian v1.1+ 命名槽 blob 路径（E2E at-rest 断言面 —— 测试侧唯一推导点）。
 *
 * 服务端把每个命名槽的 SYSTEM-DPAPI blob 落盘为
 *   C:\ProgramData\payswap\custodian-key-slot-<hex>.bin
 * 其中 <hex> = SHA-256(UTF-8(slotName)) 的前 16 字节小写 hex
 * （apps/zcode-cli/native/payswap-broker-peer-windows/Program.cs `SlotBlobPath`），
 * slotName = 凭据存储键 `payswap:psp:<providerId>:<connectionId>:<secretKind>`
 * （shared 法则 `payswapPspSecretCredentialKey` —— 服务 diag 的 slot= 行同款）。
 *
 * blob 文件名不是 wire（legacy 单槽 wire 逐字不变）。2026-11-25 五分类 runner
 * 首跑（custodian v1.1 之后第一次）暴露：E2E 的 at-rest 断言仍指 v1.0 旧路径
 * `custodian-key.bin` —— v1.1 起该文件永不存在，断言空洞（在场行恒假失败、
 * 清除行恒假通过）。本助手让断言对准**本连接自己的槽位 blob** —— 在场与
 * 证实清除都精确到该连接，比"任意 blob 在场"更强且不依赖其他连接的材料。
 */
export function custodianSlotBlobPath(
  providerId: string,
  connectionId: string,
  secretKind: string,
): string {
  const slot = payswapPspSecretCredentialKey(providerId, connectionId, secretKind);
  const hex = createHash("sha256").update(slot, "utf8").digest("hex").slice(0, 32);
  return "C:\\ProgramData\\payswap\\custodian-key-slot-" + hex + ".bin";
}
