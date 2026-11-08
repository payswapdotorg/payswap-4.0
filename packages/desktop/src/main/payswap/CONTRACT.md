# desktop-payswap

PaySwap 桌面批准通道的 Electron main 装配（ADR-12 D12.7 ——「the real IPC mapping,
the production trusted-origin value」）。法则（三检/映射/host/challenge 存储）住
shared-payswap；本模块只做装配：把真实 `IpcMainInvokeEvent` 交给法则、供给主窗口
URL 作为受信 origin 来源。

意图：§1.6.2 item 3 的桌面半 —— 批准事件必须到达主窗口的 service port/IPC，host
按 expected webContents / 主框架 / 受信 application origin 三检拒绝一切其它来源。

不变量：

- 通道无条件注册是安全的：无 pending proposal 的事件得到 typed `proposal_unknown`
  （fail-closed）；发卡面另有 T3 金融模式 live 读门（非 S2 = 拒发）。
- 受信 origin 每次解析事件前从主窗口 URL 现读（不吃构造期快照；空 URL = 全拒）。
- 本模块不持任何业务状态 —— proposal/challenge/grant 全在 host（shared 法则）。

与其它模块的交集 hook 点：desktop main 入口在 desktop Browser E2E 臂接线时调用
`installPayswapDesktopApprovalIpc` 并供给真实的 `getMainWindowFrameUrl`（主窗口
webContents）与 `financialMode` reader（插件 userConfig 投影）；发卡调用方是 P2+ 的
request_authorization 接线。
