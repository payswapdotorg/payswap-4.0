/**
 * ADR-P2-3 custodian 桥的桌面 main 侧实现（helper 客户端 spawn 封装）。
 *
 * 法则（normative；违反即实现缺陷）：
 *   - 密钥只经 stdin 进托管（`--custodian-push`，可选 `--slot <名>` —— v1.1
 *     命名槽：槽名 = 凭据存储键；缺省 = 旧版单槽，wire 行为逐字不变）——
 *     argv/env 永不带秘密（槽名不是秘密：providerId + 随机连接 id + 种类）；
 *   - 有界只读代理 GET（`--custodian-get --path`，可选 `--slot`）—— 路径闭集
 *     在服务端强制；缺省槽 = 旧版单槽；
 *   - revoke 清托管（`--custodian-drop`，可选 `--slot`）—— 失败必须上抛
 *     （撤销不谎报成功）；
 *   - 注册（`--custodian-register`）自报父 pid —— 父 = electron main（本进程
 *     spawn）；服务端以内核事实核验映像 + 父链。
 *   - **fail-closed**（ADR-P2-3 A3）：托管不可用 = 显式 inactive 状态 + typed
 *     `custodian_unavailable` 错误 —— 绝不静默回退 legacy 凭据存储。活性判定
 *     不是端点文件存在（陈旧文件 ≠ 服务存活），而是注册握手的成功（管道 +
 *     token + 门全过 —— 服务真活着的内核证据）。
 *
 * helper 客户端退出码契约（Program.cs CustodianClient）：
 *   0 = 成功（stdout = reply JSON）；70 = 门拒绝（EOF 无应答）；71 = 服务不可达
 *   （端点缺席/管道连接失败）；72 = 协议失败（畸形/缺失应答）；1 = 用法错误。
 *   push/drop/register 以 reply `ok:true` 为成功 —— 服务端 push 已含「写 blob →
 *   回读验证 → 才应答」的持久纪律，客户端绝不为 ok:false 谎报成功。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getAppConfigDir } from "@zcode/services/node";
import {
  createPayswapCustodianUnavailableError,
  type PayswapCustodianBridge,
} from "@zcode/services/node";
import { PAYSWAP_BROKER_HELPER_PATH_ENV_KEY } from "@zcode/shared/payswap";
import { resolvePayswapBrokerPeerHelperSupply } from "./brokerPeerHelperSupply.js";

/** 服务的端点文件（服务启动即写；SYSTEM + 当前用户 RW —— 与管道 DACL 同面）。 */
const CUSTODIAN_ENDPOINT_FILE = "C:\\ProgramData\\payswap\\custodian-endpoint.json";
const CLIENT_TIMEOUT_MS = 45_000;

/** helper 客户端稳定退出码（与 Program.cs 契约逐字对应）。
 *  0=成功；70=门拒；71=服务不可达；72=协议失败/未证实；其它=spawn 超时/内部
 *  错误 —— 桥面把一切非零统一映射 typed custodian_unavailable（A5/F3 收口）。 */
const EXIT_GATE_REFUSED = 70;
const EXIT_SERVICE_UNREACHABLE = 71;

function resolveHelperPath(): string | null {
  const supply = resolvePayswapBrokerPeerHelperSupply();
  const helperPath = supply[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY];
  return helperPath !== undefined && existsSync(helperPath) ? helperPath : null;
}

function v2Root(): string {
  return getAppConfigDir();
}

export interface CustodianClientResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** v1.1 命名槽的 argv 面（槽名 = 凭据存储键 —— 非秘密：provider + 随机连接 id + 种类）。 */
export type CustodianClientSlotArg = { readonly slot?: string };

