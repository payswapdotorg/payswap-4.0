/**
 * ADR-P2-3 W1（round 3 item 2）—— 桌面侧 custodian 装配与桥操作在「攻击者赢得
 * first-alive 注册竞态」状态下的 typed fail-closed 法则（CI 可复现面；服务边界
 * 事实由 custodian-service-probe.cjs 的 w1:* 检查在原生 Windows 上钉死，二者
 * 合成完整回归 —— helper 客户端退出码契约是两者的接合面）。
 *
 * 被测法则（custodianClient.ts 文件头法则 + ADR §A0.5 item 2「赢者响亮」）：
 * 1. **攻击者在册 → 装配 register 被拒（exit 70）→ 显式 inactive
 *    register-refused** —— 无桥注入；账户层以 typed `custodian_unavailable`
 *    拒绝（services 侧 refusing-port 法则，payswap-custodian-fail-closed.test.ts
 *    已钉）；绝不静默 legacy 回退。
 * 2. **装配词汇完备**：endpoint 缺席 / helper 缺失 / 服务不可达（71）/
 *    register 被拒（70）—— 每个原因都是显式 inactive（无 undefined 形态）。
 * 3. **攻击者在册时的数据操作**：exit 70 → 恰一次全门 re-register 重试 → 仍拒
 *    = typed `custodian_unavailable`（push/drop 上抛；get = status 0 +
 *    body "custodian-unavailable"，读面语义 unavailable 而非崩溃）。
 * 4. **恢复路径**：数据操作 exit 70 → re-register 成功（攻击者退出后的 rebind）
 *    → 数据操作恰重试一次并成功（文档化恢复；门依旧全核验 —— 重试走同一
 *    register 命令，非放松）。
 * 5. **协议诚实**：ok:false / 畸形应答（helper exit 72）= typed
 *    `custodian_unavailable` —— 绝不把未证实结局伪装成功。
 * 6. **秘密纪律**：push 的密钥只经 stdin —— argv 绝不带秘密（调用记录断言）。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPayswapCustodianUnavailableError, setDataBaseDir } from "@zcode/services/node";
import { isPayswapCustodianUnavailableError } from "@zcode/shared/payswap";
import { provisionDesktopCustodianBridge } from "../src/main/payswap/custodianClient.js";

const createdDirs: string[] = [];

afterAll(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

let dataDir: string;
let endpointFile: string;
let helperPath: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "payswap-w1-provision-"));
  createdDirs.push(dataDir);
  setDataBaseDir(dataDir);
  // 测试缝（console 探针同纪律）：注入私有端点文件 —— 绝不触碰生产端点。
  endpointFile = join(dataDir, "custodian-endpoint.json");
  await writeFile(
    endpointFile,
    JSON.stringify({ pipe: "payswap-w1-provision-test", token: "t".repeat(64) }),
    "utf8",
  );
  // helper 路径注入：指向本 node 可执行（存在即可；runClient 是注入的假体 ——
  // 绝不真实 spawn、绝不依赖 gitignored 的 staged 产物 —— 跨平台 CI 可复现）。
  helperPath = process.execPath;
});

interface RecordedCall {
  helperPath: string;
  args: string[];
  stdin?: string;
}

/** 按命令脚本应答的 runClient 假体：记录每次调用，按序弹出退出码/应答。 */
function scriptedRunClient(
  script: Array<{ matchArgs: string[]; exitCode: number; stdout?: string; stderr?: string }>,
) {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const run = (
    helperPath: string,
    args: string[],
    options?: { stdin?: string },
  ) => {
    calls.push({ helperPath, args, ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) });
    const entry = script[cursor];
    cursor += 1;
    if (entry === undefined) {
      throw new Error("script exhausted — unexpected extra helper invocation: " + args.join(" "));
    }
    expect(args.slice(2)).toEqual(entry.matchArgs);
    return { exitCode: entry.exitCode, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" };
  };
  return { run, calls };
}

const REGISTER_ARGS = ["--custodian-register"];
const PUSH_ARGS = ["--custodian-push"];
const GET_ARGS = ["--custodian-get", "--path", "/v1/balance"];
const DROP_ARGS = ["--custodian-drop"];

const GATE_REFUSED_STDERR = "custodian_client:gate-refused";
const UNREACHABLE_STDERR = "custodian_client:service-unreachable";

