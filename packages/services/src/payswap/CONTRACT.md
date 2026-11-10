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
  read-back（P2 后续切片的 refreshEvidence / 账户读回）。

连接记录 store（`accounts/connectionRecordStore.ts`）：非秘密 JSON store（app
配置目录 `payswap-connections.json`，0600 原子写 + 跨进程文件锁）；
corrupt-refuse-overwrite（typed `PAYSWAP_CONNECTIONS_STORE_CORRUPT`，绝不自动
覆盖）；IO 全注入。

尚未落地（随 P2.2 后续切片，D12.7 同款纪律——法则与模块先行，入口接线随活的
窗口证明）：

- additive RPC channel（连接 UI 的 host 暴露面）与平台壳 onboarding UI；
- desktop main 入口接线（app-ready 预热 + `ZCODE_PAYSWAP_PSP_KEY` 的
  hostProcessLocalEnv 注入 —— desktop-payswap/CONTRACT.md 的 P2 交付段）；
- refreshEvidence（provider read-back）与 `expired` 状态；
- broker dispatch 的 account overview 真数据半（read-only conversational
  operations）。