/** spawnSync 封装（超时 = 45s 上限；windowsHide；stderr 只含稳定码）。 */
function runClient(
  helperPath: string,
  args: string[],
  options?: { stdin?: string },
): CustodianClientResult {
  const result = spawnSync(helperPath, args, {
    encoding: "utf8",
    timeout: CLIENT_TIMEOUT_MS,
    ...(options?.stdin !== undefined ? { input: options.stdin } : {}),
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 槽 argv（缺省 = 旧版单槽 —— 不加任何参数，wire 行为逐字不变）。 */
function slotArgs(slot?: string): string[] {
  return slot !== undefined && slot.length > 0 ? ["--slot", slot] : [];
}

type ClientReply = { ok?: boolean; registered?: number; status?: number; body?: string };

/** 解析 helper 的 stdout reply（畸形 = 协议失败）。 */
function parseReply(stdout: string): ClientReply {
  try {
    return JSON.parse(stdout) as ClientReply;
  } catch {
    throw new Error("custodian: malformed reply from helper client");
  }
}

/**
 * ADR-P2-3 托管装配结果（fail-closed 词汇 —— 无「undefined = 静默 legacy」形态）：
 * active = 注册握手成功（管道 + token + 映像/父链门全过）；inactive = 显式原因。
 */
export type DesktopCustodianProvisioning =
  | { state: "active"; bridge: PayswapCustodianBridge }
  | {
      state: "inactive";
      reason:
        | "endpoint-absent"
        | "helper-unavailable"
        | "service-unreachable"
        | "register-refused";
      detail: string;
    };

/** 数据操作 + 一次注册重试的共用执行器（服务重启后注册失效的恢复路径 —— 门
 *  依旧全核验，绝不放松）：exit 70（门拒）→ re-register → 重试恰一次 → 仍拒
 *  = typed 错误上抛。 */
function executeDataOp(
  helperPath: string,
  clientArgs: (extra: string[]) => string[],
  run: typeof runClient,
  opArgs: string[],
  options?: { stdin?: string },
): CustodianClientResult {
  const attempt = run(helperPath, clientArgs(opArgs), options);
  if (attempt.exitCode !== EXIT_GATE_REFUSED) return attempt;
  // 一次注册重试（服务重启 → 注册丢失；register = 全门注册，非放松）。
  const reRegister = run(helperPath, clientArgs(["--custodian-register"]));
  if (reRegister.exitCode !== 0) return attempt;
  return run(helperPath, clientArgs(opArgs), options);
}

/**
 * 构造 custodian 桥（fail-closed 词汇：托管缺席/门拒 = 显式 inactive 或 typed
 * 错误 —— 调用方不存在「undefined → legacy 回退」分支）。注册在装配时恰一次
 *（自报父 pid = electron main；映像/父链门在服务端以内核事实核验）。
 * 测试缝（与 runClient 同族、helper 客户端的 --endpoint-file console 缝同纪律）：
 * endpointFile / helperPath 可注入 —— 生产缺省恒为 CUSTODIAN_ENDPOINT_FILE 与
 * 真实供给解析（不变；隔离测试绝不触碰生产端点文件、也绝不依赖 staged 产物）。
 * v1.1：push/drop/get 接受可选槽名（凭据存储键）—— 缺省 = 旧版单槽。
 */
export function provisionDesktopCustodianBridge(
  options?: {
    runClient?: typeof runClient;
    endpointFile?: string;
    helperPath?: string;
  },
): DesktopCustodianProvisioning {
  const run = options?.runClient ?? runClient;
  const endpointFile = options?.endpointFile ?? CUSTODIAN_ENDPOINT_FILE;
  if (!existsSync(endpointFile)) {
    return {
      state: "inactive",
      reason: "endpoint-absent",
      detail: "custodian endpoint file is absent (service not installed or not running)",
    };
  }
  const helperPath = options?.helperPath ?? resolveHelperPath();
  if (helperPath === null) {
    return {
      state: "inactive",
      reason: "helper-unavailable",
      detail: "custodian helper binary is unavailable",
    };
  }
  const v2 = getAppConfigDir();
  const clientArgs = (extra: string[]): string[] => ["--v2", v2, ...extra];
  const registration = run(helperPath, clientArgs(["--custodian-register"]));
  if (registration.exitCode === EXIT_SERVICE_UNREACHABLE) {
    return {
      state: "inactive",
      reason: "service-unreachable",
      detail: "custodian pipe did not accept a registration (service not running)",
    };
  }
  if (registration.exitCode !== 0) {
    return {
      state: "inactive",
      reason: "register-refused",
      detail:
        "custodian registration was refused (identity gate); reason=" +
        registration.stderr.trim(),
    };
  }
  const bridge: PayswapCustodianBridge = {
    async push(key: string, slot?: string): Promise<void> {
      const attempt = executeDataOp(
        helperPath,
        clientArgs,
        run,
        ["--custodian-push", ...slotArgs(slot)],
        { stdin: key },
      );
      if (attempt.exitCode !== 0) {
        // A5/F3 税法收口：任何非零退出（门拒 70 / 不可达 71 / 协议失败 72 /
        // spawn 超时或 helper 内部错误）一律映射 typed custodian_unavailable
        // —— 绝不把非 0/70/71/72 的结局掉进通用 malformed-reply 词汇。
        throw createPayswapCustodianUnavailableError(
          "custodian push failed (exit=" + attempt.exitCode + " reason=" + attempt.stderr.trim() + ")",
        );
      }
      const reply = parseReply(attempt.stdout);
      if (reply.ok !== true) {
        throw createPayswapCustodianUnavailableError(
          "custodian push was not confirmed by the service (ok:false)",
        );
      }
    },
    async get(path: string, slot?: string): Promise<{ status: number; body: string }> {
      const attempt = executeDataOp(helperPath, clientArgs, run, [
        "--custodian-get",
        "--path",
        path,
        ...slotArgs(slot),
      ]);
      if (attempt.exitCode !== 0) {
        // 传输面失败 → status 0（runtime 映射 502 → adapter typed unavailable），
        // 不上抛：读面语义 = unavailable，不是崩溃。
        return { status: 0, body: "custodian-unavailable" };
      }
      const reply = parseReply(attempt.stdout);
      return { status: reply.status ?? 0, body: reply.body ?? "" };
    },
    async drop(slot?: string): Promise<void> {
      const attempt = executeDataOp(
        helperPath,
        clientArgs,
        run,
        ["--custodian-drop", ...slotArgs(slot)],
      );
      if (attempt.exitCode !== 0) {
        // A5/F3 同款收口：非零退出一律 typed（撤销不谎报成功）。
        throw createPayswapCustodianUnavailableError(
          "custodian drop failed (exit=" + attempt.exitCode + " reason=" + attempt.stderr.trim() + ")",
        );
      }
      const reply = parseReply(attempt.stdout);
      if (reply.ok !== true) {
        throw createPayswapCustodianUnavailableError(
          "custodian drop was not confirmed by the service (ok:false)",
        );
      }
    },
  };
  return { state: "active", bridge };
}

/** 服务的安装/卸载 CLI（elevated 一次性操作经 UAC 提权运行本 helper 的模式）。 */
export function custodianServiceInstall(electronImage: string, clientHelperPath?: string): void {
  const helperPath = resolveHelperPath();
  if (helperPath === null) throw new Error("custodian: helper binary unavailable");
  const args = ["--svc-install", "--image", electronImage];
  // 客户端 helper = main 将 spawn 的 bundled-tools 之二进制（服务端核验其精确
  // 映像 —— 门事实与客户端事实同源）。
  if (clientHelperPath !== undefined) args.push("--client-helper", clientHelperPath);
  spawnSync(helperPath, args, { stdio: "inherit", windowsHide: true });
}

export function custodianServiceUninstall(): void {
  const helperPath = resolveHelperPath();
  if (helperPath === null) throw new Error("custodian: helper binary unavailable");
  spawnSync(helperPath, ["--svc-uninstall"], { stdio: "inherit", windowsHide: true });
}

export const custodianEndpointFile = CUSTODIAN_ENDPOINT_FILE;
