import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 把插件打包为单一 dist/server.mjs（与 office-runtime 的 server 打包参数一致：
// bundle + platform node + esm + node24 + createRequire banner）。
// dist/ 是构建产物（git 忽略），由官方插件 seed 按 requiredSeedPaths 校验完整性。
const target = dirname(fileURLToPath(import.meta.url));
const root = join(target, "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
  logOverride: { "direct-eval": "silent" },
});

process.stdout.write(`payswap-plugin: built dist/server.mjs\n`);
