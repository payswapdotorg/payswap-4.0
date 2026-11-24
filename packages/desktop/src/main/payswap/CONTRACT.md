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

与其它模块的交集 hook 点：desktop main 入口（desktopPayswapBootstrap.installDesktopPayswapApproval
—— D12.7 desktop Browser E2E 臂的注册半）调用 `installPayswapDesktopApprovalIpc` 并供给真实的
`getMainWindowFrameUrl`（主窗口 webContents）与 `financialMode` reader（financialModeReader：
`~/.zcode/cli/config.json` fresh 读 —— T3 live 门）；cardPush 把发卡/消除事件经
`PAYSWAP_DESKTOP_CARD_CHANNEL` 推给目标卡实例（Class-B 投影模式的投递半，preload 暴露
`payswapResolveApproval` / `onPayswapCard`）；E2E 观察桥（shouldEnableE2ETestBridge 门）
在测试模式挂 `globalThis.__zcodePayswapDesktopApprovalE2E`（P2+ request_authorization
接线前的发卡调用方入口 —— D12.6 in-process 纪律）。发卡调用方是 P2+ 的
request_authorization 接线。`resolvePayswapBrokerPeerHelperSupply` 由
desktopRuntimeEnv.ts 的 `buildHostProcessEnv`（CUA-helper-app 供给先例）调用 ——
打包态 `process.resourcesPath/payswap-broker-peer/`，dev 态 bundled-tools 相对路径
回退；P1 仅 win32，darwin 桌面资源在 P9 平台加固子里程碑前不携带 helper。

P2 增补（Gate E2 desktop 行，addendum §5.2）：`pspCredentialKeyStore.ts` ——
PSP cipher 随机键的 safeStorage 键仓（Electron main 是唯一能访问 safeStorage 的
进程；host 是 utilityProcess）。不变量：

- at-rest：键文件（app 配置目录 `payswap-psp-safe-storage-key`）只含 safeStorage
  包裹产物，0600 私有模式；仓自己从不写明文、fallback 派生物或第二份。
- fail-closed 两级：①safeStorage 不可用 → null；②Linux 后端不在认可闭集
  （`basic_text` / `unknown` / 未知名 —— 硬编码密码不是 OS 钥匙串保护，见
  `pspSafeStorageBackendPolicy.ts`）→ null。两级都不建文件、不 memoize；
  services 侧对 `payswap:psp:*` 键 typed 拒绝；拒绝先于任何读/写。
- 首写往返验证：fresh 包裹产物解不回原键 = 不可用（不落盘、可重试 ——
  fresh blob 无既有密文依赖，与既有文件的 typed 解包失败区分）。
- 无静默轮换：包裹解不开（钥匙串更换/迁移）→ typed
  `PAYSWAP_PSP_KEY_UNWRAP_FAILED`（shared 法则），文件字节原样保留。
- 并发：ensure 内部串行（in-flight 去重）—— 同一键、恰一次落盘；成功后
  memoize。
- IO 全注入（safeStorage 端口 + 平台值 + fs 端口）—— 法则级测试无 Electron
  依赖（`getSelectedStorageBackend` 是 Linux-only API，仅 linux 平台查询）。
- 交付（ADR-P2-2 Decision 2/5 —— 旧「spawnHostProcess 的 hostProcessLocalEnv
  通道交付 host」已取代）：解包键经 `buildPayswapPspHostEnv`（shared 法则单一
  实现）组装为 `ZCODE_PAYSWAP_PSP_KEY`，作为 desktop main 内账户运行时的
  **进程内 env 视图**（accountRuntimeWiring 法则 2）；键与 PSP 密文不出
  main 进程。入口接线已随 P2.2 连接流与其 desktop Browser E2E 臂落地。

P2.2 slice 6 增补（ADR-P2-2 —— 账户运行时的进程安放）：`accountRuntimeWiring.ts`
—— desktop main 的受监督账户运行时装配 + broker reader 桥的服务端半
（`shared-payswap/account-reader-bridge.ts` 两端共享法则的 main 侧消费）。
ADR-P2-2 Decision 2 同时**取代**上段「由 spawnHostProcess 的
hostProcessLocalEnv 通道交付 host」的交付条款（桌面拓扑下收窄为进程内交付 ——
`ZCODE_PAYSWAP_PSP_KEY` 不再注入 host env；law 决策表与键契约零改动）。
不变量：

- **受监督运行时**：每桥请求先 warmup（现读键 store）；键可用性变化
  （absent↔present，含故障的 fail-closed 语义）才重建 runtime —— credential
  service 的 PSP 键是构造期快照，「按需重建」是 fresh-read 的 honest 组合：
  钥匙串恢复/故障后无需重启。键状态不变 = 同一实例（单写者；连接 UI 半经
  getRuntime 共享同一 service 面）。重建只发生在桥服务端的串行点 —— 无
  in-flight 竞态。`runtimeRebuilds` 是其可观测面。