describe("W1: desktop custodian provisioning under an attacker-won registration race", () => {
  it("register refused (exit 70, attacker holds the registration) → inactive register-refused, no bridge", () => {
    const { run, calls } = scriptedRunClient([
      { matchArgs: REGISTER_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
    ]);
    const provisioning = provisionDesktopCustodianBridge({ runClient: run, endpointFile, helperPath });
    expect(provisioning.state).toBe("inactive");
    if (provisioning.state !== "inactive") throw new Error("unreachable");
    expect(provisioning.reason).toBe("register-refused");
    expect(provisioning.detail).toContain(GATE_REFUSED_STDERR);
    expect("bridge" in provisioning).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("the provisioning vocabulary is explicit for every inactive reason (no undefined shape)", () => {
    const absent = provisionDesktopCustodianBridge({
      runClient: scriptedRunClient([]).run,
      endpointFile: join(dataDir, "no-such-endpoint.json"),
      helperPath,
    });
    expect(absent.state).toBe("inactive");
    expect(absent.state === "inactive" ? absent.reason : "").toBe("endpoint-absent");

    const { run } = scriptedRunClient([
      { matchArgs: REGISTER_ARGS, exitCode: 71, stderr: UNREACHABLE_STDERR },
    ]);
    const unreachable = provisionDesktopCustodianBridge({ runClient: run, endpointFile, helperPath });
    expect(unreachable.state).toBe("inactive");
    expect(unreachable.state === "inactive" ? unreachable.reason : "").toBe("service-unreachable");
  });
});

describe("W1: active bridge data operations while the attacker holds the registration", () => {
  function provisionActiveBridge(
    dataOpScript: Array<{ matchArgs: string[]; exitCode: number; stdout?: string; stderr?: string }>,
  ) {
    const { run, calls } = scriptedRunClient([
      { matchArgs: REGISTER_ARGS, exitCode: 0, stdout: '{"v":1,"ok":true,"registered":1234}' },
      ...dataOpScript,
    ]);
    const provisioning = provisionDesktopCustodianBridge({ runClient: run, endpointFile, helperPath });
    if (provisioning.state !== "active") throw new Error("provisioning must be active for this law");
    return { bridge: provisioning.bridge, calls };
  }

  it("push refused after one full-gate re-register retry → typed custodian_unavailable (no silent attacker-channel success)", async () => {
    const { bridge, calls } = provisionActiveBridge([
      { matchArgs: PUSH_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
      { matchArgs: REGISTER_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
    ]);
    const key = "rk_w1_vitest_push_" + "a".repeat(60);
    await expect(bridge.push(key)).rejects.toSatisfy(isPayswapCustodianUnavailableError);
    expect(calls).toHaveLength(3);
    expect(calls[1].args.slice(2)).toEqual(PUSH_ARGS);
    expect(calls[2].args.slice(2)).toEqual(REGISTER_ARGS);
    // 秘密纪律：密钥只经 stdin（无换行修饰），argv 绝不带秘密。
    expect(calls[1].stdin).toBe(key);
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain(key);
    }
  });

  it("get refused after one full-gate re-register retry → status 0 body custodian-unavailable (read face = unavailable, not a crash)", async () => {
    const { bridge, calls } = provisionActiveBridge([
      { matchArgs: GET_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
      { matchArgs: REGISTER_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
    ]);
    const result = await bridge.get("/v1/balance");
    expect(result).toEqual({ status: 0, body: "custodian-unavailable" });
    expect(calls).toHaveLength(3);
    expect(calls[1].args.slice(2)).toEqual(GET_ARGS);
    expect(calls[2].args.slice(2)).toEqual(REGISTER_ARGS);
  });

  it("drop refused after one full-gate re-register retry → typed custodian_unavailable (revocation never fakes success)", async () => {
    const { bridge, calls } = provisionActiveBridge([
      { matchArgs: DROP_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
      { matchArgs: REGISTER_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
    ]);
    await expect(bridge.drop()).rejects.toSatisfy(isPayswapCustodianUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it("documented recovery: op refused while the attacker holds → re-register succeeds once the attacker exits → op retried exactly once and succeeds", async () => {
    const { bridge, calls } = provisionActiveBridge([
      { matchArgs: PUSH_ARGS, exitCode: 70, stderr: GATE_REFUSED_STDERR },
      { matchArgs: REGISTER_ARGS, exitCode: 0, stdout: '{"v":1,"ok":true,"registered":1234}' },
      { matchArgs: PUSH_ARGS, exitCode: 0, stdout: '{"v":1,"ok":true}' },
    ]);
    await expect(bridge.push("rk_w1_vitest_recovery_" + "b".repeat(58))).resolves.toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(calls[1].args.slice(2)).toEqual(PUSH_ARGS);
    expect(calls[2].args.slice(2)).toEqual(REGISTER_ARGS);
    expect(calls[3].args.slice(2)).toEqual(PUSH_ARGS);
  });

  it("unconfirmed / protocol-failed outcomes are typed, never faked success (helper exit 72)", async () => {
    const { bridge } = provisionActiveBridge([
      { matchArgs: PUSH_ARGS, exitCode: 72, stdout: '{"v":1,"ok":false,"error":"persist-failed"}' },
    ]);
    await expect(bridge.push("rk_w1_vitest_unconfirmed_" + "c".repeat(56))).rejects.toSatisfy(
      isPayswapCustodianUnavailableError,
    );
  });

  it("the typed error carries the exact custodian_unavailable code consumed by the connection UI", async () => {
    const error = createPayswapCustodianUnavailableError("probe");
    expect(error.code).toBe("custodian_unavailable");
    expect(isPayswapCustodianUnavailableError(error)).toBe(true);
  });
});
