import { describe, expect, it } from "vitest";
import {
  browserPaneToggleModifiersForPlatform,
  type BrowserPaneToggleModifiers,
} from "./e2e/helpers/browserPaneToggleModifiers.js";

/**
 * 使命简报 §7 的 helper 级测试：「Add a small helper-level test or
 * equivalent supported harness test that verifies the correct event
 * modifiers for the current platform.」
 *
 * 应用快捷键 CmdOrCtrl+Alt+B 的平台解析：macOS → Meta+Alt+B；
 * Linux/Windows → Control+Alt+B（不得为迁就测试夹具改应用快捷键）。
 */
describe("browserPaneToggleModifiersForPlatform（平台正确的右侧面板切换修饰键）", () => {
  it("darwin → Meta+Alt（macOS 上 CmdOrCtrl 解析为 Meta）", () => {
    expect(browserPaneToggleModifiersForPlatform("darwin")).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: true,
    });
  });

  it("linux → Ctrl+Alt（402366c2 之前只发 Apple 形态导致永不命中的平台）", () => {
    expect(browserPaneToggleModifiersForPlatform("linux")).toEqual({
      metaKey: false,
      ctrlKey: true,
      altKey: true,
    });
  });

  it("win32 → Ctrl+Alt（Windows 原生臂的 P1 交付平台之一）", () => {
    expect(browserPaneToggleModifiersForPlatform("win32")).toEqual({
      metaKey: false,
      ctrlKey: true,
      altKey: true,
    });
  });

  it("未知/空平台 fail 向 Linux/Windows 共用形态（macOS 原生验收被推迟）", () => {
    for (const platform of ["", "freebsd", "sunos", "android", "unknown"]) {
      expect(browserPaneToggleModifiersForPlatform(platform)).toEqual({
        metaKey: false,
        ctrlKey: true,
        altKey: true,
      });
    }
  });

  it("Alt 是切换键的组成部分，在所有平台恒为 true", () => {
    for (const platform of ["darwin", "linux", "win32", "unknown"]) {
      expect(browserPaneToggleModifiersForPlatform(platform).altKey).toBe(true);
    }
  });

  it("主修饰键恰取其一：绝不同时携带 Meta 与 Ctrl（同发两形态会让断言失去平台意义）", () => {
    for (const platform of ["darwin", "linux", "win32", "unknown"]) {
      const modifiers: BrowserPaneToggleModifiers =
        browserPaneToggleModifiersForPlatform(platform);
      expect(modifiers.metaKey !== modifiers.ctrlKey).toBe(true);
    }
  });
});
