/**
 * P1.8 D12.7 伪造发送者臂的测试 preload：在第二个（非主）窗口暴露裸
 * ipcRenderer.invoke，让 E2E 能从真实存在的另一 webContents/origin 发起
 * 批准解析 —— 三检法则（expected webContents / main frame / trusted origin）
 * 因此获得真实 IPC 事件的运行时证明（法则级行见 bootstrap
 * payswap-approval-desktop.test.ts）。
 *
 * 只随 E2E fixture 分发，永不进入产品 preload。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__payswapForgedInvoke", (argJson) => {
  const request = JSON.parse(argJson);
  return ipcRenderer.invoke(request.channel, request.payload);
});
