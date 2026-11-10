/**
 * services-payswap 对外契约（P2.2 账户服务 —— deliverable 06 §2.2 + doc 05 §5）。
 *
 * 公共面即 index.ts 再导出的两个工厂与其类型；方法级契约如下（调用方想知道的
 * 一切，其余对外不可见）：
 *
 * `createPayswapAccountService(deps)`（单一写者）：
 * - `connect({providerId, operatorSecret, displayName?})`：
 *   - 前置：providerId 有已注册 authSpec（否则 typed `unsupported_provider`）；
 *     operatorSecret 通过该规格的防御性 formatCheck 且携带可识别 test/live 前缀
 *     （否则 typed `validation_failed`——格式通过 ≠ 凭据有效，最终权威是后续切片
 *     的 provider read-back）。
 *   - 秘密经 credentialPort 落 `payswap:psp:<providerId>:<connectionId>:<secretKind>`
 *     键；存储通道不可用（Gate E2 fail-closed）→ typed
 *     `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`，**拒绝先于任何落盘**（凭据与
 *     记录两 store 均零写入）。
 *   - 后置：连接记录（非秘密元数据）落记录 store；返回五字段状态投影（无秘密）。
 *   - 幂等性：非幂等——每次调用铸造新 connectionId（多连接并存是设计内形态）。
 *   - 失败补偿：记录写失败 → 尽力删除已存秘密（不留孤儿 PSP 密文）后原错误上抛。
 * - `revoke({connectionId})`：delete-local-only。先标 revoked 再删秘密（任何中间
 *   态绝不留下失真的 connected）；幂等（重复 revoke 同投影；补清残留秘密）；未知
 *   id → typed `unknown_connection`。持久化完成后才返回。
 * - `refreshEvidence({connectionId})`（slice 2，provider read-back）：经注入的
 *   `readBackAccount` 端口（host 进程内）验证凭据并按证据驱动状态机：
 *   - 前置：连接存在（否则 typed `unknown_connection`）；非 revoked（revoked
 *     终态 → 直回 `{kind: "revoked"}` 投影，不触端口、不读秘密）；端口已注入
 *     （缺席 → typed `read_back_unavailable`）。
 *   - 秘密经 credentialPort.load 读出（Gate E2 键级政策：通道不可用 → typed
 *     `PAYSWAP_PSP_SECURE_STORAGE_UNAVAILABLE`，状态不变）；键缺失（本地不
 *     一致）→ typed `read_back_unavailable`，状态不变。
 *   - 结局（strict 三值，畸形/传输异常按 unknown 处理）：`verified` → `expired`
 *     记录翻回 `connected`（恢复行，落记录），`connected` 保持（**状态变更才
 *     写**——无变更不写）；`auth-failed` → `connected` 翻 `expired`（唯一的
 *     expiry 证据是 provider 的拒绝，落记录），已 `expired` 保持（无写）；
 *     `unavailable` → typed `read_back_unavailable`，状态不变（unknown ≠
 *     expired，doc 05 §6.4）。
 *   - 返回：`verified`（含 `providerAccountId` 非秘密证据摘要）/ `expired` /
 *     `revoked` / `refused`——投影面五字段，永不携带秘密。
 * - `listConnections()`：只读；返回全部记录的状态投影（无秘密材料）。
 *
 * `createPayswapConnectionRecordStore(deps)`：
 * - `readAll()`/`find()`：schema 校验后的记录；空 store → 空数组/null。损坏
 *   （JSON 或 schema 违例）→ typed `PAYSWAP_CONNECTIONS_STORE_CORRUPT` 上抛，
 *   **绝不自动覆盖**（corrupt-refuse-overwrite）。
 * - `upsert(record)`：文件锁内原子读-改-写（跨进程安全）；持久化完成才返回。
 * - IO 全注入（缺省 = 真实 fs + @zcode/shared/node 锁/原子写原语）。
 */
export type ServicesPayswapId = string & { readonly __brand: "ServicesPayswapId" };

export interface ServicesPayswapContract {
  // P2.2 的公共面即 index.ts 再导出的模块本身（见各方法的 per-contract 注释与
  // CONTRACT.md）；此接口保留为 managed-module 惯例占位 —— 方法契约分散在
  // accounts/accountService.ts 与 accounts/connectionRecordStore.ts 的具名导出上。
}
