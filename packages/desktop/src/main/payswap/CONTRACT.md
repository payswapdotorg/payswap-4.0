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

与其它模块的交集 hook 点：desktop main 入口（desktopPayswapBootstrap.installDesktopPayswapApproval
—— D12.7 desktop Browser E2E 臂的注册半）调用 `installPayswapDesktopApprovalIpc` 并供给真实的
`getMainWindowFrameUrl`（主窗口 webContents）与 `financialMode` reader（financialModeReader：
`~/.zcode/cli/config.json` fresh 读 —— T3 live 门）；cardPush 把发卡/消除事件经
`PAYSWAP_DESKTOP_CARD_CHANNEL` 推给目标卡实例（Class-B 投影模式的投递半，preload 暴露
`payswapResolveApproval` / `onPayswapCard`）；E2E 观察桥（shouldEnableE2ETestBridge 门）
在测试模式挂 `globalThis.__zcodePayswapDesktopApprovalE2E`（P2+ request_authorization
接线前的发卡调用方入口 —— D12.6 in-process 纪律）。发卡调用方是 P2+ 的
request_authorization 接线。

P2 增补（Gate E2 desktop 行，addendum §5.2）：`pspCredentialKeyStore.ts` ——
PSP cipher 随机键的 safeStorage 键仓（Electron main 是唯一能访问 safeStorage 的
进程；host 是 utilityProcess）。不变量：

- at-rest：键文件（app 配置目录 `payswap-psp-safe-storage-key`）只含 safeStorage
  包裹产物，0600 私有模式；仓自己从不写明文、fallback 派生物或第二份。
- fail-closed：safeStorage 不可用 → null（不建文件、不造键、不 memoize —— 可
  重试）；services 侧对 `payswap:psp:*` 键 typed 拒绝。
- 无静默轮换：包裹解不开（钥匙串更换/迁移）→ typed
  `PAYSWAP_PSP_KEY_UNWRAP_FAILED`（shared 法则），文件字节原样保留。
- 并发：ensure 内部串行（in-flight 去重）—— 同一键、恰一次落盘；成功后
  memoize。
- IO 全注入（safeStorage 端口 + fs 端口）—— 法则级测试无 Electron 依赖。
- 交付：解包键经 `buildPayswapPspHostEnv`（shared 法则单一实现）组装为
  `ZCODE_PAYSWAP_PSP_KEY`，由 spawnHostProcess 的 hostProcessLocalEnv 通道交付
  host。**入口接线（app-ready 预热 + spawn 注入）随 P2.2 账户服务连接流与其
  desktop Browser E2E 臂落地**（D12.7 同款纪律：法则与模块先行，入口接线随
  活的窗口证明）。
