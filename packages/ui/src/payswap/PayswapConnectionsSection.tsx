/**
 * PaySwap P2.2 slice 8 —— platform-shell 连接/onboarding UI（ADR-P2-2 Decision 4
 * 的 renderer 半；roadmap P2 行「platform-shell connection/onboarding UI」；Gate E2
 * E2E 条款「typed error surfaced in the connection UI」的呈现宿主）。
 *
 * 法则（normative；违反即实现缺陷）：
 * 1. **响应闭集直消费**：一切呈现消费 RPC 响应闭集（ok:true per-op 结果联合 /
 *    ok:false 通道码）—— 经 connectionUiPresentation 的呈现函数分流，UI 不自造
 *    状态文案；`unauthorized_origin` 不达 renderer（三检先于载荷解析）。
 * 2. **typed refusal 按 code 呈现**（account-connection 法则 5 的 UI 半）：拒绝与
 *    通道失败按 code 分流到 i18n key，永不匹配 message —— 呈现法则住
 *    connectionUiPresentation.ts（电池 payswap-connection-ui-presentation）。
 * 3. **operatorSecret 单向性**：秘密只在 connect 请求上行（renderer → main 是它
 *    的唯一必经边界 —— ADR-P2-2 Decision 4）；提交后即清空输入（不复显、不回填、
 *    不入任何 notice/日志/列表状态）；一切响应形状结构上无秘密位（法则级
 *    redaction —— 渲染层拿不到也存不下秘密）。
 * 4. **投影行只呈现五行投影**：连接列表只消费状态投影（connectionId/providerId/
 *    mode/displayName/status —— doc 05 §5「only opaque connection status」）。
 * 5. **无桥不渲染**：仅桌面平台有 payswapConnectionRpc（preload 桥）；无桥 =
 *    不可用说明（web/远控无连接面），不渲染表单。
 */

import { useCallback, useEffect, useRef, useState } from "react";
// 浏览器安全路径：类型经 type-only 导入（编译期擦除 —— 桶内 node:crypto 模块不进
// 浏览器 chunk，与授权卡的 `import type { PayswapDesktopCardEvent }` 同款纪律）。
import type {
  PayswapConnectionRpcResponse,
  PayswapConnectionStatusProjection,
} from "@zcode/shared/payswap";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  payswapConnectionModeI18nKey,
  payswapConnectionStatusI18nKey,
  payswapConnectionStatusTone,
  presentPayswapConnectResponse,
  presentPayswapRefreshResponse,
  presentPayswapRevokeResponse,
  type PayswapConnectionNotice,
} from "@/payswap/connectionUiPresentation.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";

/**
 * P2/P3 的 provider 集与各自 acquisition 形态（doc 04 §1.1 + provider-facts）：
 * stripe = P2 operator-supplied-secret（单秘密）；paypal = P3 client-credentials
 * （mode + clientId + clientSecret —— 恰一完整形态，superRefine 强制）。
 */
const PAYSWAP_CONNECT_PROVIDERS = [
  { providerId: "stripe", labelKey: "payswap.connections.provider.stripe", acquisition: "operator-secret" },
  { providerId: "paypal", labelKey: "payswap.connections.provider.paypal", acquisition: "client-credentials" },
] as const;

function acquisitionOf(providerId: string): "operator-secret" | "client-credentials" {
  return (
    PAYSWAP_CONNECT_PROVIDERS.find((provider) => provider.providerId === providerId)?.acquisition ??
    "operator-secret"
  );
}

const STATUS_TONE_TO_DOT: Record<"positive" | "warning" | "muted", StatusDotTone> = {
  positive: "green",
  warning: "amber",
  muted: "subtle",
};

/** notice tone → 横幅视觉（positive=成功、warning=可操作、danger=硬失败、muted=终态）。 */
const NOTICE_TONE_CLASS: Record<PayswapConnectionNotice["tone"], string> = {
  positive: "border-green-500/40 bg-green-500/5 text-foreground",
  warning: "border-yellow-500/40 bg-yellow-500/5 text-foreground",
  danger: "border-red-500/40 bg-red-500/5 text-foreground",
  muted: "border-border bg-surface text-foreground",
};

