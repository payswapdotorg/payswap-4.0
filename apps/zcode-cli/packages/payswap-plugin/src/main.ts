import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPayswapServer } from "./server.ts";

// 官方插件宿主通过导出的 main 启动；导入时直接连接会被宿主判定为无效入口
// （与 office-runtime main.ts 相同的启动纪律）。
export async function main(): Promise<void> {
  const server = createPayswapServer();
  let stopping = false;
  async function close(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  }
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  process.stdin.once("end", () => void close());
  await server.connect(new StdioServerTransport());
}

// 保留独立 Node 进程直接启动的用法（本地调试：`node dist/server.mjs`）。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
