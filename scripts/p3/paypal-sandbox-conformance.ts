/**
 * PaySwap P3 —— PayPal sandbox conformance run（provider-facts/paypal.md
 * 「Consequence in source」记录的开放步：回答 ⚠ 项 2 —— own-account scope
 * 授予问题，并记录 sandbox 实测的值形状/状态码证据）。
 *
 * 纪律（与读回/数据读 adapter 同款）：
 * - **零真实秘密入库/入日志**：凭据只经环境变量入（PAYPAL_SANDBOX_CLIENT_ID /
 *   PAYPAL_SANDBOX_CLIENT_SECRET）；access_token 只进内存与请求头；报告只记录
 *   非秘密摘要（HTTP 状态、字段名形状、金额/货币值、scope 授予清单、id 形状）。
 * - **零 provider 写**：一次 token mint（POST /v1/oauth2/token，P-1）+ 三个
 *   GET（balances / transactions / disputes，P-7/P-8/P-9）+ customers 类别
 *   （预期 typed unsupported_operation —— 不触网）。本脚本永不调用任何写端点。
 * - **证据带日期**：报告头记录运行时刻（UTC）与目标环境（sandbox 固定）。
 * - **如实记录**：任何非预期状态/形状原样记录为 DRIFT 或 UNEXPECTED，不猜测。
 *
 * 运行（需要操作员自备 sandbox app 凭据 —— developer dashboard 的 Default
 * Application 即可）：
 *   PAYPAL_SANDBOX_CLIENT_ID=... PAYPAL_SANDBOX_CLIENT_SECRET=... \
 *     bun scripts/p3/paypal-sandbox-conformance.ts
 */

const BASE_URL = "https://api-m.sandbox.paypal.com";
const RUN_AT = new Date().toISOString();

interface StepReport {
  readonly step: string;
  readonly request: string;
  readonly httpStatus: number | "transport-error";
  readonly outcome: string;
  readonly observed: Record<string, unknown>;
}

const reports: StepReport[] = [];

function redact(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? "<present>" : "<absent>";
}

async function run(): Promise<void> {
  const clientId = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error(
      "Refused: PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_CLIENT_SECRET must be supplied via env " +
        "(real sandbox app credentials from the PayPal developer dashboard).",
    );
    process.exit(2);
  }

  // ---- Step 1: token mint（P-1/P-4）—— read-back 语义的现场证据 ----
  let accessToken: string | null = null;
  {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
    } catch (error) {
      reports.push({
        step: "token-mint",
        request: "POST /v1/oauth2/token",
        httpStatus: "transport-error",
        outcome: "UNAVAILABLE (transport error — unknown, not an auth verdict)",
        observed: { error: error instanceof Error ? error.message : String(error) },
      });
      finish(1);
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    const raw = (body ?? {}) as Record<string, unknown>;
    if (response.status === 200 && typeof raw.access_token === "string") {
      accessToken = raw.access_token;
    }
    reports.push({
      step: "token-mint",
      request: "POST /v1/oauth2/token",
      httpStatus: response.status,
      outcome:
        response.status === 200
          ? "VERIFIED (mint ok — app_id present: " +
            (typeof raw.app_id === "string" && raw.app_id.length > 0 ? "yes" : "NO — DRIFT vs P-18") +
            ")"
          : response.status === 401
            ? "AUTH-FAILED (401 — the live envelope answers the credential question; P-4)"
            : "UNAVAILABLE (non-200/401 — unknown, not an auth verdict)",
      observed: {
        app_id: typeof raw.app_id === "string" ? `${raw.app_id.slice(0, 8)}…(shape)` : redact(raw.app_id),
        scope_granted: typeof raw.scope === "string" ? raw.scope.split(/\s+/).sort() : null,
        expires_in_reported: typeof raw.expires_in === "number" ? raw.expires_in : null,
        error_code: typeof raw.error === "string" ? raw.error : null,
        token: redact(raw.access_token),
      },
    });
    if (accessToken === null) {
      finish(0);
      return;
    }
  }

  // ---- Step 2-4: 三类别只读数据面（P-7/P-8/P-9）----
  const reads: Array<{ category: string; path: string; container: string }> = [
    { category: "balance", path: "/v1/reporting/balances", container: "balances" },
    {
      category: "payment_objects",
      path: `/v1/reporting/transactions?start_date=${encodeURIComponent(
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      )}&end_date=${encodeURIComponent(
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      )}&page_size=10`,
      container: "transaction_details",
    },
    { category: "disputes", path: "/v1/customer/disputes", container: "items" },
  ];
  for (const read of reads) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${read.path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (error) {
      reports.push({
        step: `read:${read.category}`,
        request: `GET ${read.path.split("?")[0]}`,
        httpStatus: "transport-error",
        outcome: "UNAVAILABLE (transport error)",
        observed: { error: error instanceof Error ? error.message : String(error) },
      });
      continue;
    }
    const body: unknown = await response.json().catch(() => null);
    const raw = (body ?? {}) as Record<string, unknown>;
    const container = raw[read.container];
    const outcome =
      response.status === 200
        ? Array.isArray(container)
          ? `OK (${(container as unknown[]).length} rows; field shapes recorded below)`
          : "UNAVAILABLE (200 but the documented container is absent — DRIFT vs P-21/P-22/P-23)"
        : response.status === 401 || response.status === 403
          ? `REFUSED insufficient_permission (HTTP ${response.status} with a fresh mint — answers the scope-grantability question)`
          : `UNAVAILABLE (HTTP ${response.status})`;
    reports.push({
      step: `read:${read.category}`,
      request: `GET ${read.path.split("?")[0]}`,
      httpStatus: response.status,
      outcome,
      observed: summarizeRows(read.category, container),
    });
  }

  // ---- Step 5: customers —— 预期 typed unsupported_operation（不触网）----
  reports.push({
    step: "read:customers",
    request: "(no wire — PayPal's verified read plane has no customer-list surface)",
    httpStatus: "n/a",
    outcome: "REFUSED unsupported_operation (by construction — the adapter never wires this category)",
    observed: {},
  });

  finish(0);
}