/** 最小形状防御（主侧 per-op 法则已校验；这里只防渲染层自身崩溃）。 */
function isConnectionRow(value: unknown): value is PayswapConnectionStatusProjection {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PayswapConnectionStatusProjection).connectionId === "string" &&
    typeof (value as PayswapConnectionStatusProjection).displayName === "string"
  );
}

function rowsFromListResponse(response: PayswapConnectionRpcResponse): PayswapConnectionStatusProjection[] {
  if (!response.ok || response.op !== "list" || !Array.isArray(response.result)) return [];
  return response.result.filter(isConnectionRow);
}

export function PayswapConnectionsSection(): React.ReactNode {
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const rpc = platform?.payswapConnectionRpc;

  const [providerId, setProviderId] = useState<string>(PAYSWAP_CONNECT_PROVIDERS[0].providerId);
  const [operatorSecret, setOperatorSecret] = useState("");
  const [mode, setMode] = useState<"test" | "live">("test");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<PayswapConnectionNotice | null>(null);
  const [rows, setRows] = useState<PayswapConnectionStatusProjection[] | null>(null);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshList = useCallback(async () => {
    if (!rpc) return;
    try {
      const response = await rpc({ op: "list" });
      if (!mountedRef.current) return;
      setRows(rowsFromListResponse(response));
    } catch {
      // IPC 层异常（法则外）：列表保持已加载值；从未加载过则标记为空（列表面不可用
      // 不阻断连接表单 —— 连接操作的 notice 面会呈现通道错误）。
      if (mountedRef.current) setRows((previous) => previous ?? []);
    }
  }, [rpc]);

  useEffect(() => {
    void refreshList();
    // 首载一次；rpc 面变化（平台切换）时重读。
  }, [refreshList]);

  const handleConnect = useCallback(async () => {
    if (!rpc || connecting) return;
    const isClientCredentials = acquisitionOf(providerId) === "client-credentials";
    const trimmedClientId = clientId.trim();
    const trimmedClientSecret = clientSecret.trim();
    const secret = operatorSecret.trim();
    if (isClientCredentials ? !trimmedClientId || !trimmedClientSecret : !secret) return;
    setConnecting(true);
    // 法则 3：秘密单发 —— 提交即清空（client-credentials 形态的 clientId+clientSecret
    // 与 operator-secret 形态的 operatorSecret 同律；mode 是环境声明、非秘密，保留）。
    setOperatorSecret("");
    setClientId("");
    setClientSecret("");
    try {
      const trimmedDisplayName = displayName.trim();
      const request = isClientCredentials
        ? trimmedDisplayName
          ? {
              op: "connect" as const,
              providerId,
              mode,
              clientId: trimmedClientId,
              clientSecret: trimmedClientSecret,
              displayName: trimmedDisplayName,
            }
          : {
              op: "connect" as const,
              providerId,
              mode,
              clientId: trimmedClientId,
              clientSecret: trimmedClientSecret,
            }
        : trimmedDisplayName
          ? { op: "connect" as const, providerId, operatorSecret: secret, displayName: trimmedDisplayName }
          : { op: "connect" as const, providerId, operatorSecret: secret };
      const response = await rpc(request);
      if (!mountedRef.current) return;
      setNotice(presentPayswapConnectResponse(response));
      await refreshList();
    } catch {
      if (mountedRef.current) {
        // IPC 层异常按通道内部错误呈现（fail-safe 文案，不裸抛）。
        setNotice(presentPayswapConnectResponse({ ok: false, code: "internal_error", message: "" }));
      }
    } finally {
      if (mountedRef.current) setConnecting(false);
    }
  }, [rpc, connecting, providerId, mode, operatorSecret, clientId, clientSecret, displayName, refreshList]);

  const handleRowAction = useCallback(
    async (connectionId: string, action: "refresh" | "revoke") => {
      if (!rpc || busyConnectionId !== null) return;
      setBusyConnectionId(connectionId);
      try {
        const response =
          action === "refresh"
            ? await rpc({ op: "refresh", connectionId })
            : await rpc({ op: "revoke", connectionId });
        if (!mountedRef.current) return;
        setNotice(
          action === "refresh"
            ? presentPayswapRefreshResponse(response)
            : presentPayswapRevokeResponse(response),
        );
        await refreshList();
      } catch {
        if (mountedRef.current) {
          setNotice(presentPayswapConnectResponse({ ok: false, code: "internal_error", message: "" }));
        }
      } finally {
        if (mountedRef.current) setBusyConnectionId(null);
      }
    },
    [rpc, busyConnectionId, refreshList],
  );

  if (!rpc) {
    return (
      <div data-testid="payswap-connections-unavailable" className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "payswap.connections.unavailable" })}
      </div>
    );
  }

  return (
    <div data-testid="payswap-connections-section" className="space-y-6">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "payswap.connections.description" })}
      </p>

      <SettingsGroupCard>
        <div className="border-b border-border px-4 py-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "payswap.connections.connect" })}
        </div>
        <div className="space-y-1">
          <SettingsRow
            label={intl.formatMessage({ id: "payswap.connections.providerLabel" })}
            control={
              <select
                data-testid="payswap-connect-provider"
                aria-label={intl.formatMessage({ id: "payswap.connections.providerLabel" })}
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-panel px-3 text-ui-sm text-foreground"
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                {PAYSWAP_CONNECT_PROVIDERS.map((provider) => (
                  <option key={provider.providerId} value={provider.providerId}>
                    {intl.formatMessage({ id: provider.labelKey })}
                  </option>
                ))}
              </select>
            }
          />
          {acquisitionOf(providerId) === "client-credentials" ? (
            <>
              <SettingsRow
                label={intl.formatMessage({ id: "payswap.connections.modeLabel" })}
                control={
                  <select
                    data-testid="payswap-connect-mode"
                    aria-label={intl.formatMessage({ id: "payswap.connections.modeLabel" })}
                    className="h-9 min-w-0 flex-1 rounded-md border border-border bg-panel px-3 text-ui-sm text-foreground"
                    value={mode}
                    onChange={(event) => setMode(event.target.value === "live" ? "live" : "test")}
                  >
                    <option value="test">{intl.formatMessage({ id: "payswap.connections.mode.test" })}</option>
                    <option value="live">{intl.formatMessage({ id: "payswap.connections.mode.live" })}</option>
                  </select>
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "payswap.connections.clientIdLabel" })}
                controlLayout="wide"
                control={
                  <Input
                    id="payswap-connect-client-id"
                    data-testid="payswap-connect-client-id"
                    type="text"
                    spellCheck={false}
                    placeholder={intl.formatMessage({ id: "payswap.connections.clientIdPlaceholder" })}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "payswap.connections.clientSecretLabel" })}
                description={intl.formatMessage({ id: "payswap.connections.clientSecretHint" })}
                controlLayout="wide"
                control={
                  <Input
                    id="payswap-connect-client-secret"
                    data-testid="payswap-connect-client-secret"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={intl.formatMessage({ id: "payswap.connections.clientSecretPlaceholder" })}
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleConnect();
                    }}
                  />
                }
              />
            </>
          ) : (
            <SettingsRow
              label={intl.formatMessage({ id: "payswap.connections.secretLabel" })}
              description={intl.formatMessage({ id: "payswap.connections.secretHint" })}
              controlLayout="wide"
              control={
                <Input
                  id="payswap-connect-secret"
                  data-testid="payswap-connect-secret"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={intl.formatMessage({ id: "payswap.connections.secretPlaceholder" })}
                  value={operatorSecret}
                  onChange={(event) => setOperatorSecret(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleConnect();
                  }}
                />
              }
            />
          )}
          <SettingsRow
            label={intl.formatMessage({ id: "payswap.connections.displayNameLabel" })}
            controlLayout="wide"
            control={
              <Input
                id="payswap-connect-display-name"
                data-testid="payswap-connect-display-name"
                type="text"
                maxLength={120}
                placeholder={intl.formatMessage({ id: "payswap.connections.displayNamePlaceholder" })}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            }
          />
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <Button
              type="button"
              data-testid="payswap-connect-submit"
              disabled={
                connecting ||
                (acquisitionOf(providerId) === "client-credentials"
                  ? clientId.trim().length === 0 || clientSecret.trim().length === 0
                  : operatorSecret.trim().length === 0)
              }
              onClick={() => void handleConnect()}
            >
              {intl.formatMessage({
                id: connecting ? "payswap.connections.connecting" : "payswap.connections.connect",
              })}
            </Button>
          </div>
        </div>
      </SettingsGroupCard>

      {notice !== null && (
        <div
          data-testid="payswap-connection-notice"
          data-notice-key={notice.i18nKey}
          data-notice-code={notice.code ?? ""}
          data-notice-tone={notice.tone}
          role="status"
          aria-live="polite"
          className={`rounded-lg border px-4 py-3 text-ui-sm ${NOTICE_TONE_CLASS[notice.tone]}`}
        >
          <span>{intl.formatMessage({ id: notice.i18nKey })}</span>
          {notice.detail !== undefined && (
            <span data-testid="payswap-connection-notice-detail" className="ml-2 font-mono text-ui-sm">
              {notice.detail}
            </span>
          )}
        </div>
      )}

      <SettingsGroupCard>
        <div className="border-b border-border px-4 py-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "payswap.connections.listTitle" })}
        </div>
        <div data-testid="payswap-connection-list" className="px-4 py-3">
          {rows === null ? (
            <div data-testid="payswap-connection-list-loading" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "payswap.connections.listLoading" })}
            </div>
          ) : rows.length === 0 ? (
            <div data-testid="payswap-connection-list-empty" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "payswap.connections.listEmpty" })}
            </div>
          ) : (
            <table className="w-full text-ui-sm">
              <thead>
                <tr className="text-left text-foreground-subtle">
                  <th className="py-1.5 pr-3 font-medium">
                    {intl.formatMessage({ id: "payswap.connections.columnName" })}
                  </th>
                  <th className="py-1.5 pr-3 font-medium">
                    {intl.formatMessage({ id: "payswap.connections.columnProvider" })}
                  </th>
                  <th className="py-1.5 pr-3 font-medium">
                    {intl.formatMessage({ id: "payswap.connections.columnMode" })}
                  </th>
                  <th className="py-1.5 pr-3 font-medium">
                    {intl.formatMessage({ id: "payswap.connections.columnStatus" })}
                  </th>
                  <th className="py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "payswap.connections.columnActions" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const statusTone = payswapConnectionStatusTone(row.status);
                  const rowBusy = busyConnectionId === row.connectionId;
                  return (
                    <tr
                      key={row.connectionId}
                      data-testid="payswap-connection-row"
                      data-connection-id={row.connectionId}
                      data-connection-status={row.status}
                    >
                      <td className="py-1.5 pr-3 text-foreground">
                        <span data-testid="payswap-connection-name">{row.displayName}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-foreground-subtle">{row.providerId}</td>
                      <td className="py-1.5 pr-3">
                        <span
                          data-testid="payswap-connection-mode"
                          data-mode={row.mode}
                          className="rounded-md bg-surface px-2 py-0.5 text-ui-sm text-foreground-subtle"
                        >
                          {intl.formatMessage({ id: payswapConnectionModeI18nKey(row.mode) })}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">
                        <span
                          data-testid="payswap-connection-status"
                          data-status={row.status}
                          className="inline-flex items-center gap-1.5 text-foreground"
                        >
                          <StatusDot tone={STATUS_TONE_TO_DOT[statusTone]} />
                          {intl.formatMessage({ id: payswapConnectionStatusI18nKey(row.status) })}
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        <span className="inline-flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="payswap-connection-refresh"
                            disabled={rowBusy || busyConnectionId !== null}
                            onClick={() => void handleRowAction(row.connectionId, "refresh")}
                          >
                            {intl.formatMessage({ id: "payswap.connections.actionRefresh" })}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid="payswap-connection-revoke"
                            disabled={rowBusy || busyConnectionId !== null}
                            onClick={() => void handleRowAction(row.connectionId, "revoke")}
                          >
                            {intl.formatMessage({ id: "payswap.connections.actionRevoke" })}
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </SettingsGroupCard>
    </div>
  );
}
