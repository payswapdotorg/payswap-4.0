import { SURFACES, type PayswapSurfaceId } from "./contract.ts";

/**
 * Class A 信息性表面的 `ui://` HTML 资源（附录 §1.6.0）。
 *
 * Wave 1 约束：面板是静态骨架——数据管线（panel → bridge → 工具 → broker）属于 Wave 2+。
 * 面板内容因此只描述自身与状态指引，永不渲染任何（哪怕是占位的）金融数据；
 * 这与「server 无金融状态」的纪律一致，也让 T7 的两臂断言从 Wave 2 起才有可处置的真实数据。
 * 所有面板零外部依赖：无外链脚本、无网络请求、无字体/资源引用（沙箱 CSP 友好）。
 */

interface PanelContent {
  heading: string;
  headingZh: string;
  lede: string;
  ledeZh: string;
}

const PANEL_CONTENT: Record<PayswapSurfaceId, PanelContent> = {
  workspace: {
    heading: "PaySwap Financial Workspace",
    headingZh: "PaySwap 金融工作区",
    lede: "Connected accounts, balances and capability overviews — redacted, evidence-based.",
    ledeZh: "已连接账户、余额与能力概览——脱敏、以证据为准。",
  },
  "route-plan": {
    heading: "PaySwap Route Plan",
    headingZh: "PaySwap 路线计划",
    lede: "Candidate routes for a compiled intent, always including the direct-route baseline.",
    ledeZh: "已编译意图的候选路线，始终包含直连路线基线。",
  },
  evidence: {
    heading: "PaySwap Evidence",
    headingZh: "PaySwap 凭据与证据",
    lede: "Reconciliation evidence and ledger references for executed operations.",
    ledeZh: "已执行操作的对账证据与账本引用。",
  },
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderPanelHtml(surfaceId: PayswapSurfaceId): string {
  const content = PANEL_CONTENT[surfaceId];
  const surface = SURFACES.find((entry) => entry.id === surfaceId);
  if (!surface || !content) throw new Error(`Unknown PaySwap surface: ${surfaceId}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.heading)}</title>
<style>
  :root { color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    body { --bg: #17171a; --fg: #ececf1; --border: #2c2c33; }
  }
  @media (prefers-color-scheme: light) {
    body { --bg: #ffffff; --fg: #26262c; --border: #e4e4e9; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  main { padding: 24px; max-width: 640px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; letter-spacing: 0.1px; }
  p.lede { font-size: 13px; line-height: 1.6; margin: 0 0 20px; opacity: 0.85; }
  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    font-size: 13px;
    line-height: 1.6;
  }
  .card .zh { display: block; opacity: 0.75; margin-top: 6px; }
  .state { font-weight: 600; margin-bottom: 4px; }
  ol { margin: 10px 0 0; padding-left: 18px; }
  li { margin: 3px 0; }
  footer { margin-top: 16px; font-size: 11px; opacity: 0.55; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(content.heading)}</h1>
  <p class="lede">${escapeHtml(content.lede)}<br>${escapeHtml(content.ledeZh)}</p>
  <div class="card">
    <div class="state">Status: no financial data is shown on this surface yet.</div>
    Live data appears here once:
    <ol>
      <li>the <strong>Financial workspace</strong> option is turned on in the PaySwap plugin settings, and</li>
      <li>a provider account is connected.</li>
    </ol>
    <span class="zh">开启 PaySwap 插件设置中的「金融工作区」选项并连接账户后，此处才会显示实时数据。</span>
  </div>
  <footer>PaySwap surfaces are informational only (Class A). Money approval is never rendered by a plugin surface.</footer>
</main>
</body>
</html>
`;
}
