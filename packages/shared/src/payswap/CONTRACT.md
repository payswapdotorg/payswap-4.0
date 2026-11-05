# shared-payswap

PaySwap broker 协议的**唯一共享实现**（w2-01 §6.4(5)）：canonical JSON（RFC 8785）、签名
响应信封（Ed25519, RFC 8032）、请求行摘要（SHA-256, FIPS 180-4）、五键凭据组、per-boot
身份铸造与 append-only 实例注册表。host 与 child 用同一份代码 —— 漂移即违约。

## 不变量

- 信封绑定字段 request-attributed、never claim-echoed（§6.4(3)，F1）：pre-binding 拒绝
  null-bound；null-bound 永不满足子进程 §6.5(3d–f) 绑定。
- `requestDigest` 字节区间：精确请求行、不含结尾换行（§6.4(2)，F4）；结尾换行按行定界符
  规范化（`requestLineDigest(line) === requestLineDigest(line + "\n")`）。
- v1 无未签名响应模式（§6.5(2)）；emission cap：超过 1 MiB 的信封拒绝签发（§6.4(4)，F7）。
- 五键凭据组 all-or-nothing（§4.4(1)）+ 双表剔除纪律（§4.3(1)，F5：strip list 与
  tool-env-passthrough blocklist 同时登记）。
- 验签失败原因闭集 `PayswapBrokerResponseRejectionReason`，每步互不相同；验签永不抛裸
  错误、被拒响应字段永不外露（§6.5(3)）。
- 注册表 append/tombstone-only，tombstone 原因一次性设定（§10.2，F13）；未知 id 不产生
  状态（§10.1）。
- G = 64 为冻结协议常量（§9.4/ADR-2）；本模块不含重放引擎（Step 6 落地）。

## 模块交集

- `@zcode/shared` runtimeEnv（host 进程）：五键剔除 + capture-before-sanitization 快照
  （§4.3/§4.4）—— hook 点在 `runtimeEnv.ts` 的 strip/capture 列表，不在本目录。
- `@zcode/bootstrap` mcp-config：受信注入（reference-identity 门，§4.2）—— hook 点
  `injectPayswapBrokerMcpServers`；本模块只提供凭据组类型与形状校验。
- `@zcode/cli` plugin-host-command：启动断言（上下文 + 时效，§4.4(2) rev 2a）——
  hook 点 `assertCapturedPayswapBrokerLaunchIsAuthorized`。
- payswap-plugin（child 侧）：Step 4+ 的 bridge client 消费 `verifyResponseEnvelope`
  与受信注入的五键 env；本模块不 import 插件包（方向：插件侧经 `@zcode/shared/payswap`
  子路径取用，与 host 侧同一份代码）。
