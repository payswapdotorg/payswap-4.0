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

# --- 0. VM 先决条件自供给（2026-11-16 实测：当前 E2B 基础模板 = Debian 12 +
#      Node 20.9 + 无 bun/pnpm + 默认用户无 root 权限。仓控配方要求 Node 24 +
#      bunx pnpm@10.33.2 —— 缺什么装什么，幂等，fail loud）。-------------------
SUDO=""
if [ "$(id -u)" != "0" ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo"; else
    printf '[vm-mega-setup] FATAL: 非 root 且 sudo 不可用 —— 无法安装系统依赖\n' >&2
    exit 1
  fi
fi

# alsa 库包名随发行版漂移（Ubuntu 24.04+/trixie = t64；Debian 12/Jammy = 原名）。
ALSA_LIB="libasound2"
if grep -qE '^VERSION_ID="(24|25|26)' /etc/os-release 2>/dev/null; then
  ALSA_LIB="libasound2t64"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
# root 情形下 apt 直接跑（SUDO 空展开）；NodeSource 管道需要显式 bash 形态 ——
# 抽成函数避免空展开导致的语法破裂。
root_elevate_bash() {
  if [ "$(id -u)" = "0" ]; then bash -; else sudo -E bash -; fi
}
if [ "$NODE_MAJOR" -lt 22 ]; then
  log "installing Node 24 via NodeSource (template node is $(node --version 2>/dev/null || echo absent))"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends curl ca-certificates unzip >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_24.x | root_elevate_bash >/dev/null
  $SUDO apt-get install -y -qq --no-install-recommends nodejs >/dev/null
  log "node now $(node --version)"
else
  $SUDO apt-get update -qq || true
  $SUDO apt-get install -y -qq --no-install-recommends curl ca-certificates unzip >/dev/null || true
fi

if ! command -v bunx >/dev/null 2>&1; then
  log "installing bun system-wide (bunx needed by install/build steps and the E2E runner)"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  $SUDO cp "$HOME/.bun/bin/bun" "$HOME/.bun/bin/bunx" /usr/local/bin/ 2>/dev/null \
    || $SUDO install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
  $SUDO install -m 0755 "$HOME/.bun/bin/bunx" /usr/local/bin/bunx 2>/dev/null || true
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Xvfb 常驻（E2E 运行器的 DISPLAY 缺省 :99 —— 原 recipe 由容器入口点启动；
# VM 侧由 mega-setup 负责拉起。启动放在 apt 安装之后 —— xvfb 包先就位）。

# --- 1. 系统依赖（Electron 运行库 + 真 Secret Service + 显示服务） -------------
if command -v apt-get >/dev/null 2>&1; then
  log "installing system dependencies (electron libs, dbus, gnome-keyring, xvfb; alsa=$ALSA_LIB)"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get install -y -qq --no-install-recommends \
    dbus dbus-x11 gnome-keyring libsecret-1-0 \
    xvfb xauth \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 "$ALSA_LIB" \
    libpango-1.0-0 libcairo2 libatspi2.0-0 >/dev/null
else
  log "apt-get 不在场 —— 跳过系统依赖（假定镜像已备）"
fi

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  log "starting Xvfb on :99"
  (Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &)
  sleep 1
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