- **env 视图恰 warmup 产物**：runtime env 只含 `ZCODE_PAYSWAP_PSP_KEY`（或
  空集）—— server 行的 `ZCODE_CREDENTIAL_SECRET` 不进入桌面装配。
- **fail-safe**：warmup 抛出 → 空集 env + onWarmupError，readers 照常应答
  （Gate E2 拒绝留在操作面）。
- **桥法则**（shared 单一实现，两端共用）：消息闭集 strict zod、per-op 值双端
  校验、typed refusal 作数据透传、reader throw = §7.3 internal_error 类、
  服务端串行（响应序 = 请求序）、每呼叫 15 s 有界时限、桥缺席 = reader
  缺席的 fail-closed 缺省。
- **IO 全注入**（keyStore/runtime 依赖/port）；入口接线（main 入口装配 +
  spawn 时的 MessagePort 转移 + host 侧 stub 进协调器）随连接流切片与其
  desktop Browser E2E 臂落地（D12.7 纪律不变）。

P2.2 slice 7 增补（ADR-P2-2 Decision 4 + Addendum —— 连接 RPC 通道）：法则住
`shared-payswap/account-connection-rpc.ts`（单一实现纪律）；本模块增
`accountConnectionIpc.ts`（Electron main 装配 owner）与
`desktopPayswapBootstrap.installDesktopPayswapConnections`（键 store + 受监督
运行时 + 连接 IPC 的单一装配调用）。不变量：

- **受理面在 main**：connect/revoke/refresh/list 四操作进程内直达账户服务
  （doc 06 §2.2 的 additive RPC channel）；operator 供应的 connect 秘密只在
  renderer → main 的 connect 请求里出现（唯一必经边界 —— ADR-P2-2 Decision 4），
  一切响应形状结构上无秘密位（per-op 结果 = 既有账户法则 schema）。
- **三检先于载荷解析**：主框架 + 受信 application origin（approval-origin 法则
  复用，无 expectedWebContentsId 位）；受信 origin 每请求现读主窗口 URL（空 =
  fail-closed 全拒）；不可信发送者的载荷不解析、服务不触达。
- **typed refusal 作数据**：服务的 refused 结果（Gate E2 存储 refusal 等）原样
  跨 IPC —— 连接 UI 呈现 typed 拒绝（Gate E2 E2E 条款）的通道半。
- **通道失败闭集**：unauthorized_origin / malformed_request / internal_error；
  防御纵深 —— 服务产出经 per-op 法则校验后才上 IPC（畸形值本体永不渡 IPC）。
- **键文件路径 pin**（ADR-P2-2 Addendum C）：`getAppConfigDir()`（setDataBaseDir
  钉过的 CLI 数据根）+ `payswap-psp-safe-storage-key` —— 与连接记录 store、凭据
  store 同一解析基准；桌面装配不另设路径。
- **入口接线（main/index.ts 的真实调用 + app-ready 预热 + preload/renderer 面）**
  随连接 UI 与其 desktop Browser E2E 臂落地（D12.7 纪律；本切片交付装配调用与
  法则级/装配级证明）。桥入口接线（spawn 端口转移 + 窗口 host 透明中继 + agent
  侧 stub）按 ADR-P2-2 Addendum B 的传输细化实施（下一切片）。

P2.2 slice 8 增补（连接 UI 的入口接线 + renderer/preload 面 —— D12.7「入口接线
随活的窗口证明」的兑现半）：`main/index.ts` 在批准装配旁调用
`installDesktopPayswapConnections`（同一 `getMainWindowFrameUrl` 现读来源），
app-ready 预热在设置引导（`setDataBaseDir`）**之后**进行 —— 键文件路径解析依赖
CLI 数据根（Addendum C pin），预热结果不缓存（accountWarmup 法则 1）、fail-safe
永不阻断启动（法则 2）。renderer 面：preload 暴露
`payswapConnectionRpc`（`PAYSWAP_DESKTOP_CONNECTION_IPC_CHANNEL` 的结构化透传，
不持任何判定）→ `IPlatformService.payswapConnectionRpc`（shared 类型面）→
`desktopPlatform` 装配 → 设置页 `payswap` 分区（桌面专属 —— 连接 RPC 面只住
desktop main）消费（`@zcode/ui/payswap/PayswapConnectionsSection`；呈现法则住
`connectionUiPresentation.ts`，电池在 packages/ui/test）。不变量不变：三检/
闭集/typed-refusal-作数据/秘密单向性全部住 slice 7 的法则（零改动）；slice 8
只交付接线与呈现面。

