import { describe, expect, it } from "vitest";
import { PAYSWAP_OPT_IN_OPTION, PAYSWAP_PLUGIN_OUTPUTS } from "./contract.ts";
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
});
