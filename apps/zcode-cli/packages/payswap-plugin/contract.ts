/**
 * payswap-plugin 对外契约：官方 PaySwap 插件（P0 附录 normative 的落地）对外暴露什么、
 * 构建后保证产出什么。六个 payswap_* 工具、三个 Class A 信息表面与 typed refusal 语义的
 * 运行时契约见 src/contract.ts；这里是模块级摘要。
 */

/** 插件构建后在插件根目录下必定存在的产物（官方 seed 的 requiredSeedPaths 与之对齐）。 */
export const PAYSWAP_PLUGIN_OUTPUTS = [".zcode-plugin/plugin.json", "dist/server.mjs"] as const;

/** 六个模型可见工具（manifest mcpServers.gateway 声明的 server 所注册）。 */
export const PAYSWAP_TOOL_NAMES = [
  "payswap_compile_intent",
  "payswap_check_eligibility",
  "payswap_discover_routes",
  "payswap_request_authorization",
  "payswap_get_execution_status",
  "payswap_get_account_overview",
] as const;

/** 三个 Class A 信息性表面（附录 §1.6.0；authorization 卡是 Class B，永不在此声明）。 */
export const PAYSWAP_SURFACE_IDS = ["workspace", "route-plan", "evidence"] as const;

/** manifest userConfig 声明的唯一开关：financialWorkspace（默认 false，opt-in 即 S1→S2）。 */
export const PAYSWAP_OPT_IN_OPTION = "financialWorkspace";

/**
 * 插件自有 env 命名空间。manifest `mcpServers.*.env` 注入的是插件子进程 env（经
 * `${user_config.*}` 解析），属插件自有变量——命名跟随既有官方插件先例
 * （`ANDROID_PLUGIN_SDK_PATH` / `IOS_SIM_DEFAULT_DEVICE`），不适用 CLI `AGENTS.md`
 * 面向**项目自有**（宿主进程）变量的 `ZCODE_` 前缀规则。本插件新增 env 键必须落在此
 * 命名空间内（契约测试机械校验 manifest）。
 */
export const PAYSWAP_ENV_NAMESPACE = "PAYSWAP_";

/** opt-in 经 manifest env 注入的键（`${user_config.financialWorkspace}` 的注入目标）。 */
export const PAYSWAP_FINANCIAL_WORKSPACE_ENV = "PAYSWAP_FINANCIAL_WORKSPACE";

export interface PayswapPluginContract {
  /** 构建保证产出的文件，相对插件根目录。 */
  outputs: typeof PAYSWAP_PLUGIN_OUTPUTS;
  /** MCP server 注册的六个工具名。 */
  tools: readonly string[];
  /** ui.surfaces[] 声明的信息性表面 id。 */
  surfaces: readonly string[];
  /** opt-in 布尔选项名（默认 false）。 */
  optInOption: string;
}
