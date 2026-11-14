# ADR-P2-2 — 账户运行时的进程安放（the account runtime placement）

- **Status:** Accepted（TL，P2.2 slice 6 —— 9 步计划第 7 步授权；Option A 依既列推荐）
- **Date:** 2026-11-14
- **Scope:** PaySwap 桌面拓扑里 account runtime（`createPayswapAccountRuntime` —— 单一
  账户服务实例 + broker 的两个 reader 面）的进程安放决策：desktop main 持有 + 类型化
  跨进程 reader 桥，vs CLI 侧 services 准入。headless CLI（无桌面）拓扑的账户面明确
  留在 fail-closed 缺省（若需要，独立 ADR，P3+ 范围）。
- **Normative anchors:** deliverable 06 §2.2（Single writer: the account service）/
  §2.9（provider 运行时）；broker contract w2-01 §7.3（reader 注入面纪律 —— throwing
  reader = internal_error；reader 缺席 = fail-closed 缺省）；ADR-P2-1（两个 reader 面
  的法则语义与 typed refusal 值语义）；addendum §5.2（Gate E2 —— `ZCODE_PAYSWAP_PSP_KEY`
  键契约的单一来源纪律）；doc 05 §5（renderer and agent never receive secret values）；
  doc 04 §1.1（operator-supplied-secret 事实）。

## Context

桌面产品的进程拓扑（本 ADR 核实过的事实）：

- **desktop main**（`packages/desktop`）**已依赖 `@zcode/services`**，且是**唯一能访问
  safeStorage 的进程**（desktop-payswap CONTRACT：PSP 键仓的 safeStorage 包裹/解包只在
  main）；经 Electron `utilityProcess` spawn host（`desktopHostProcess.ts`，
  MessageChannelMain/MessagePortMain 既有可用）。
- **host 进程**（`apps/zcode-cli`，含 bootstrap 的 broker 与协调器）**不依赖
  `@zcode/services`**（既有架构边界）——协调器的 `accountOverviewReader`/
  `accountDetailReader` 是**函数值注入项**（无法跨进程序列化），这就是安放问题的本体。
- **renderer** 是连接 UI 的宿主（P2.2 后续切片）；renderer↔main 既有 ipcMain.handle
  模式（approvalIpc 先例），renderer↔host 既有 service-port RPC 面。
- host 进程是攻击面最大的进程（MCP servers、插件、工具执行的宿主）；broker 安全设计的
  原点是「broker 不持秘密」。

slice 5 在 roadmap P2 行尾留下的开放决策：运行时住在 `@zcode/services`，host 无法在不
破坏边界的前提下就地构造 —— 或者 desktop main 持有运行时 + 类型化跨进程桥（A），或者
CLI 侧 services 准入（B）。

## Decision

**Option A —— 账户运行时住 desktop main，broker 的 reader 面是类型化跨进程桥。**

1. **单一账户服务实例住 desktop main**：`createPayswapAccountRuntime()` 由 desktop main
   装配（desktopPayswapBootstrap 同款装配纪律；运行时懒装配、无 boot 副作用）。
   连接记录 store 与 `payswap:psp:*` 凭据的唯一写者因此在 main 进程 —— doc 06 §2.2
   单写者法则的进程级落地。
2. **凭据通道收窄为进程内交付**：safeStorage 解包键**不再**经 `hostProcessLocalEnv`
   跨进程交付 host —— `accountWarmup` 的 `buildPayswapPspHostEnv` 组装产物
   （`ZCODE_PAYSWAP_PSP_KEY`）作为运行时**注入 env 的进程内视图**交付（runtime 的
   `env` 依赖项）。law（credential-security 决策表与键契约）**零改动**；交付面从
   「跨进程 env」收窄为「进程内注入 env」—— addendum §5.2 与 desktop-payswap
   CONTRACT 记录的 host 交付条款在桌面拓扑下由本条取代。accountWarmup 的 fail-safe
   语义（不可用/解包失败 → 空 env + onWarmupError，永不阻断启动）原样复用。
3. **broker 的两个 reader 面 = 类型化跨进程桥 stub**：host 协调器拿到的是桥 stub ——
   reader 调用经 MessagePortMain 通道到 desktop main，转发到运行时绑定面。桥协议
   law-pinned（法则住 shared-payswap，两端共享）：请求/响应带关联 id；两端 zod 校验
   （投影行与 detail 联合的既有法则 schema）；**typed refusal 结果作为数据透传**
   （refused/expired/… 值语义不变，桥不吞不改）；桥自身的传输失败/超时/校验失败 =
   reader throw → dispatch §7.3 internal_error（liveStateReader 同款类）。桥缺席
   （headless CLI / 桥未建 / 版本不匹配）= reader 缺席 = 既有 fail-closed 缺省
   （概览不答数据、connectionId 收窄只答投影行）—— 缺席与桥故障两种失败在法则层
   本就有别，桥不模糊这个区别。
