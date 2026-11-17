#!/usr/bin/env bash
# PaySwap P2 live 验收 —— 对话面 harness 的 VM 运行器（仓控重建版）。
#
# 在 mega-setup 完成的 VM 内：build-live-harness.mjs 编译真实 law 模块 →
# 真实 Electron main 进程内组装生产拓扑（真 Libsecret 键仓 → 受监督运行时 →
# MessageChannelMain 桥 → 法则客户端）→ 真键 connect/refresh/对话面查询打真
# api.stripe.com。步骤与退出码语义见 scripts/payswap/live/main.cjs 头注。
#
# 用法（repo 根目录）：
#   ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_... bash scripts/payswap/live/vm-harness-only.sh
#
# 产物：
#   /workspace/artifacts/live-harness/
#     live-conversational-evidence.json   结构化步骤证据（与 2026-11-14 登记同形）
#     payswap-connections-at-rest.json    at-rest 连接记录快照（无秘密面）
#     RESULT-harness.txt                  RESULT_HARNESS=0（全 ok）/1（含设计内拒绝）
#   （路径可用 LIVE_ARTIFACT_DIR 覆盖）
#
# RESULT 语义（验收判定）：0 = 四类别对话数据落地（P2 终局证据）；1 = 链路证到
# 拒绝边界（未激活账户的 typed read_back_unavailable —— lawful 但未完成）。

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
# 2026-11-16 修复：本脚本住 scripts/payswap/live/（三层深）—— 原推导只回退两层，
# REPO_DIR 落在 <repo>/scripts；仓内相对路径（build-live-harness.mjs 调用）随之
# 错位。package.json 在场自证 —— 推导错误 fail loud，不再静默错位。
if [ ! -f "$REPO_DIR/package.json" ]; then
  printf '[vm-harness-only] FATAL: REPO_DIR 推导错误（无 package.json）: %s\n' "$REPO_DIR" >&2
  exit 2
fi
ARTIFACT_DIR="${LIVE_ARTIFACT_DIR:-/workspace/artifacts/live-harness}"
cd "$REPO_DIR"

log() { printf '[vm-harness-only] %s\n' "$*"; }

if [ -z "${ZCODE_E2E_STRIPE_LIVE_KEY:-}" ]; then
  printf '[vm-harness-only] FATAL: ZCODE_E2E_STRIPE_LIVE_KEY 未设置（真实受限只读键，rk_test_*）\n' >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR"

# 1. 编译真实 law 模块（tsup CJS bundle + createRequire shim 修补）。
log "building the harness bundle from source"
node scripts/payswap/live/build-live-harness.mjs

# 2. 真 Secret Service 腿（与 E2E 运行器同款 recipe —— harness 的键仓同样要求
#    真 OS 钥匙串后端；harness 步骤 1 自证后端名）。
exec dbus-run-session -- bash -c '
  set -euo pipefail
  export XDG_CURRENT_DESKTOP=GNOME
  export ZCODE_E2E_STRIPE_LIVE_KEY
  export ZCODE_PAYSWAP_LIVE_OUT_DIR='"$REPO_DIR"'/packages/desktop/.live-harness/out
  printf "\n" | gnome-keyring-daemon --unlock --replace --components=secrets --daemonize
  secrets_on_bus=0
  for attempt in $(seq 1 30); do
    if dbus-send --session --print-reply --dest=org.freedesktop.DBus \
        /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null \
        | grep -q "org.freedesktop.secrets"; then
      secrets_on_bus=1
      break
    fi
    sleep 0.5
  done
  if [ "$secrets_on_bus" != "1" ]; then
    printf "[vm-harness-only] FATAL: org.freedesktop.secrets 未上会话总线 —— 腿配置失败（fail loud）\n" >&2
    exit 1
  fi
  printf "[vm-harness-only] secret service active (attempt %s)\n" "${attempt}"
  # 2026-11-16 修复：本仓 node-linker=hoisted —— electron 二进制提升到仓库根
  # node_modules/electron/dist/，packages/desktop/node_modules/.bin/ 下没有 shim
  # （E2B 沙箱实测：No such file or directory）。优先根提升布局，包内 shim 为
  # 历史布局兜底；两者皆缺席 = fail loud（不猜）。REPO_DIR 经 '"$REPO_DIR"'
  # 拼接进入内层 bash（单引号块不展开外层变量）。
  electron_bin='"$REPO_DIR"'/node_modules/electron/dist/electron
  if [ ! -x "$electron_bin" ]; then
    electron_bin='"$REPO_DIR"'/packages/desktop/node_modules/.bin/electron
  fi
  if [ ! -x "$electron_bin" ]; then
    printf "[vm-harness-only] FATAL: electron 可执行缺席（hoisted 与包内布局都不在场）\n" >&2
    exit 1
  fi
  set +e
  "$electron_bin" \
    --password-store=gnome-libsecret --no-sandbox \
    scripts/payswap/live/main.cjs
  status=$?
  set -e
  if compgen -G "packages/desktop/.live-harness/out/*" >/dev/null; then
    cp -r packages/desktop/.live-harness/out/. "'"$ARTIFACT_DIR"'/"
  fi
  exit "$status"
'
