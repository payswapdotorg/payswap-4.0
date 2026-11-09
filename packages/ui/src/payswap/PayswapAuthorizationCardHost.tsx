/**
 * PaySwap Class-B 授权卡（addendum §1.6.0 —— host-rendered authorization card；
 * ADR-12 D12.7 ——「the desktop card component」lands with the desktop Browser E2E
 * arm）。
 *
 * 法则（normative）：
 * - **Class B 渲染纪律**：本组件是 permission-prompt 投影模式的新成员 —— payload 是
 *   host 计算的类型化数据（`payswapAuthorizationCardPayloadSchema`），renderer 按数据
 *   渲染，**不使用**任何插件/工具自报 display 位；每个展示值都来自 host 的 proposal
 *   记录（§1.6.0 的「有意 delta」）。
 * - **challenge 骑卡**：一次性 challenge 只存在于 host↔本组件层（§1.6.2 item 1）；
 *   点击 approve/deny 时随结构化事件回传 —— 组件不解释、不缓存到其它面。
 * - **卡面消除的权威在 main**：dismissed 推送（T7 item 3 / N18 / 决议后）是撤卡的
 *   单一来源；本地 approved/denied 返回值只做冗余移除（幂等 —— pending 的权威在
 *   host，渲染层永不自行下卡/上卡）。
 * - **malformed 推送 fail-closed**：schema 校验失败的 payload 直接丢弃（不渲染）。
 * - 仅桌面平台有桥（platform.onPayswapCard）；无桥/无平台 → 不渲染（web 无卡面）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
// 浏览器安全路径：卡 payload schema 只依赖 zod —— 从精确子路径导入，绝不经
// "@zcode/shared/payswap" 桶入口（桶内 broker/identity 模块有模块级 Buffer/node
// 用法，会拖死浏览器 renderer 的 chunk 求值）。
import {
  payswapAuthorizationCardPayloadSchema,
  type PayswapAuthorizationCardPayload,
} from "@zcode/shared/payswap-approval-card";
import type { PayswapDesktopCardEvent } from "@zcode/shared/payswap";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface PendingCard {
  payload: PayswapAuthorizationCardPayload;
}

export function PayswapAuthorizationCardHost(): React.ReactNode {
  const platform = useOptionalPlatform();
  const [cards, setCards] = useState<Map<string, PendingCard>>(() => new Map());

  useEffect(() => {
    if (!platform?.onPayswapCard) return;
    return platform.onPayswapCard((event: PayswapDesktopCardEvent) => {
      if (!event || typeof event !== "object") return;
      if (event.kind === "payswap-card-issued") {
        const parsed = payswapAuthorizationCardPayloadSchema.safeParse(event.payload);
        if (!parsed.success) return; // fail-closed：malformed 推送不渲染。
        setCards((prev) => {
          const next = new Map(prev);
          next.set(parsed.data.proposalId, { payload: parsed.data });
          return next;
        });
      } else if (event.kind === "payswap-card-dismissed") {
        setCards((prev) => {
          if (!prev.has(event.proposalId)) return prev;
          const next = new Map(prev);
          next.delete(event.proposalId);
          return next;
        });
      }
    });
  }, [platform]);

  const resolve = useCallback(
    async (payload: PayswapAuthorizationCardPayload, decision: "approve" | "deny") => {
      try {
        const verdict = await platform?.payswapResolveApproval?.({
          proposalId: payload.proposalId,
          challengeId: payload.challenge.challengeId,
          challengeSecret: payload.challenge.secret,
          decision,
        });
        // dismissed 推送是权威；这里只做冗余移除（approved/denied → 卡已完成使命）。
        if (
          verdict &&
          typeof verdict === "object" &&
          "status" in verdict &&
          (verdict.status === "approved" || verdict.status === "denied")
        ) {
          setCards((prev) => {
            if (!prev.has(payload.proposalId)) return prev;
            const next = new Map(prev);
            next.delete(payload.proposalId);
            return next;
          });
        }
      } catch {
        // IPC 失败不撤卡 —— pending 的权威在 main；推送会同步真实状态。
      }
    },
    [platform],
  );

  if (cards.size === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[380px] flex-col gap-2">
      {[...cards.values()].map(({ payload }) => (
        <PayswapAuthorizationCard key={payload.proposalId} payload={payload} onResolve={resolve} />
      ))}
    </div>
  );
}

function PayswapAuthorizationCard({
  payload,
  onResolve,
}: {
  payload: PayswapAuthorizationCardPayload;
  onResolve: (payload: PayswapAuthorizationCardPayload, decision: "approve" | "deny") => void;
}): React.ReactNode {
  const { intl } = useZCodeIntl();
  const busyRef = useRef(false);
  const approveLabel =
    payload.options.find((option) => option.optionId === "approve")?.label ?? "Approve";
  const denyLabel = payload.options.find((option) => option.optionId === "deny")?.label ?? "Deny";

  const handleClick = (decision: "approve" | "deny") => {
    if (busyRef.current) return; // 单发：一次性 challenge 不接受连击。
    busyRef.current = true;
    onResolve(payload, decision);
  };

  return (
    <section
      data-testid="payswap-authorization-card"
      className="pointer-events-auto rounded-xl border border-border bg-surface p-4 shadow-lg"
      aria-live="polite"
      aria-label={intl.formatMessage({ id: "payswap.card.title" })}
    >
      <h2 className="text-ui-base font-semibold text-foreground">
        {intl.formatMessage({ id: "payswap.card.title" })}
      </h2>
      {/* host 计算的摘要行（permission-prompt 的 summary 同位 —— 内容 origin = host）。 */}
      <p data-testid="payswap-card-summary" className="mt-1 text-ui-sm text-foreground">
        {payload.summary}
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-sm">
        <dt className="text-foreground-subtle">{intl.formatMessage({ id: "payswap.card.amount" })}</dt>
        <dd data-testid="payswap-card-amount" className="font-semibold text-foreground">
          {payload.authorization.amount.value} {payload.authorization.amount.currency}
        </dd>
        <dt className="text-foreground-subtle">
          {intl.formatMessage({ id: "payswap.card.recipient" })}
        </dt>
        <dd className="truncate text-foreground">
          {payload.authorization.recipient.recipientId}
        </dd>
        <dt className="text-foreground-subtle">{intl.formatMessage({ id: "payswap.card.purpose" })}</dt>
        <dd className="truncate text-foreground">{payload.authorization.purpose}</dd>
        <dt className="text-foreground-subtle">{intl.formatMessage({ id: "payswap.card.fees" })}</dt>
        <dd className="text-foreground">
          {payload.authorization.fees.maxTotalFees} {payload.authorization.amount.currency}
        </dd>
      </dl>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid="payswap-card-deny"
          onClick={() => {
            handleClick("deny");
          }}
        >
          {denyLabel}
        </Button>
        <Button
          type="button"
          variant="default"
          data-testid="payswap-card-approve"
          onClick={() => {
            handleClick("approve");
          }}
        >
          {approveLabel}
        </Button>
      </div>
    </section>
  );
}
