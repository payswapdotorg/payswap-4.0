/**
 * PaySwap P2.2 slice 9（ADR-P2-2 Addendum B）—— reader 桥端口铸造的 spawn 选项构造。
 *
 * 回归保护（2026-11-18 live 缺陷）：`mintPayswapReaderBridgePort` 属于
 * `SpawnHostProcessOptions`（spawnHostProcess 的**第 5 参**）；窗口 host 调用点曾把它
 * 误 spread 进第 4 参 dependencies（字段不在其类型里，运行期被静默丢弃）→ 端口从未
 * 转移 → host 中继永不 live → agent 永远拿不到 `ZCODE_PAYSWAP_READER_BRIDGE=1` →
 * 账户 reader 缺席 → get_account_overview 恒 not_connected。
 *
 * 本模块刻意不 import electron（MessagePortMain 仅作类型引用），main 单测可在无
 * Electron 运行时直接覆盖。调用点必须把本函数的返回值 spread 进**第 5 参**。
 */

/** SpawnHostProcessOptions 里与本模块相关的切片（避免为此测试拉入 electron 运行时）。 */
export interface PayswapReaderBridgeSpawnOptions {
  mintPayswapReaderBridgePort?: () => unknown;
}

/**
 * 铸造器在场 → 返回携带该铸造器的 spawn 选项（引用原样，调用点 spread 进第 5 参）；
 * 缺席（null/undefined）→ 空选项对象（桥缺席 = fail-closed 缺省，spawn 照常）。
 */
export function buildPayswapReaderBridgeSpawnOptions(
  minter: (() => unknown) | null | undefined,
): PayswapReaderBridgeSpawnOptions {
  return minter ? { mintPayswapReaderBridgePort: minter } : {};
}
