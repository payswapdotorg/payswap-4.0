/**
 * PaySwap P1.8 —— Gate E3：受控 provider-authorization Browser 流（addendum §5.3；
 * playbook P1.8 work package「Browser authorization and preservation」的 E3 切片）。
 *
 * 法则（normative，addendum §5.3 原文三条款）：
 * - **条款 1（模型臂）**：「**Model-controlled** navigation/API access to PSP API hosts
 *   in financial contexts is denied — the model never needs direct PSP HTTP access;
 *   that is what the adapters are for.」金融模式开（S2 —— 与 E1/broker 同一
 *   isPayswapFinancialModeActive 投影）时，模型控制的 navigate 到 PSP API host
 *   一律拒绝；URL 不可解析 = 无法证明非 PSP host → fail-closed 拒绝。
 * - **条款 2（host-initiated 臂）**：「**Host-initiated provider flows** (OAuth
 *   redirect, dashboard onboarding) navigate only to a per-provider allowlist of
 *   official authorization hosts, driven by the host account service (deliverable
 *   05 §5 authSpec), never by model-supplied URLs.」—— allowlist，不是 blocklist；
 *   空白名单 = 全拒（approval-origin 空受信集同款 fail-closed）。
 * - **条款 3（保真臂）**：「**Non-PSP domains:** Browser behavior completely
 *   unchanged (preservation matrix, deliverable 02).」金融模式关 = 与上游完全一致
 *   （零回归，E1 §5.1 臂 1 同款）；开时非 PSP host 照常放行。
 *
 * 种子数据（evidence，非发明）：deliverable 04 §195 记录的 agent 侧网络工具 denylist ——
 * 「PaySwap needs the inverse (denylist) for api.stripe.com, api.paystack.co,
 * api-m.paypal.com in agent-driven fetch tools. Design flag for the TL: this
 * denylist is a P1 hardening item」+ §130「api-m.sandbox.paypal.com vs
 * api-m.paypal.com」。P2/P3 provider 接入按 dated-evidence 纪律扩表（数据驱动，
 * 非代码分支）。
 *
 * 范围边界（如实声明，与 E1 的 scope boundary 同款纪律）：
 * - 模型臂只判**携带 URL 的导航命令**（`navigate` —— BrowserCommand 面上唯一的导航
 *   命令）；playwright `waitForURL` 是等待谓词不是导航；`evaluate` 表达式内嵌 fetch
 *   的 URL 不在命令边界可寻址 —— P1 的门是导航面，表达式级拦截属 P2+ 桌面深度
 *   （届时配合 E2 的 PSP 凭据落地一并治理）。
 * - 条款 2 的法则与 authSpec 派生在本 PR 落地；驱动方（account service）是 P2 ——
 *   P1 无 host-initiated provider flow，空白名单全拒是正确的生产行为。
 * - authorization host（如 connect.stripe.com）不是 API host：模型臂的 denylist 是
 *   doc 04 §195 记录的 API host 集；authorization host 归条款 2 的 allowlist 管。
 *
 * 两级证明：
 * 1. 法则级（纯 shared browser-admission 模块）—— §5.3 决策表全行 + host 匹配纪律
 *    （精确等值、无后缀/子域传播、端口无关、userinfo 不参与、尾点 DNS 等价）+
 *    条款 2 allowlist 语义 + authSpec 派生。
 * 2. 边界级（真实 BrowserControlPort 包装 + 真实记录型内层端口）—— E3 验收行的
 *   工程测试形态（§5.3「Acceptance (P1): engineering tests for all three clauses;
 *   the existing Browser E2E battery stays green」）：
 *   「拒绝」在边界的形态 = typed `navigation_blocked` BrowserErrorCode（上游
 *   managed-browser URL 检查同码 —— `page-command.ts:136-143`）且内层端口不被
 *   调用（无上游 dispatch）；「unchanged」的形态 = 命令逐字节到达内层端口、结果
 *   原样返回、非导航命令零求值直通。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserControlPort,
  BrowserCommandResult,
} from "@zcode/contracts";
import {
  admitPayswapModelBrowserNavigation,
  admitPayswapProviderAuthorizationFlow,
  derivePayswapProviderAuthorizationHosts,
  PAYSWAP_SEED_PSP_PROVIDER_HOSTS,
} from "@zcode/shared/payswap";
import { wrapBrowserControlPortWithPayswapBrowserAdmission } from "../src/app/payswap-browser-admission.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 法则级：§5.3 决策表全行 + host 匹配纪律 + 条款 2 + 派生
// ---------------------------------------------------------------------------

describe("payswap browser admission (Gate E3) — law", () => {
  it("条款 3 + E1 臂 1：金融模式关 = 与上游完全一致（PSP / 非 PSP / 不可解析一律放行，零回归）", () => {
    for (const url of [
      "https://api.stripe.com/v1/balance",
      "https://api.paystack.co/transaction",
      "https://api-m.paypal.com/v1/payments",
      "https://api-m.sandbox.paypal.com/v1/payments",
      "https://example.com/docs",
      "not a url at all",
    ]) {
      expect(admitPayswapModelBrowserNavigation({ financialModeActive: false, url })).toEqual({
        admitted: true,
      });
    }
  });

  it("条款 1：金融模式开 + 种子 denylist 的全部四个 PSP API host 一律拒绝（typed code + host 回显）", () => {
    for (const [url, host] of [
      ["https://api.stripe.com/v1/balance", "api.stripe.com"],
      ["https://api.paystack.co/transaction", "api.paystack.co"],
      ["https://api-m.paypal.com/v1/payments", "api-m.paypal.com"],
      ["https://api-m.sandbox.paypal.com/v1/payments", "api-m.sandbox.paypal.com"],
    ] as const) {
      expect(admitPayswapModelBrowserNavigation({ financialModeActive: true, url })).toEqual({
        admitted: false,
        code: "psp_api_host_blocked",
        host,
      });
    }
  });

  it("条款 3：金融模式开 + 非 PSP host 照常放行（Browser 行为只按 host 分类变化）", () => {
    for (const url of [
      "https://example.com/docs",
      "https://docs.stripe.com/api", // authorization/文档 host 不是 API host（范围边界）
      "http://intranet.local:8080/report",
      "about:blank",
    ]) {
      expect(admitPayswapModelBrowserNavigation({ financialModeActive: true, url })).toEqual({
        admitted: true,
      });
    }
  });

  it("fail-closed：金融模式开 + URL 不可解析 = 无法证明非 PSP host → 拒绝（host: null）", () => {
    for (const url of ["not a url at all", "", "http://", "://missing-scheme.test/"]) {
      expect(admitPayswapModelBrowserNavigation({ financialModeActive: true, url })).toEqual({
        admitted: false,
        code: "psp_api_host_blocked",
        host: null,
      });
    }
  });

  it("精确 host 匹配纪律：后缀/前缀/子域陷阱一律不是该 host（无通配/无后缀/无子域传播）", () => {
    for (const url of [
      "https://api.stripe.com.evil.test/v1", // 完全不同域的后缀拼接
      "https://xapi.stripe.com/v1", // 前缀拼接（stripe.com 的其它子域不是 API host）
      "https://stripe.com/v1", // apex 不是 API host
      "https://api.paystack.co.uk/transaction", // 后缀拼接
      "https://evil-api.paypal.test/v1", // 无关域
    ]) {
      expect(admitPayswapModelBrowserNavigation({ financialModeActive: true, url })).toEqual({
        admitted: true,
      });
    }
  });

  it("规范化：大小写 / 尾点（DNS 等价）/ 端口 / userinfo 全部按 URL 语义处理", () => {
    // 大小写规范化。
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "HTTPS://API.STRIPE.COM/v1/balance",
      }),
    ).toEqual({ admitted: false, code: "psp_api_host_blocked", host: "api.stripe.com" });
    // 尾点 = 同一 host（DNS 等价），不得因尾点放行。
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "https://api.stripe.com./v1/balance",
      }),
    ).toEqual({ admitted: false, code: "psp_api_host_blocked", host: "api.stripe.com" });
    // 端口无关：非默认端口仍是该 host。
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "https://api.stripe.com:8443/v1/balance",
      }),
    ).toEqual({ admitted: false, code: "psp_api_host_blocked", host: "api.stripe.com" });
    // userinfo：目标 host 是 userinfo 之后的真 host。
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "https://evil.test@api.stripe.com/v1/balance",
      }),
    ).toEqual({ admitted: false, code: "psp_api_host_blocked", host: "api.stripe.com" });
    // 反向：api.stripe.com 作为 userinfo、evil.test 才是目标 → 不是 PSP host。
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "https://api.stripe.com@evil.test/v1/balance",
      }),
    ).toEqual({ admitted: true });
  });

  it("数据驱动：注入自定义 provider 记录门自定义 host；种子记录不受影响（P2 扩表入口）", () => {
    const records = [
      {
        providerId: "future-psp",
        apiHosts: ["api.future-psp.test"],
        authorizationHosts: ["connect.future-psp.test"],
      },
    ];
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "https://api.future-psp.test/v1",
        records,
      }),
    ).toEqual({ admitted: false, code: "psp_api_host_blocked", host: "api.future-psp.test" });
    // 种子 host 在自定义记录下不再被门（记录集整体替换，非叠加 —— 扩表方负责全集）。
    expect(
      admitPayswapModelBrowserNavigation({
        financialModeActive: true,
        url: "https://api.stripe.com/v1/balance",
        records,
      }),
    ).toEqual({ admitted: true });
  });

  it("条款 2：host-initiated 流只走该 provider 的授权 host 白名单 —— allowlist，不是 blocklist", () => {
    const allowlist = ["connect.stripe.com", "dashboard.stripe.com"];
    // 白名单内：放行。
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "https://connect.stripe.com/oauth/authorize?client_id=x",
        providerAuthorizationHosts: allowlist,
      }),
    ).toEqual({ admitted: true });
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "https://dashboard.stripe.com/settings/apikeys",
        providerAuthorizationHosts: allowlist,
      }),
    ).toEqual({ admitted: true });
    // 白名单外一律拒绝 —— 即便是 PSP API host（条款 1 的 denylist 语义不适用于此臂）。
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "https://api.stripe.com/v1/balance",
        providerAuthorizationHosts: allowlist,
      }),
    ).toEqual({ admitted: false, code: "authorization_host_not_allowed", host: "api.stripe.com" });
    // 其它 provider 的官方 host 也不行（per-provider 白名单）。
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "https://connect.other-psp.test/oauth",
        providerAuthorizationHosts: allowlist,
      }),
    ).toEqual({ admitted: false, code: "authorization_host_not_allowed", host: "connect.other-psp.test" });
    // 空 userinfo 欺骗：真目标是白名单外。
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "https://connect.stripe.com@evil.test/oauth",
        providerAuthorizationHosts: allowlist,
      }),
    ).toEqual({ admitted: false, code: "authorization_host_not_allowed", host: "evil.test" });
  });

  it("条款 2 fail-closed：空白名单 = 全拒（P1 无 provider flow 的正确生产行为）；不可解析 = 拒绝", () => {
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "https://connect.stripe.com/oauth",
        providerAuthorizationHosts: [],
      }),
    ).toEqual({ admitted: false, code: "authorization_host_not_allowed", host: "connect.stripe.com" });
    expect(
      admitPayswapProviderAuthorizationFlow({
        url: "not a url",
        providerAuthorizationHosts: ["connect.stripe.com"],
      }),
    ).toEqual({ admitted: false, code: "authorization_host_not_allowed", host: null });
  });

  it("authSpec 派生：authorizeUrl/tokenUrl/rotationUrl 的 host，规范化去重；不可解析 URL 跳过（白名单只窄不宽）", () => {
    expect(
      derivePayswapProviderAuthorizationHosts([
        "https://connect.stripe.com/oauth/authorize",
        "https://connect.stripe.com/oauth/token", // 同 host 去重
        "HTTPS://DASHBOARD.STRIPE.COM/settings", // 大小写规范化
        "https://dashboard.stripe.com./settings", // 尾点 DNS 等价去重
        "not a url", // 跳过（不可产生 host；缺失 = 白名单更窄 = fail-closed 方向）
      ]),
    ).toEqual(["connect.stripe.com", "dashboard.stripe.com"]);
    expect(derivePayswapProviderAuthorizationHosts([])).toEqual([]);
  });

  it("种子记录形状：三家 provider、API host 与 doc 04 §195 的 dated evidence 一致、authorizationHosts P1 为空", () => {
    expect(PAYSWAP_SEED_PSP_PROVIDER_HOSTS.map((record) => record.providerId)).toEqual([
      "stripe",
      "paystack",
      "paypal",
    ]);
    expect(
      PAYSWAP_SEED_PSP_PROVIDER_HOSTS.flatMap((record) => record.apiHosts).sort(),
    ).toEqual(
      ["api.stripe.com", "api.paystack.co", "api-m.paypal.com", "api-m.sandbox.paypal.com"].sort(),
    );
    // P1：无 host-initiated provider flow —— 空授权白名单（fail-closed 全拒）。
    expect(PAYSWAP_SEED_PSP_PROVIDER_HOSTS.every((record) => record.authorizationHosts.length === 0)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 边界级：真实包装 + 真实记录型内层端口（BrowserControlPort 生产边界）
// ---------------------------------------------------------------------------

interface RecordedCall {
  kind: "execute" | "list" | "turnEnded" | "closeSession";
  method?: string;
  command?: BrowserCommand;
  url?: string;
  signal?: AbortSignal;
}

function createRecordingPort(): {
  port: BrowserControlPort;
  calls: RecordedCall[];
  childCalls: RecordedCall[];
  resultFor: (command: BrowserCommand) => BrowserCommandResult;
} {
  const calls: RecordedCall[] = [];
  const childCalls: RecordedCall[] = [];
  const passThroughResult = (): BrowserCommandResult => ({
    ok: true,
    state: {
      url: "https://example.test/after",
      title: "Example",
      canGoBack: false,
      canGoForward: false,
    },
    elapsedMs: 7,
  });
  const execute = async (
    input: Parameters<BrowserControlPort["execute"]>[0],
    sink: RecordedCall[],
  ): Promise<BrowserCommandResult> => {
    sink.push({
      kind: "execute",
      method: input.command.method,
      command: input.command,
      signal: input.signal,
    });
    return passThroughResult();
  };
  const port: BrowserControlPort = {
    async list(input) {
      calls.push({ kind: "list" });
      return [] as BrowserBackendDescriptor[];
    },
    async execute(input) {
      return await execute(input, calls);
    },
    async turnEnded(input) {
      calls.push({ kind: "turnEnded" });
    },
    async closeSession(input) {
      calls.push({ kind: "closeSession" });
    },
    forChildSession(input) {
      const childPort: BrowserControlPort = {
        list: port.list,
        async execute(childInput) {
          return await execute(childInput, childCalls);
        },
        turnEnded: port.turnEnded,
        async closeSession(childInput) {
          childCalls.push({ kind: "closeSession" });
        },
      };
      return childPort;
    },
  };
  return { port, calls, childCalls, resultFor: () => passThroughResult() };
}

const BASE_EXECUTE_INPUT = {
  browserId: "cdp-local",
  browserGeneration: 1,
  sessionId: "sess-test",
  turnId: "turn-1",
};

describe("payswap browser admission (Gate E3) — boundary (wrapper over a real port)", () => {
  let tempWorkingDirectory: string;

  beforeAll(async () => {
    tempWorkingDirectory = await mkdtemp(join(tmpdir(), "payswap-e3-"));
  });

  afterAll(async () => {
    await rm(tempWorkingDirectory, { force: true, recursive: true });
  });

  it("条款 1：S2 + 模型 navigate 到 PSP API host → typed navigation_blocked 且内层端口不被调用", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => true,
    });
    const result = await wrapped.execute({
      ...BASE_EXECUTE_INPUT,
      command: { method: "navigate", url: "https://api.stripe.com/v1/balance" },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("navigation_blocked");
    expect(result.error?.message).toContain("api.stripe.com");
    expect(typeof result.elapsedMs).toBe("number");
    // 拒绝 = 无上游 dispatch：内层端口一条命令都没见到。
    expect(recorder.calls).toEqual([]);
  });

  it("条款 3 / E1 臂 1：金融模式关 + 同一 navigate → 命令逐字节到达内层端口，结果原样返回", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => false,
    });
    const command = { method: "navigate", url: "https://api.stripe.com/v1/balance" } as const;
    const result = await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
    expect(result).toEqual(recorder.resultFor(command));
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.command).toEqual(command);
  });

  it("条款 3：S2 + 非 PSP host 的 navigate 照常放行；内层收到原命令", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => true,
    });
    const command = { method: "navigate", url: "https://example.com/docs" } as const;
    const result = await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
    expect(result.ok).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.command).toEqual(command);
  });

  it("保真面：S2 下非导航命令零求值直通（getState / snapshot / click / evaluate / newTab / list）", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => true,
    });
    for (const command of [
      { method: "getState" },
      { method: "snapshot", maxElements: 100 },
      { method: "click", x: 10, y: 20 },
      { method: "evaluate", expression: "1 + 1" },
      { method: "newTab" },
      { method: "playwright", action: { name: "waitForURL", url: "https://api.stripe.com/x" } },
    ] as const) {
      const result = await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
      expect(result.ok).toBe(true);
    }
    expect(recorder.calls).toHaveLength(6);
    expect(recorder.calls.map((call) => call.method)).toEqual([
      "getState",
      "snapshot",
      "click",
      "evaluate",
      "newTab",
      "playwright",
    ]);
    // list / 生命周期方法同样直通。
    await wrapped.list({ sessionId: "sess-test" });
    await wrapped.turnEnded?.({ sessionId: "sess-test" });
    await wrapped.closeSession?.({ sessionId: "sess-test" });
    expect(recorder.calls.filter((call) => call.kind !== "execute")).toHaveLength(3);
  });

  it("live 读：同一包装实例，模式关→开随 config 翻转逐命令生效（T2 拒绝码即时翻转同款纪律）", async () => {
    const recorder = createRecordingPort();
    let financialMode = false;
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => financialMode,
    });
    const command = { method: "navigate", url: "https://api.paystack.co/transaction" } as const;
    // 关：放行（内层收到）。
    await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
    expect(recorder.calls).toHaveLength(1);
    // 开：拒绝（内层不再收到）。
    financialMode = true;
    const denied = await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("navigation_blocked");
    expect(recorder.calls).toHaveLength(1);
    // 再关：恢复放行。
    financialMode = false;
    await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
    expect(recorder.calls).toHaveLength(2);
  });

  it("子会话不得绕过：forChildSession 派生端口的 navigate 同样过门；非导航命令直通", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => true,
    });
    const childPort = wrapped.forChildSession?.({
      childSessionId: "child-1",
      parentSessionId: "sess-test",
    });
    expect(childPort).toBeDefined();
    // 子端口上的 PSP 导航：拒绝，且内层子端口未被调用。
    const denied = await childPort!.execute({
      ...BASE_EXECUTE_INPUT,
      sessionId: "child-1",
      command: { method: "navigate", url: "https://api-m.paypal.com/v1/payments" },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("navigation_blocked");
    expect(recorder.childCalls).toEqual([]);
    // 子端口上的非导航命令：直通内层子端口。
    const passed = await childPort!.execute({
      ...BASE_EXECUTE_INPUT,
      sessionId: "child-1",
      command: { method: "getState" },
    });
    expect(passed.ok).toBe(true);
    expect(recorder.childCalls).toHaveLength(1);
    // 子端口上的非 PSP 导航：直通。
    await childPort!.execute({
      ...BASE_EXECUTE_INPUT,
      sessionId: "child-1",
      command: { method: "navigate", url: "https://example.com/docs" },
    });
    expect(recorder.childCalls).toHaveLength(2);
    // 父端口不受派生影响。
    expect(recorder.calls).toEqual([]);
  });

  it("自定义 host 记录注入缝：P2 扩表入口在边界同样生效", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => true,
      providerHostRecords: [
        {
          providerId: "future-psp",
          apiHosts: ["api.future-psp.test"],
          authorizationHosts: [],
        },
      ],
    });
    const denied = await wrapped.execute({
      ...BASE_EXECUTE_INPUT,
      command: { method: "navigate", url: "https://api.future-psp.test/v1" },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("navigation_blocked");
    expect(recorder.calls).toEqual([]);
  });

  it("默认 reader（无注入）：真实 createConfig fresh 读 —— 无 PaySwap S2 的环境下 navigate 放行", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      workingDirectory: tempWorkingDirectory,
    });
    const command = { method: "navigate", url: "https://example.com/docs" } as const;
    const result = await wrapped.execute({ ...BASE_EXECUTE_INPUT, command });
    // 沙箱环境无 PaySwap S2 配置 → 模式关 → 与上游一致（默认接线真实读取，不是恒假）。
    expect(result.ok).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.command).toEqual(command);
  });

  it("abort 纪律：直通命令的 AbortSignal 原样到达内层端口（上游取消语义不变）", async () => {
    const recorder = createRecordingPort();
    const wrapped = wrapBrowserControlPortWithPayswapBrowserAdmission({
      port: recorder.port,
      readFinancialMode: () => false,
    });
    const controller = new AbortController();
    await wrapped.execute({
      ...BASE_EXECUTE_INPUT,
      command: { method: "navigate", url: "https://example.com/docs" },
      signal: controller.signal,
    });
    expect(recorder.calls[0]?.signal).toBe(controller.signal);
  });
});
