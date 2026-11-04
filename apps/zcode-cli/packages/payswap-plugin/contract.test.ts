import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PAYSWAP_ENV_NAMESPACE,
  PAYSWAP_FINANCIAL_WORKSPACE_ENV,
  PAYSWAP_OPT_IN_OPTION,
  PAYSWAP_PLUGIN_OUTPUTS,
} from "./contract.ts";
import { exampleOfficialPayswapPlugin } from "./contract.example.ts";
import { payswapPluginModule } from "./module.ts";

// 契约测试只 import contract 与 module，不知道实现是谁。
describe("payswap-plugin contract", () => {
  it("declares its module manifest", () => {
    expect(payswapPluginModule.id).toBe("payswap-plugin");
  });

  it("guarantees the outputs the official seed requires", () => {
    expect(PAYSWAP_PLUGIN_OUTPUTS).toEqual([".zcode-plugin/plugin.json", "dist/server.mjs"]);
  });

  it("registers exactly six tools and three Class-A surfaces behind the opt-in", () => {
    const { tools, surfaces, optInOption } = exampleOfficialPayswapPlugin();
    expect(tools).toHaveLength(6);
    expect(surfaces).toEqual(["workspace", "route-plan", "evidence"]);
    expect(optInOption).toBe(PAYSWAP_OPT_IN_OPTION);
    // authorization 卡是 Class B（host 渲染）——永不作为插件表面声明（N25）。
    expect(surfaces).not.toContain(expect.stringMatching(/authoriz|approv|grant/i));
  });

  it("keeps every manifest-injected env key inside the PAYSWAP_ namespace", () => {
    expect(PAYSWAP_FINANCIAL_WORKSPACE_ENV.startsWith(PAYSWAP_ENV_NAMESPACE)).toBe(true);
    // manifest 是 env 注入的载体：所有 mcpServers.*.env 键必须落在插件自有命名空间。
    // （CLI AGENTS.md 的 ZCODE_ 前缀规则约束项目自有宿主变量，不覆盖插件子进程注入——
    // 先例：ANDROID_PLUGIN_* / IOS_SIM_*。）
    const root = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(root, ".zcode-plugin", "plugin.json"), "utf8"),
    ) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
    const keys = Object.values(manifest.mcpServers ?? {}).flatMap(
      (server) => Object.keys(server.env ?? {}),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith(PAYSWAP_ENV_NAMESPACE), `env key "${key}" must be namespaced`).toBe(
        true,
      );
    }
  });
});
