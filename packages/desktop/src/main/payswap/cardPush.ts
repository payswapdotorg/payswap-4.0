/**
 * PaySwap 桌面卡面推送（Class-B permission-prompt 投影模式的投递半；addendum
 * §1.6.0 —— host-rendered card，内容 origin = host）。
 *
 * 职责（法则住 shared-payswap；本模块是 desktop main 侧的推送装配）：
 * - **卡面投递**：issueProposal 成功 → `PAYSWAP_DESKTOP_CARD_CHANNEL` 定向发到
 *   proposal 的目标 webContents（§1.6.2 item 1：challenge 只发给该卡实例 —— 事件
 *   与批准解析同一窗口定向）。
 * - **卡面消除**：T7 item 3 / N18 —— pending 消失（revoke/invalidate/决议）时
 *   renderer 同步撤卡。消除事件广播到所有卡宿主（三检拒绝的不广播 —— 只有真实
 *   approved/denied 才撤卡），renderer 按 proposalId 匹配（结构化数据，卡内容
 *   不可伪造）。
 *
 * 产物是**完整 host 委托**（同型 `PayswapDesktopApprovalHost`）：四个状态变迁
 * 入口（issue/revoke/invalidate/resolve）注入推送，其余面（proposals/grants/
 * trustedAppOrigins/authorizeOperation）原样透传 —— 装配方把它作为 `host` 传给
 * `installPayswapDesktopApprovalIpc`，ipcMain.handle 因此绑定到带推送的解析入口
 * （安装闭包捕获的是本委托，approve 点击 → 三检 → dismissed 广播一条链）。
 *
 * 本模块不持业务状态（proposal/challenge/grant 全在 host）；只做事件搬运。
 * 推送失败（窗口已死/无监听）静默 —— IPC 是 fire-and-forget（renderer 的卡只是
 * 投影，pending 状态的权威在 host）。
 */

import type {
  PayswapDesktopApprovalHost,
  PayswapDesktopCardEvent,
} from "@zcode/shared/payswap";
import { PAYSWAP_DESKTOP_CARD_CHANNEL } from "@zcode/shared/payswap";

/** 推送端口（结构面 —— desktop main 注入 webContents.send / BrowserWindow 列表）。 */
export interface PayswapCardPushPort {
  /** 定向发（target 窗口 = proposal 的目标卡实例）。 */
  sendTo(webContentsId: number, event: PayswapDesktopCardEvent): void;
  /** 广播发（消除事件 —— 所有卡宿主按 proposalId 匹配）。 */
  broadcast(event: PayswapDesktopCardEvent): void;
}

function proposalIdOfPayload(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "proposalId" in payload) {
    const value = (payload as { proposalId?: unknown }).proposalId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/**
 * 包装批准 host 为带卡面推送的同型委托。host 的全部状态变迁都经过四入口（法则
 * 无其它变迁路径），推送因此完备。
 */
export function withPayswapCardPush(
  host: PayswapDesktopApprovalHost,
  port: PayswapCardPushPort,
): PayswapDesktopApprovalHost {
  return {
    trustedAppOrigins() {
      return host.trustedAppOrigins();
    },
    issueProposal(input) {
      const verdict = host.issueProposal(input);
      if (verdict.status === "issued") {
        port.sendTo(input.target.webContentsId, {
          kind: "payswap-card-issued",
          payload: verdict.cardPayload,
        });
      }
      return verdict;
    },
    handleApprovalResolution(input) {
      const verdict = host.handleApprovalResolution(input);
      if (verdict.status === "approved" || verdict.status === "denied") {
        const proposalId = proposalIdOfPayload(input.payload);
        if (proposalId) {
          port.broadcast({ kind: "payswap-card-dismissed", proposalId });
        }
      }
      return verdict;
    },
    invalidateProposal(proposalId) {
      host.invalidateProposal(proposalId);
      port.broadcast({ kind: "payswap-card-dismissed", proposalId });
    },
    revokePendingProposals() {
      const revoked = host.revokePendingProposals();
      for (const proposal of revoked) {
        port.broadcast({ kind: "payswap-card-dismissed", proposalId: proposal.proposalId });
      }
      return revoked;
    },
    proposals() {
      return host.proposals();
    },
    grants() {
      return host.grants();
    },
    authorizeOperation(input) {
      return host.authorizeOperation(input);
    },
  };
}

export { PAYSWAP_DESKTOP_CARD_CHANNEL };
