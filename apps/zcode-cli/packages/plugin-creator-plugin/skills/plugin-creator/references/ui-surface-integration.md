# UI surface integration (plugin panels)

How a plugin declares, serves, and keeps working the host's panel UI. Authoritative implementations: manifest parser `adapters/src/plugins/ui-surfaces.ts` (`parsePluginUiSurfaces`), projection `bootstrap/src/zcode-protocol/plugin-ui-surfaces.ts` (`listPluginUiSurfacesFromPlugins`), served examples `payswap-plugin/src/panels.ts` and office-runtime's `dist/ui/panel.html`.

## Manifest declaration

```jsonc
"ui": {
  "surfaces": [
    {
      "id": "workspace",                    // [A-Za-z0-9][A-Za-z0-9_.-]*, <=128 chars, unique
      "title": { "en-US": "PaySwap Workspace", "zh-CN": "PaySwap 金融工作区" },
      "icon": "wallet",                     // optional; <=2048 chars
      "server": "gateway",                  // MUST be a key declared in mcpServers
      "resourceUri": "ui://payswap/workspace.html",  // must start with ui://, <=2048 chars
      "availability": "session"             // the only supported value
    }
  ]
}
```

Validation (`parseSurface`): invalid entries are DROPPED with a `plugin_manifest_invalid` warning diagnostic — the rest of the plugin keeps working, so an unnoticed typo silently removes a panel. Check with `official-plugin-audit.mjs`, which mirrors these rules and errors instead of dropping.

Runtime naming: the UI calls the namespaced server `plugin:<manifest-name>:<server>` (`declaredServer` keeps the raw key for diagnostics). Only official plugins may use `isolation: "workspace"` on that server (`adapters/src/plugins/mcp.ts` honors workspace isolation solely for the official marketplace source).

## Registration duty of the definition

A manifest with non-empty `ui.surfaces` MUST have `componentTypes: ["ui"]` in the official definition (and vice versa) — `bootstrap/tests/plugins.test.ts` "declares the ui component type exactly for bundled plugins with UI surfaces". Suppressed/restorable entries are classified as UI plugins from the definition alone.

## Serving the resource

Register each surface as an MCP resource in the plugin server (payswap `server.ts`):

```ts
const PANEL_MIME_TYPE = "text/html;profile=mcp-app"; // mcp-app contract (packages/shared/src/mcp-apps)
server.registerResource(surface.id, surface.resourceUri, { mimeType: PANEL_MIME_TYPE },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: PANEL_MIME_TYPE, text: renderPanelHtml(surface.id) }] }));
```

Rules proven by the payswap tests:

- MIME is exactly `text/html;profile=mcp-app`.
- Panels are static skeletons: zero external dependencies (no `<script src>`, no remote stylesheets/fonts), zero placeholder data (`balance: $`, `amount: $` are asserted absent), explicit status text ("no financial data is shown on this surface yet").
- Surfaces are informational (Class A) only — approval/authorization semantics are host-rendered Class B and must never appear in a plugin surface.
- Launcher visibility filters on `plugin.enabled` only; opting out of `userConfig` does NOT hide the entry — the data boundary is the refusal envelope + static panel, not hidden UI.
- Opt-out lifecycle: when panels later render real data, the host's UI initialization handshake and data-destruction on opt-out become acceptance targets (payswap CONTRACT.md: T7 data arm is gated on the Wave-2 broker; until then panels stay data-free).

## Runtime asset alternative (office-runtime shape)

Document plugins build panel pages as files (`dist/ui/panel.html`, `dist/ui/assets.json`) instead of inline HTML strings. Either shape works; both MUST be pinned in the official definition's `requiredSeedPaths` ("缺了会 seed 出能看到面板入口却启动不了 MCP server 的残缺插件" — zcode-site requiredSeedPaths comment) so an incomplete seed cannot reach users.

## Host-side handshake duties (when a surface needs more than static HTML)

The host reads panel resources through the plugin's MCP server; any dynamic behavior goes through that same namespaced server (`mcp/uiReadResource` with `plugin:<name>:<server>`). A panel that must complete a host UI initialization handshake does so via the server's MCP connection — never via its own network channel. Keep the data path inside the plugin server thin-proxy discipline ([host-broker-integration.md](host-broker-integration.md)).

## Checklist before declaring a surface done

1. Manifest entry passes `parsePluginUiSurfaces` rules (id/title/server/resourceUri/availability) — audit script 0 errors.
2. Definition carries `componentTypes: ["ui"]`.
3. Server registers the resource with the mcp-app MIME; resource content passes the static-skeleton assertions.
4. `requiredSeedPaths` pins whatever the panel needs at runtime.
5. Package tests assert resources + informational discipline; launch tests assert `listPluginUiSurfaces` projection in enabled/disabled arms.
