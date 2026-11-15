#!/usr/bin/env bash
# PaySwap P2 live 验收 —— E2E live spec 的 VM 运行器（仓控重建版）。
#
# 在 mega-setup 完成的 VM 内运行 `payswap-connection-live.test.ts`（真实受限
# 只读键经真实连接 UI × 真实 api.stripe.com）。与 CI 电池的关键差异：
# - 网络开启（live read-back 打真 api.stripe.com —— CI 电池是 --network none
#   回放隔离，故本 spec 不进电池清单）；
# - ZCODE_E2E_KEYRING=gnome-libsecret 腿环境（真 gnome-keyring Secret Service
#   + Electron --password-store=gnome-libsecret —— scripts/desktop-e2e-container-
#   entrypoint.sh 同款标准 recipe，含 org.freedesktop.secrets 在场自证）；
# - ZCODE_E2E_SPEC 收窄到 live spec 单跑。
#
# 用法（repo 根目录）：
#   ZCODE_E2E_STRIPE_LIVE_KEY=rk_test_... bash scripts/payswap/live/vm-run-live.sh
#
# 产物：
#   /workspace/artifacts/live-e2e/   RESULT.txt + wdio 输出 + spec ndjson
#   （路径可用 LIVE_ARTIFACT_DIR 覆盖）
#
# 秘密纪律：本脚本永不 echo 键值；只检查其在场性。

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ARTIFACT_DIR="${LIVE_ARTIFACT_DIR:-/workspace/artifacts/live-e2e}"
cd "$REPO_DIR"

log() { printf '[vm-run-live] %s\n' "$*"; }

if [ -z "${ZCODE_E2E_STRIPE_LIVE_KEY:-}" ]; then
  printf '[vm-run-live] FATAL: ZCODE_E2E_STRIPE_LIVE_KEY 未设置（真实受限只读键，rk_test_*）\n' >&2
  exit 2
fi

mkdir -p "$ARTIFACT_DIR"

# 真 Secret Service 腿（container entrypoint 同款 recipe：空口令 login keyring +
# 有界重试自证 org.freedesktop.secrets 在场 —— 宁可腿红也不静默退化 fallback-only）。
exec dbus-run-session -- bash -c '
  set -euo pipefail
  export XDG_CURRENT_DESKTOP=GNOME
  export DISPLAY='"${DISPLAY:-:99}"'
  export ZCODE_E2E_SPEC=./test/e2e/payswap-connection-live.test.ts
  export ZCODE_E2E_KEYRING=gnome-libsecret
  export ZCODE_E2E_STRIPE_LIVE_KEY
  export ZCODE_E2E_EXTRA_APP_ARGS="${ZCODE_E2E_EXTRA_APP_ARGS:-} --password-store=gnome-libsecret --no-sandbox"
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
    printf "[vm-run-live] FATAL: org.freedesktop.secrets 未上会话总线 —— 腿配置失败（fail loud）\n" >&2
    exit 1
  fi
  printf "[vm-run-live] secret service active (attempt %s)\n" "${attempt}"
  cd packages/desktop
  set +e
  bunx pnpm@10.33.2 run test:e2e:serial
  status=$?
  set -e
  printf "RESULT_E2E=%s\n" "$status" | tee "'"$ARTIFACT_DIR"'/RESULT.txt"
  if compgen -G ".e2e-artifacts/*" >/dev/null; then
    cp -r .e2e-artifacts/. "'"$ARTIFACT_DIR"'/e2e-artifacts/"
  fi
  exit "$status"
'