4. **renderer 连接面（additive RPC channel）落 desktop main**（approvalIpc 的
   ipcMain.handle 模式）：connect/revoke/状态读进程内直达账户服务。**operator 供应的
   connect 秘密永不渡经 host 进程**（doc 04 §1.1 operator-supplied-secret；renderer →
   main 是秘密的唯一必经边界 —— 输入发生地到存储写者之间零额外进程跳）。
5. **host 进程永不接触 PSP 秘密材料**：host 只见到法则投影（schema 级无秘密 ——
   投影行与 detail 联合的 redaction-by-construction）。PSP 密文、解包键、连接记录
   全部不出 main 进程；`ZCODE_PAYSWAP_PSP_KEY` 不再注入 host env（host 侧无消费者）。

## Alternatives considered

- **B：CLI 侧 services 准入**（运行时与 broker 同进程）—— 被拒，三重理由：
  (1) **秘密渡运**：`ZCODE_PAYSWAP_PSP_KEY` 必须跨进程进 host env，PSP cipher 键材料
  落入攻击面最大的进程（MCP/插件/工具执行的宿主）—— 与「broker 不持秘密」的信任
  模型相悖；(2) **依赖边界**：CLI bundle 的 services-free 是既有架构不变量
  （architecture admission），准入 services 改变 CLI 产品的依赖图/构建/上游同步面，
  爆炸半径远超 PaySwap 垂直；(3) **收益仅省一道类型化桥**，而桥无论如何都要建 ——
  renderer 连接面与 P2+ `request_authorization` 的发卡接线都需要 main↔host 通道；
  本 ADR 的桥是同一模式的第一个实例，不是净增成本。
- **C：运行时住 host + desktop main 凭据代理**（键经 IPC 按需服务）—— 被拒：秘密
  渡运没有消除（键仍进 host 内存，只是时点后移），且引入按需秘密服务通道 —— 更宽的
  秘密面 + 更复杂的失效语义，无对应收益。
- **renderer 侧运行时** —— 不成立：renderer 无 fs/safeStorage 且是不可信面（doc 05
  §5 的字面反面）。

## Consequences

- 后续切片（additive RPC channel + platform-shell 连接/onboarding UI + desktop
  Browser E2E 臂）按本决策实施：RPC 受理面在 main、桥协议 law-pinned、E2E 走真实
  桌面流程（renderer → main → 真实服务 → 真实 Stripe test-mode）。
- Gate E2 的 E2E 条款（「connection with only the fallback available refuses —— typed
  error surfaced in the connection UI」「desktop battery green with safeStorage
  active」）在真实桌面 E2E 臂上验证 —— 键通道是进程内的（更窄），断言语义不变。
- store 文件路径的解析基准（main 的 userData vs CLI config 目录）与 main/host 两侧
  凭据 store 的并发访问语义（连接记录 store 已有跨进程文件锁；凭据 store 的锁纪律）
  在下一切片的实现中对齐并 pin（单一事实源纪律）。
- headless CLI 的 broker 保持 reader 缺席 fail-closed 缺省 —— 服务端/headless 的账户
  面若需要，独立 ADR（P3+ 范围）。
- 本 ADR 取代 roadmap P2 行尾的 HONEST OPEN DECISION 子句；slice 5 记录的 host-env
  交付半边在桌面拓扑下由 Decision 第 2 条取代（law 层零改动）。

## Addendum —— slice 7：进程拓扑的核实修正、桥传输的细化、store 路径 pin

**Status:** Accepted（TL 授权内的实现前核实修正 —— 本附录不改变五条 Decision 的任何
信任/法则语义，只修正 Context 的一处事实表述、把 Decision 3 的传输形态按真实拓扑
细化，并兑现 Consequences 的 store 路径 pin 条款。）

### A. 拓扑核实修正（Context 第 2 条的精确化）

本 ADR Context 写「host 进程（`apps/zcode-cli`，含 bootstrap 的 broker 与协调器）」
并把它与「经 `desktopHostProcess.ts` spawn 的 utilityProcess」并列叙述 ——
**这个并列在实现前核实中证实为不精确**，correct facts（slice 7 实现前逐点核实）：

