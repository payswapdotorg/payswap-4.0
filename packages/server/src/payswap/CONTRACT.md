# server-payswap

PaySwap P1.6 —— **server 部署的 operator-principal 模型**（addendum §1.6.3 items 1–9；
handoff work package 5；ADR-11）：两级 `/ws` 握手的 server 侧状态 owner 与装配面。

法则的唯一实现在 `@zcode/shared/payswap`（`operator-credentials.ts` /
`operator-registry.ts` / `operator-handshake.ts` —— 单一实现纪律，两份实现漂移即违约）；
本模块是 server 侧组装与生命周期 owner：

- `config.ts` —— N27 激活法则：financial 是部署级显式 opt-in
  （`ZCODE_PAYSWAP_FINANCIAL_MODE=1`）；请求而无 deployment 凭据 → typed 拒绝
  （`financial_mode_deployment_auth_required`），entry 以非零码退出 —— 绝不以弱姿态
  启动。`createHttpServer` 的第二道门（`payswapFinancial` 无 `authToken` → 构造抛
  typed 错误）保证任何调用方都无法构造弱姿态 financial 服务器。
- `operator-store.ts` —— 状态 owner：注册表持久化（上游 private-persistence 纪律：
  0600 + 原子 rename；digest-only —— 状态里只有 sha256(token)，明文只在
  provision/rotate 一次性返回；sessions/challenges 内存态，重启即失效）；两级握手的
  level-2 评估（header 优先于 cookie，无凭据选购 —— D11.4）；rotation 窗口收尾搭
  每次评估（无定时器 —— D11.3）；撤销/过窗的 server 侧连接关闭（1008）；
  operator-session cookie 铸造（HttpOnly + SameSite=Strict + Path=/ws +
  Max-Age=会话生命周期，默认 15min）。
- `http-wiring.ts` —— Hono 装配面：`/ws` level-2 守卫（呈现但无效 → 裸 401；
  N32 声明他人 principal → 拒绝；认证成功 → WeakMap 绑定，升级工厂 onOpen 取回）、
  `POST /api/payswap/operator-session`（浏览器路径 cookie 铸造端点 —— level-1 =
  lite cookie，level-2 = Authorization Bearer operator 凭据；拒绝路径零状态污染）。

## 不变量

- **两级顺序**：level-1（deployment Bearer/lite cookie；financial 部署禁用 `?token=`
  URL 传输）由全局中间件先验 —— 失败即 401，operator 凭据不被读取（法则级行以
  throwing-getter 证明）；level-2 一切失败归一（升级面 = 适配器裸 401 字节级同形，
  a fortiori；可观察 HTTP 面 = 单一 generic `operator_authentication_failed`）。
- **无凭据不等于失败**：不呈现 operator 凭据的普通客户端以未绑定身份升级（无
  financial principal —— N28 的 session 级臂）；仅**呈现但无效**才拒绝升级。
- **principal 永不由客户端声明**：身份只从凭据/会话 server 侧解析；payload/header
  声明他人 principal → 请求拒绝（N32）；声明自己/不声明 → 字段被忽略。
- **撤销立即且 principal 域**（"the principal's active sessions"）：该 operator 全部
  sessions 关闭、pending challenges 失效、连接 server 侧关闭；rotation 窗口结束的
  收尾是 record 域（"sessions it authenticated"）—— 惰性凭据法则 + 评估时 sweep。
- **roles 是 (operator, workspace) 绑定**：approve 需要**目标** workspace 的 approver
  角色（N31/N41）—— 服务边界评估，永不信浏览器/插件/模型供给的角色。
- **保真**：非 financial 部署的上游路径一行不动（`?token=`、中间件、/ws 行为原样 ——
  S-保真行）。

## 平台/环境边界

- Windows：0600 权限断言按平台跳过（NTFS 权限语义不同）；其余行为平台无关。
- 升级面 401 body 不可观察是 `@hono/node-ws` 适配器行为（Content-Length: 0）——
  D11.5 记录；typed code 在 operator-session 端点与法则 verdict 可观察。
