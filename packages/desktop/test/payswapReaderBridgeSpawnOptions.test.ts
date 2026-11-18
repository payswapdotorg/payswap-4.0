/**
 * P2.2 slice 9 回归保护 —— reader 桥端口铸造器的 spawn 选项构造（TL review §3 B）。
 *
 * 2026-11-18 live 缺陷：`mintPayswapReaderBridgePort` 属于 SpawnHostProcessOptions
 * （spawnHostProcess 的第 5 参），但窗口 host 调用点把它误 spread 进第 4 参
 * dependencies（字段不在其类型里，运行期被静默丢弃）→ 端口从未转移 → host 中继
 * 永不 live → agent 永远拿不到 `ZCODE_PAYSWAP_READER_BRIDGE=1` → 账户 reader 缺席 →
 * get_account_overview 恒 not_connected。
 *
 * 构造现已收口到 `buildPayswapReaderBridgeSpawnOptions`（electron-free 纯函数）；
 * 调用点把它的返回值 spread 进第 5 参 options 对象。本 battery 钉死构造契约：
 * 铸造器在场 → 同一引用携带在 mintPayswapReaderBridgePort 下；缺席 → 空选项。
 */
import { describe, expect, it } from "vitest";
import { buildPayswapReaderBridgeSpawnOptions } from "../src/main/payswap/readerBridgeSpawnOptions.js";

const minter = (): unknown => ({});

describe("buildPayswapReaderBridgeSpawnOptions", () => {
  it("a present minter is carried verbatim under mintPayswapReaderBridgePort (the 5th-arg SpawnHostProcessOptions contract)", () => {
    const options = buildPayswapReaderBridgeSpawnOptions(minter);
    expect(Object.keys(options).sort()).toEqual(["mintPayswapReaderBridgePort"]);
    expect(options.mintPayswapReaderBridgePort).toBe(minter);
  });

  it("a null minter → empty options (bridge absent = fail-closed default, spawn proceeds)", () => {
    expect(buildPayswapReaderBridgeSpawnOptions(null)).toEqual({});
  });

  it("an undefined minter → empty options (installation not ready yet)", () => {
    expect(buildPayswapReaderBridgeSpawnOptions(undefined)).toEqual({});
    const notReady: (() => unknown) | undefined = undefined;
    expect(buildPayswapReaderBridgeSpawnOptions(notReady)).toEqual({});
  });

  it("the returned options object never leaks extra keys beyond the mint field", () => {
    for (const candidate of [minter, null, undefined] as const) {
      const options = buildPayswapReaderBridgeSpawnOptions(candidate);
      for (const key of Object.keys(options)) {
        expect(key).toBe("mintPayswapReaderBridgePort");
      }
    }
  });
});
