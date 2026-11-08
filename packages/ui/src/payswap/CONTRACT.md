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