P2.2 slice 9 增补（ADR-P2-2 Addendum B —— 桥入口接线：spawn 端口转移 + 窗口
host 透明中继 + agent 侧 stub）：传输法则常量住 shared-payswap
`account-reader-bridge.ts`（`PAYSWAP_READER_BRIDGE_NOTIFICATION_METHOD` stdio 载波
方法、`ZCODE_PAYSWAP_READER_BRIDGE_ENV` spawn env 可用性标记、
`readPayswapReaderBridgeCallId` 中继路由读 —— 恰一字段，零合法性裁决）。本模块
增 `accountReaderBridgeEntry.ts`（main 侧半）：`MessagePortMain` →
`PayswapReaderBridgePort` 的零语义适配 + `createPayswapReaderBridgePortMinter`
（每窗口 host 一个通道：port1 serve〔`runtime.serve`，close → `server.stop()`〕、
port2 转移；通道工厂抛出 → null，fail-safe 不阻断 spawn）。`desktopHostProcess`
的 spawn 流在 init 消息后随独立消息（`PayswapReaderBridgePort`）转移 port2；
`main/index.ts` 经模块级可空持有接线（装配缺席 = 零行为变化）。窗口 host 侧
（`packages/desktop/src/host/payswapReaderBridgeRelay.ts` + host/index.ts）：
main 端口接管（parentPort 消息分支）+ 三个泳道每个 protocol client 的
`onZCodeProtocolClient` tap + `agentSpawnEnv` 可用性标记（端口在活才注入
`ZCODE_PAYSWAP_READER_BRIDGE=1`）。agent 侧（bootstrap `payswap-broker/
stdio-bridge-port.ts` + `zcode-protocol-entrypoint.ts` + `zcode-protocol/
transport.ts`）：env 标记在活才构造 stdio 适配器 + 桥 stub（两个 reader 面进
协调器 options）；桥载波通知帧经 transport 的 `consumeNotification` sideband
**旁路串行队列**（生成请求 handler 内的工具执行等待桥响应，排队 = 死锁 —— 这是
传输形态的成立判据）；标记缺席 = reader 缺席 = 既有 fail-closed 缺省（headless
CLI 拓扑不变）。不变量：中继不校验、不改写、不解释桥消息语义（zod 校验只住
真正的两端 —— 「两端共享单一实现」纪律不因中继而稀释；中继不是端）。法则级/
装配级证明：`bootstrap/tests/payswap-stdio-bridge-port.test.ts`（适配器 + 队列
旁路 + 端到端 stub 往返）、`packages/desktop/test/payswap-reader-bridge-relay.test.ts`
（中继透明性/路由/缺席-故障有别/生命周期）、`packages/desktop/test/
  payswap-reader-bridge-entry.test.ts`（端口适配 + 铸造端到端经真实受监督运行时）。
  desktop Browser E2E 桥臂归 CI（本地 file:// modulepreload 环境缺陷不变）。

P3-D 增补（协议宿主的进程安放）：法则住 `services-payswap/protocols/`（shared
CONTRACT「P3 协议适配器边界」+ services CONTRACT「P3 协议宿主边界」）；本模块
只在 `accountRuntimeWiring.ts` 的受监督运行时里**持有**它。不变量：

- **一个 PaySwap 运行时**：协议宿主（services 的 `createPayswapProtocolRuntime`）
  住既有的 desktop main 受监督账户运行时 —— `protocolRuntime` 是其只读面；
  不另起第二个运行时 / 注册表 / 账本。
- **恰装配一次，不随账户运行时重建而重建**：键可用性变化会重建账户运行时
  （上节法则「受监督运行时」），协议宿主的 challenge 注册表**不**跟着重建 ——
  否则一次钥匙串事件就会静默重置重放状态。协议运行时在构造时创建（纯内存
  装配，无 IO、不触键 store），账户运行时仍保持懒装配。
- **时钟同源**：协议宿主的过期裁决时钟与账户运行时共用同一注入的 `now`
  （生产 = 真实时钟）；进站调用不接收时间参数。
- **生产面不发收据**：`protocolRuntime` 的返回面只有 `protocolHost`（收据发射
  只收 `evidenceRef`，无证据签发能力）—— P3 的桌面宿主对任何协议都发不出
  协议收据（P7 的执行/对账权威接管签发后才有）。
- **与凭据保管正交**：Windows 生产组合（`credentialCustody: "custodian-required"`
  + 无 custodian 桥）下账户 connect fail-closed 拒绝，协议边界照常 —— 协议面
  不触 provider、不触 PSP 键仓。
- **尚无生产入口**：P3 只装配宿主边界；协议消息进入产品的入口（P6「protocol
  translation at the edge」）落地前，没有任何生产调用方触达 `protocolHost`。
  这是有意的（addendum §10「Integration remains disabled until its evidence
  and acceptance suite passes」）。
- 装配级证明：`packages/desktop/test/payswap-protocol-runtime-wiring.test.ts`
  （真实 `installDesktopPayswapConnections` → 受监督运行时 → 协议宿主；重建
  不重置重放状态；无签发者；custodian-required 组合；保全）。
