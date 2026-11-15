#!/usr/bin/env bash
# PaySwap P2 live 验收 —— E2B VM 一次性 mega-setup（仓控重建版）。
#
# 在 live 验收 VM（如 E2B microVM；任何 Ubuntu + Node 24 + 网络的 VM 皆可）内
# 运行。产出「可跑 live spec 与 live harness」的完整环境：
#   1. 系统依赖：Electron 运行库 + dbus/gnome-keyring（真 Libsecret 腿）+ Xvfb/xauth
#      （镜像 scripts/desktop-e2e-container-entrypoint.sh 的 gnome-libsecret 腿配方
#      —— 同一标准 recipe，VM 版）
#   2. 仓库依赖：pnpm install --frozen-lockfile（workspace 链接就位）
#   3. 桌面构建：E2E 需要的 desktop 构建产物（renderer + main + e2e-report）
#   4. chromedriver preflight：仓库自己的 preflight（与容器内 Chromium 精确配对）
#
# 用法（repo 根目录）：
#   bash scripts/payswap/live/vm-mega-setup.sh
#
# 环境变量：
#   REPO_DIR    仓库目录（缺省 = 脚本位置反推的 repo 根）
#
# 注意：VM 有硬 TTL（E2B 1h）—— 本脚本是幂等的；跨 TTL 重建后重跑即可。

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$REPO_DIR"

log() { printf '[vm-mega-setup] %s\n' "$*"; }

# --- 1. 系统依赖（Electron 运行库 + 真 Secret Service + 显示服务） -------------
if command -v apt-get >/dev/null 2>&1; then
  log "installing system dependencies (electron libs, dbus, gnome-keyring, xvfb)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    dbus dbus-x11 gnome-keyring libsecret-1-0 \
    xvfb xauth \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 >/dev/null
else
  log "apt-get 不在场 —— 跳过系统依赖（假定镜像已备）"
fi

# --- 2. 仓库依赖（frozen lockfile —— CI 同款确定性） --------------------------
if [ ! -d node_modules ] || [ ! -x packages/desktop/node_modules/.bin/tsup ]; then
  log "pnpm install --frozen-lockfile（bunx pnpm@10.33.2 —— 仓内既定版本）"
  bunx pnpm@10.33.2 install --frozen-lockfile
else
  log "node_modules 已就位（幂等跳过 install）"
fi

# --- 3. 桌面构建（E2E 需要 renderer/main 产物；e2e-report 为 pretest:e2e 依赖） --
log "building desktop (serial —— VM 内存受限，避免并行 OOM)"
NODE_OPTIONS="--max-old-space-size=3072" bunx pnpm@10.33.2 --filter @zcode/e2e-report run build:node
NODE_OPTIONS="--max-old-space-size=3072" bunx pnpm@10.33.2 --filter @zcode/desktop... run build

# --- 4. chromedriver preflight（仓库自己的配对 preflight） ---------------------
log "chromedriver preflight"
if [ -f packages/desktop/scripts/prefill-chromedriver.mjs ]; then
  (cd packages/desktop && node scripts/prefill-chromedriver.mjs)
elif grep -rn "chromedriver" packages/desktop/package.json | grep -q "prefill\|preflight"; then
  (cd packages/desktop && bunx pnpm@10.33.2 run prefill:chromedriver)
else
  # preflight 入口名漂移时的诚实回退：wdio 启动时的自证探针会再拦一道。
  log "WARN: chromedriver preflight 脚本未按已知入口命中 —— 依赖 wdio 启动自证"
fi

log "mega-setup 完成 —— 可跑 vm-run-live.sh（E2E live spec）与 vm-harness-only.sh（对话面 harness）"