- **broker 与协调器的真实宿主 = agent 进程**：`apps/zcode-cli` 以 `app-server
  --stdio` 模式由**窗口 host 进程**（`packages/desktop/src/host/index.ts`）经
  `node:child_process.spawn` 派生（`packages/services/src/zcode-agent/
  zcodeAgentProcessManager.ts`，`stdio: ["pipe","pipe","pipe"]` —— 无 IPC 通道）；
  协调器在 agent 进程内由 `zcode-protocol-entrypoint`（`ln`）构造，broker 随首个
  受信 server lazy boot（per-boot UDS 端点在 agent 进程）。窗口 host 自身
  **零** payswap 引用（rg 实证）；`injectBrokerCredentials` 的两处调用
  （`create-app.ts`/`zcode-protocol/mcp.ts`）全在 apps/zcode-cli 侧。
- **desktop main 的 utilityProcess 子进程恰两个**：窗口 host
  （`desktopHostProcess.ts:264`）与 cron scheduler（`desktopCronScheduler.ts:62`）。
  `MessagePortMain` 的 spawn 时转移**只能到达 utilityProcess 子进程** —— 按字面
  读原 Decision 3（桥直达协调器）在真实拓扑下不可实现。

对五条 Decision 的影响：**零**。账户运行时住 main（Decision 1）、键进程内交付
（Decision 2）、host 进程永不接触 PSP 秘密（Decision 5）原样成立且已被 slice 6
落地；本附录只细化 Decision 3 的传输形态。

### B. Decision 3 的传输细化（law 两端不变，中继透明）

`account-reader-bridge` 的法则本体（消息闭集、zod 双端、typed refusal 作数据、
失败闭集、串行、时限）与两端不变：**stub 住在 agent 进程的协调器 options，
server 住在 desktop main 的运行时绑定面**。跨进程通道按真实拓扑分两跳：

1. **main ↔ 窗口 host**：spawn 时 `MessageChannelMain` 转移（桥法则头注的通道
   形态 —— main↔utilityProcess，原样兑现）；窗口 host 侧端口适配为
   `PayswapReaderBridgePort`。
2. **窗口 host ↔ agent**：既有 stdio 协议（ZCodeStdioTransport 的 NDJSON 帧）上
   的透明中继 —— 桥消息作为**不透明载荷**双向转发；窗口 host **不解析、不校验、
   不改写**桥消息（法则的 zod 校验只发生在真正的两端 —— 「两端共享单一实现」
   纪律不因中继而稀释；中继不是端）。agent 侧以 stdio 帧适配器构造
   `PayswapReaderBridgePort`，stub 进协调器 options。

缺席语义不变：中继未建/端口未转移/stdio 帧未接线 = reader 缺席 = 既有
fail-closed 缺省（与桥故障的 §7.3 internal_error 在法则层有别，不模糊）。
入口接线切片（main 入口装配 + spawn 转移 + 中继 + agent 侧适配）按本附录实施。

### C. store 路径 pin（Consequences 第 3 条的兑现）

- **解析基准 = CLI 数据根**（非 Electron userData）：desktop main 启动期
  `setDataBaseDir`（`desktopDataBaseDirBootstrap`，main/index.ts:2183 调用）已把
  services 侧路径解析钉到与 CLI/agent 一致的 `~/.zcode` 根；账户运行时的两个
  store 因此落在 `~/.zcode/v2/payswap-connections.json`（连接记录）与
  `~/.zcode` 凭据目录的 `credentials.json`（PSP 密文，Gate E2 键级政策）——
  单一事实源：services `paths.ts` 的解析链，桌面装配不另设路径。
- **单写者（桌面拓扑）= desktop main**：agent/host 侧不打开这两个 store
  （reader 数据经桥；ADR-P2-2 的信任模型本就如此）。跨进程文件锁
  （连接记录 store 的锁 + 凭据 store 的锁）保持为残余多进程拓扑的并发底线
  （headless CLI 的账户面是 P3+ 独立 ADR 的事），不是桌面写路径的常态依赖。

### D. 切片次序（依赖驱动，记录在案）

连接 RPC 通道（Decision 4，renderer → main 进程内）**先于**桥入口接线落地：它是
连接 UI 与 Gate E2 两条 E2E 条款（fallback-only 连接的 typed 拒绝在连接 UI 呈现；
safeStorage active 的桌面电池）的直接前置，且零依赖桥；桥的 agent 侧半边无 UI
依赖。roadmap 原列的「入口接线在前」次序是本附录 A 的不精确表述下的产物，按本
附录修正。
