import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpAdapter } from "../src/mcp/index.js";

/**
 * MCP stdio 子进程生命周期观察者（host 侧 spawn 接线的通用钩子 —— PaySwap broker
 * 实例注册/tombstone 的数据源；adapters 层保持 payswap 无关）。
 *
 * 语义：stdio server 连接成功（pid 已知）→ onStarted(serverName, config, pid)；
 * 连接关闭（意外 onclose 或主动 closeClientAndTransport）→ onClosed(serverName, config, pid)。
 * 只对 stdio 生效；HTTP/SSE server 不触发。
 */

describe("MCP stdio process observer", () => {
  const cleanupRoots = new Set<string>();

  afterEach(async () => {
    for (const root of cleanupRoots) {
      await rm(root, { force: true, recursive: true });
    }
    cleanupRoots.clear();
  });

  it(
    "fires onStarted with (serverName, config, pid) on connect and onClosed on adapter close",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-mcp-observer-"));
      cleanupRoots.add(root);
      const serverPath = join(root, "server.mjs");
      const mcpServerModule = import.meta.resolve("@modelcontextprotocol/server");
      const stdioServerTransportModule = import.meta.resolve("@modelcontextprotocol/server/stdio");
      await writeFile(
        serverPath,
        [
          "import { writeFileSync } from 'node:fs';",
          `import { McpServer } from ${JSON.stringify(mcpServerModule)};`,
          `import { StdioServerTransport } from ${JSON.stringify(stdioServerTransportModule)};`,
          "writeFileSync(process.env.OBSERVER_SERVER_PID_FILE, String(process.pid));",
          "const server = new McpServer({ name: 'observer-test', version: '1.0.0' });",
          "server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));",
          "await server.connect(new StdioServerTransport());",
        ].join("\n"),
      );
      const pidFile = join(root, "server.pid");
      const started: Array<{ serverName: string; pid: number; configEnv?: Record<string, string> }> = [];
      const closed: Array<{ serverName: string; pid: number }> = [];
      const adapter = createMcpAdapter({
        stdioProcessObserver: {
          onStarted(serverName, config, pid) {
            started.push({
              serverName,
              pid,
              configEnv: (config as { env?: Record<string, string> }).env,
            });
          },
          onClosed(serverName, _config, pid) {
            closed.push({ serverName, pid });
          },
        },
      });
      try {
        const config = {
          type: "stdio" as const,
          command: process.execPath,
          args: [serverPath],
          env: { OBSERVER_SERVER_PID_FILE: pidFile },
        };
        await adapter.connectServer("observer-server", config);
        expect(started.length).toBe(1);
        expect(started[0].serverName).toBe("observer-server");
        expect(started[0].configEnv?.OBSERVER_SERVER_PID_FILE).toBe(pidFile);
        expect(Number.isInteger(started[0].pid) && started[0].pid > 0).toBe(true);
        expect(closed).toEqual([]);
        await adapter.close();
        expect(closed.length).toBe(1);
        expect(closed[0]).toEqual({ serverName: "observer-server", pid: started[0].pid });
      } finally {
        try {
          await adapter.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
    20000,
  );
});
