import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // packages/server 自有测试入口（与 apps/zcode-cli/vitest.config.ts 同式）：
    // 不从 cwd 向上解析根配置 —— 根配置的 projects 相对路径以根 cwd 解析，
    // 从包目录启动会错位。根 engineering 工程（scripts/engineering-test-files.json）
    // 仍按根入口运行本包既有 tsupConfig 行；本配置只服务包内入口。
    include: ["test/**/*.test.ts"],
  },
});
