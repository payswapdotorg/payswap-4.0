/**
 * ADR-P2-3 custodian 桥的桌面 main 侧实现（helper 客户端 spawn 封装）。
 *
 * 法则（ADR-P2-3 §2 Layer 2）：
 *   - 密钥只经 stdin 进托管（`--custodian-push`）—— argv/env 永不带秘密；
 *   - 有界只读代理 GET（`--custodian-get --path`）—— 路径闭集在服务端强制；
 *   - revoke 清托管（`--custodian-drop`）；
 *   - 注册（`--custodian-register`）自报父 pid —— 父 = electron main（本进程 spawn）。
 *
 * 活性判定 = 服务端点文件存在（服务启动即写；缺席 = 未安装/未运行 → bridge 未启用，
 * 走既有直接路径）。全部 helper 调用经 spawnSync —— 调用频率 = 四类别 + 读回，
 * main 线程阻塞面有界（服务端 30s 超时 + 客户端 45s 上限）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getAppConfigDir } from "@zcode/services/node";
import { PAYSWAP_BROKER_HELPER_PATH_ENV_KEY } from "@zcode/shared/payswap";
import { resolvePayswapBrokerPeerHelperSupply } from "./brokerPeerHelperSupply.js";
import type { PayswapCustodianBridge } from "@zcode/services/node";

/** 服务的端点文件（服务启动即写；SYSTEM + 当前用户 RW —— 与管道 DACL 同面）。 */
const CUSTODIAN_ENDPOINT_FILE = "C:\\ProgramData\\payswap\\custodian-endpoint.json";
const CLIENT_TIMEOUT_MS = 45_000;

function resolveHelperPath(): string | null {
  const supply = resolvePayswapBrokerPeerHelperSupply();
  const helperPath = supply[PAYSWAP_BROKER_HELPER_PATH_ENV_KEY];
  return helperPath !== undefined && existsSync(helperPath) ? helperPath : null;
}

function v2Root(): string {
  return getAppConfigDir();
}

function runClient(args: string[], options?: { stdin?: string }): string {
  const helperPath = resolveHelperPath();
  if (helperPath === null) throw new Error("custodian: helper binary unavailable");
  const result = execFileSync(helperPath, args, {
    encoding: "utf8",
    timeout: CLIENT_TIMEOUT_MS,
    ...(options?.stdin !== undefined ? { input: options.stdin } : {}),
    windowsHide: true,
  });
  return result;
}

function parseReply(stdout: string): { status: number; body: string } {
  const reply = JSON.parse(stdout) as { status?: number; body?: string };
  return { status: reply.status ?? 0, body: reply.body ?? "" };
}

/** 活性判定（每调用一次 stat；服务未安装/未运行 → false → bridge 不启用）。 */
export function isCustodianActive(): boolean {
  return existsSync(CUSTODIAN_ENDPOINT_FILE);
}

/**
 * 构造 custodian 桥（活性缺席 → undefined = 既有直接路径不变，fail-safe 不变）。
 * 注册在构造时恰一次（自报父 pid = electron main；映像门在服务端核验）。
 */
export function createDesktopCustodianBridge(): PayswapCustodianBridge | undefined {
  if (!isCustodianActive()) return undefined;
  const helperPath = resolveHelperPath();
  if (helperPath === null) return undefined;
  const v2 = getAppConfigDir();
  const clientArgs = (extra: string[]): string[] => ["--v2", v2, ...extra];
  try {
    runClient(clientArgs(["--custodian-register"]));
  } catch {
    return undefined; // 注册失败（服务缺席/门拒）→ fail-safe 既有路径
  }
  return {
    async push(key: string): Promise<void> {
      runClient(clientArgs(["--custodian-push"]), { stdin: key });
    },
    async get(path: string): Promise<{ status: number; body: string }> {
      return parseReply(runClient(clientArgs(["--custodian-get", "--path", path])));
    },
    async drop(): Promise<void> {
      runClient(clientArgs(["--custodian-drop"]));
    },
  };
}

/** 服务的安装/卸载 CLI（elevated 一次性操作经 UAC 提权运行本 helper 的模式）。 */
export function custodianServiceInstall(electronImage: string): void {
  const helperPath = resolveHelperPath();
  if (helperPath === null) throw new Error("custodian: helper binary unavailable");
  spawnSync(helperPath, ["--svc-install", "--image", electronImage], {
    stdio: "inherit",
    windowsHide: true,
  });
}

export function custodianServiceUninstall(): void {
  const helperPath = resolveHelperPath();
  if (helperPath === null) throw new Error("custodian: helper binary unavailable");
  spawnSync(helperPath, ["--svc-uninstall"], { stdio: "inherit", windowsHide: true });
}

export const custodianEndpointFile = CUSTODIAN_ENDPOINT_FILE;