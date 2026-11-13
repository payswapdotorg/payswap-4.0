# desktop-payswap

PaySwap 桌面 main 进程 payswap 装配（ADR-12 D12.7 批准通道「the real IPC mapping,
the production trusted-origin value」+ ADR-15 D15.4 broker-peer helper 桌面供给）。
法则（三检/映射/host/challenge 存储、helper 供给键常量）住 shared-payswap；本模块
只做装配：把真实 `IpcMainInvokeEvent` 交给法则、供给主窗口 URL 作为受信 origin
来源、把随包 helper 对解析成 agent env 供给键。

意图：§1.6.2 item 3 的桌面半 —— 批准事件必须到达主窗口的 service port/IPC，host
按 expected webContents / 主框架 / 受信 application origin 三检拒绝一切其它来源；
ADR-15 D15.4 的桌面半 —— Windows 发布包携带 helper（binary + manifest 成对），
生产 win32 agent 装配期拿到 `PAYSWAP_BROKER_HELPER_{PATH,SHA256}` 供给。

不变量：

- 通道无条件注册是安全的：无 pending proposal 的事件得到 typed `proposal_unknown`
  （fail-closed）；发卡面另有 T3 金融模式 live 读门（非 S2 = 拒发）。
- 受信 origin 每次解析事件前从主窗口 URL 现读（不吃构造期快照；空 URL = 全拒）。
- 本模块不持任何业务状态 —— proposal/challenge/grant 全在 host（shared 法则）。
- helper 供给永不伪造：digest 失配/缺对/null helper/非 win32 → 空对象（诚实不注入，
  agent 落 degraded_refusing）；operator 已设任一供给键即整体让位；注入时验证与
  spawn 时 `verifyHelperBinary` 是同一 digest 的两次验证，不是旁路（D15.5）。

与其它模块的交集 hook 点：desktop main 入口在 desktop Browser E2E 臂接线时调用
`installPayswapDesktopApprovalIpc` 并供给真实的 `getMainWindowFrameUrl`（主窗口
webContents）与 `financialMode` reader（插件 userConfig 投影）；发卡调用方是 P2+ 的
request_authorization 接线。`resolvePayswapBrokerPeerHelperSupply` 由
desktopRuntimeEnv.ts 的 `buildHostProcessEnv`（CUA-helper-app 供给先例）调用 ——
打包态 `process.resourcesPath/payswap-broker-peer/`，dev 态 bundled-tools 相对路径
回退；P1 仅 win32，darwin 桌面资源在 P9 平台加固子里程碑前不携带 helper。
