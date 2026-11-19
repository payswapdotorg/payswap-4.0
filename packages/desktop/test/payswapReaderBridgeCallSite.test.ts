/**
 * TL review §3-B 回归保护（调用点层）—— reader 桥铸造器必须落在 spawnHostProcess 的
 * **第 5 参（SpawnHostProcessOptions）**，而不是第 4 参（dependencies）。
 *
 * 2026-11-18 live 缺陷：minter 的条件 spread 曾被写进第 4 参对象（字段不在其类型里，
 * 运行期被静默丢弃）→ 端口从未转移 → 中继永不 live → reader 缺席 →
 * get_account_overview 恒 not_connected。`buildPayswapReaderBridgeSpawnOptions`
 * 的单测钉住了构造契约；本 battery 用 TypeScript AST 钉住**调用点结构**：
 *  (1) 窗口 host 的 spawnHostProcess 调用 ≥ 5 个顶层实参；
 *  (2) 第 5 实参（SpawnHostProcessOptions，含 taskRealtime）携带
 *      buildPayswapReaderBridgeSpawnOptions 的展开；
 *  (3) 第 4 实参（dependencies，含 hostProcessLocalEnv）不再携带铸造器字段。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const testsDir = dirname(fileURLToPath(import.meta.url));
const indexPath = join(testsDir, "..", "src", "main", "index.ts");
const source = readFileSync(indexPath, "utf8");
const sourceFile = ts.createSourceFile(indexPath, source, ts.ScriptTarget.Latest, true);

function findWindowHostSpawnCall(): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText(sourceFile);
      if (exprText === "spawnHostProcess" && node.arguments.length >= 5) {
        const arg3 = node.arguments[2]?.getText(sourceFile) ?? "";
        const arg4 = node.arguments[3]?.getText(sourceFile) ?? "";
        // 窗口 host 调用点的特征：initMessage 带 browserBackendIdentity 展开与
        // zcodeBuiltinProviderConfigFilePath；dependencies 带 hostProcessLocalEnv。
        if (arg3.includes("browserBackendIdentity") && arg4.includes("hostProcessLocalEnv")) {
          found = node;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

describe("reader-bridge minter call-site contract (TL review §3-B, source law)", () => {
  const call = findWindowHostSpawnCall();

  it("the window-host spawnHostProcess call site exists with >= 5 top-level arguments", () => {
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.arguments.length).toBeGreaterThanOrEqual(5);
  });

  it("the FIFTH argument (SpawnHostProcessOptions) carries the minter via buildPayswapReaderBridgeSpawnOptions", () => {
    expect(call).toBeDefined();
    if (!call) return;
    const optionsText = call.arguments[4].getText(sourceFile);
    expect(optionsText).toContain("taskRealtime");
    expect(optionsText).toContain("buildPayswapReaderBridgeSpawnOptions(");
  });

  it("the FOURTH argument (dependencies) no longer carries the minter field (the 2026-11-18 defect shape)", () => {
    expect(call).toBeDefined();
    if (!call) return;
    const depsText = call.arguments[3].getText(sourceFile);
    expect(depsText).toContain("hostProcessLocalEnv");
    expect(depsText).not.toContain("mintPayswapReaderBridgePort");
    expect(depsText).not.toContain("buildPayswapReaderBridgeSpawnOptions");
  });
});