/** 行形状摘要（非秘密）：字段名在场性 + 金额/日期样本形状。 */
function summarizeRows(category: string, container: unknown): Record<string, unknown> {
  if (!Array.isArray(container) || container.length === 0) {
    return { rows: 0, note: "empty or non-array container" };
  }
  const first = container[0] as Record<string, unknown>;
  if (category === "balance") {
    const row = first as Record<string, unknown>;
    return {
      rows: container.length,
      row_fields: Object.keys(row).sort(),
      available_balance: moneyShape(row.available_balance),
      withheld_balance: moneyShape(row.withheld_balance),
    };
  }
  if (category === "payment_objects") {
    const info = (first.transaction_info ?? {}) as Record<string, unknown>;
    return {
      rows: container.length,
      transaction_info_fields: Object.keys(info).sort(),
      transaction_amount: moneyShape(info.transaction_amount),
      transaction_initiation_date: typeof info.transaction_initiation_date === "string" ? info.transaction_initiation_date : null,
      transaction_status: info.transaction_status ?? null,
    };
  }
  return {
    rows: container.length,
    dispute_info_fields: Object.keys(first).sort(),
    dispute_amount: moneyShape(first.dispute_amount),
    create_time: typeof first.create_time === "string" ? first.create_time : null,
    status: first.status ?? null,
  };
}

function moneyShape(money: unknown): Record<string, unknown> | null {
  if (typeof money !== "object" || money === null) return null;
  const { currency_code, value } = money as Record<string, unknown>;
  return {
    currency_code: currency_code ?? null,
    value_shape: typeof value === "string" ? (/^-?\d+$/.test(value) ? "integer-string" : /^-?\d+\.\d+$/.test(value) ? "decimal-string" : "other") : typeof value,
    value: value ?? null,
  };
}

function finish(exitCode: number): void {
  const lines = [
    "# PaySwap P3 — PayPal sandbox conformance run",
    `run_at_utc: ${RUN_AT}`,
    `target: ${BASE_URL} (sandbox — P-3)`,
    "credential_source: env (never logged; access_token in-memory only)",
    "no_provider_writes: one token mint + three GETs only",
    "",
  ];
  for (const report of reports) {
    lines.push(`## ${report.step}`);
    lines.push(`- request: ${report.request}`);
    lines.push(`- http: ${String(report.httpStatus)}`);
    lines.push(`- outcome: ${report.outcome}`);
    lines.push(`- observed: ${JSON.stringify(report.observed)}`);
    lines.push("");
  }
  console.log(lines.join("\n"));
  process.exit(exitCode);
}

run().catch((error: unknown) => {
  console.error(`conformance run crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
