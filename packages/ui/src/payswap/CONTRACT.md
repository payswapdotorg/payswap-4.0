# ui-payswap

PaySwap 表面撤销接线（ADR-12 D12.7 ——「N18's full plugin-handle teardown arm」）。
法则（注册表/计划/执行器）住 shared-payswap；本模块是它与 @zcode/ui 真实 plugin-ui
原语之间的**绑定 owner**， renderer 侧（桌面/ web 共用）。

意图：addendum §2.3 item 1 臂 (b) 的 opt-out 撤销在桌面/renderer 走**上游自己的**
实例卸载纪律 —— 有界 ui/resource-teardown 窗、按捕获凭证释放 —— 而不是第二套拆除
实现。

不变量：

- 自有键字节等价：`buildPayswapOwnSurfaceKey` ≡ `buildPluginUiSurfaceKey`（shared
  法则按结构同构解析，本模块保证同一字节串；外来插件的键在注册表 fail-closed）。
- token 永不入册：租约只含 sandboxId/initId + appIdentity 三元组。
- 守护窗永远点名自己：`teardownGuardMs = teardownTimeoutMs + 100`，与
  runPluginUiHostTeardown 的内窗（`MCP_APPS_TEARDOWN_TIMEOUT_MS + 100`）同源同式。
- 拆除幂等且不依赖页面合作：目标侧是 controller.dispose()（上游纪律）；执行器守护
  窗到期即推进。
- 替换租约必须新 sandboxId（复用 = 执行器 fail-closed 抛错；initId 不是新鲜性信号）。

与其它模块的交集 hook 点：shared-payswap 的 `PayswapSurfaceRevocationDeps`（本模块
产出绑定）；@zcode/ui plugin-ui 的两 store（逐键清除）与 controller（拆除目标由
装配方桥接 —— 桌面装配在 desktop Browser E2E 臂接线）。

P2.2 slice 8 增补（连接 UI —— ADR-P2-2 Decision 4 的 renderer 呈现半）：设置页
`payswap` 分区（桌面专属）的 `PayswapConnectionsSection` + 呈现法则
`connectionUiPresentation.ts`。不变量：

- **响应闭集直消费**：一切呈现消费 RPC 响应闭集（ok:true per-op 结果联合 /
  ok:false 通道码）；`unauthorized_origin` 不达 renderer（三检先于载荷解析），
  呈现映射对它无专属文案，运行时若出现落 generic 桶。
- **typed refusal 按 code 呈现**（account-connection 法则 5 的 UI 半）：拒绝与
  通道失败按 code 分流到 i18n key，永不匹配 message —— 呈现函数入参类型上不
  接受 message（结构性证明）。
- **operatorSecret 单向性**：秘密只在 connect 请求上行（renderer → main 唯一
  必经边界）；提交后即清空，永不复显/回填/入 notice；响应形状结构上无秘密位。
- **投影行只呈现五行投影**（doc 05 §5）：connectionId/providerId/mode/
  displayName/status。
- **i18n 双语在场**：映射 key + 分区静态 key 在 en-US/zh-CN 同时在场（电池
  payswap-connection-ui-presentation 逐 key 断言）；未知词汇 fail-safe 落
  generic/unknown 桶，呈现函数永不抛出。
- 桥接面：`IPlatformService.payswapConnectionRpc`（shared 类型面）经
  desktopPlatform → preload `payswapConnectionRpc` → desktop main 的连接通道
  （slice 7 法则执法）；无桥（web/远控）= 不可用说明，不渲染表单。
