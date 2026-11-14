/**
 * 右侧面板 Browser 切换快捷键（⌥⌘B / Ctrl+Alt+B）的平台正确修饰键选择。
 *
 * 背景（使命简报 §7 / register 2026-11-09）：应用绑定是 CmdOrCtrl+Alt+B ——
 * macOS 解析为 Meta，Linux/Windows 解析为 Ctrl。合成 keydown 事件必须与
 * 运行平台的解析形态匹配；只派发 Apple 形态在 Linux 上永远不命中
 * （402366c2 之前两处 browser spec 卡在收起面板上的根因）。
 *
 * 纯函数：不触 browser/webdriverio 全局，可在 node/vitest 下直接单测
 * （packages/desktop/test/e2eBrowserPaneToggleModifiers.test.ts，6 行）。
 * E2E 运行器与本机 electron 应用同机运行，process.platform 即应用平台。
 */
export interface BrowserPaneToggleModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function browserPaneToggleModifiersForPlatform(
  platform: NodeJS.Platform | string,
): BrowserPaneToggleModifiers {
  if (platform === "darwin") {
    // macOS：CmdOrCtrl 解析为 Meta。
    return { metaKey: true, ctrlKey: false, altKey: true };
  }
  // Linux/Windows（CmdOrCtrl 解析为 Ctrl）及未知平台一律 fail 向其共用形态：
  // macOS 原生验收被推迟（使命 PART B），未知平台不是受支持形态，
  // 不放宽到双形态派发——映射由 6 行单测锁死。
  return { metaKey: false, ctrlKey: true, altKey: true };
}
