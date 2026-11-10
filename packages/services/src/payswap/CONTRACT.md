# services-payswap

PaySwap P2.2 的账户服务模块（deliverable 06 §2.2「PSP account & credential
management」；deliverable 05 §5 认证面的 host-service 半）。法则（schema/模板/
投影/authSpec/typed refusal）住 `@zcode/shared/payswap` 的 `account-connection.ts`
—— 本模块只做编排：凭据端口 + 连接记录 store + 时间/随机性注入。

不变量（违反即实现缺陷）：

- **单一写者**：连接记录与 PSP 秘密的写路径只经
  `createPayswapAccountService`（doc 06 §2.2）。UI 投影读、adapter 进程内读 ——
  都不是写者。
- **秘密只落 ICredentialService**：`payswap:psp:<providerId>:<connectionId>:
  <secretKind>` 键，Gate E2 键级政策（safeStorage 键 / `ZCODE_CREDENTIAL_SECRET`
  / 否则 fail-closed typed 拒绝）在 credentialService 侧执行；本模块永不缓存、
  永不日志、永不投影秘密。
- **拒绝先于记录**（connect）：凭据 store 拒绝 → 零落盘（连接记录也不写）；
  记录写失败 → 尽力删除已存秘密（不留孤儿 PSP 密文）后原错误上抛。
- **先标 revoked 再删秘密**（revoke）：任何中间态绝不留下失真的 connected；
  幂等重撤销补清残留秘密。Stripe 是 delete-local-only（doc 04）；provider 侧
  deauthorize（`delete-and-provider-deauthorize`）随该 provider 的证据落地。
- **投影面**：对 UI/模型的返回只有五字段状态投影（shared schema）—— 秘密在
  类型面上不可达。
- **格式检查是防御性的**：formatCheck 通过 ≠ 凭据有效；最终权威是 provider
  read-back（refreshEvidence，下一条）。
- **refreshEvidence（provider read-back，slice 2）**：注入的读回端口
  （`PayswapAccountReadBackPort`，host 进程内）三值结局驱动状态机 ——
  `verified`（`expired`→`connected` 恢复行；`connected` 保持）/ `auth-failed`
  （`connected`→`expired` —— 唯一的 expiry 证据是 provider 的拒绝，
  doc 05 §5「A revoked connection can never keep a stale connected status」
  的 expired 对偶）/ `unavailable`（typed `read_back_unavailable` 拒绝，状态
  不变 —— unknown ≠ expired，doc 05 §6.4 读回权威纪律）。revoked 终态：不触
  端口、不读秘密，直回投影。**状态变更才写记录**（无变更不写 —— 记录无
  churn，与单一写者纪律一致）；秘密读取走凭据端口 `load`（Gate E2 fail-closed
  拒绝映射 typed refusal，code 逐字复用）；秘密缺失（记录 connected 而键不在）
  = 本地不一致行 —— typed 拒绝、状态不变（无 provider 证据不翻状态；操作员
  revoke 或重连处置）。端口缺席 = fail-closed typed 拒绝（无 adapter 即无
  读回，不猜）。原始 read-back 证据落账（ledger seq、能力记录引用）随 P2
  能力注册表切片，本切片只落状态迁移。

连接记录 store（`accounts/connectionRecordStore.ts`）：非秘密 JSON store（app
配置目录 `payswap-connections.json`，0600 原子写 + 跨进程文件锁）；
corrupt-refuse-overwrite（typed `PAYSWAP_CONNECTIONS_STORE_CORRUPT`，绝不自动
覆盖）；IO 全注入。

尚未落地（随 P2.2 后续切片，D12.7 同款纪律——法则与模块先行，入口接线随活的
窗口证明）：

- additive RPC channel（连接 UI 的 host 暴露面）与平台壳 onboarding UI；
- desktop main 入口接线（app-ready 预热 + `ZCODE_PAYSWAP_PSP_KEY` 的
  hostProcessLocalEnv 注入 —— desktop-payswap/CONTRACT.md 的 P2 交付段）；
- broker dispatch 的 account overview 真数据半（read-only conversational
  operations）；
- 真实 Stripe 读回 adapter（`readBackAccount` 的 provider 运行时实现，doc 06
  §2.9）与连接流的 desktop Browser E2E 臂 —— 随活的窗口证明切片。
