#!/usr/bin/env bash
# PaySwap P2-Linux 显示腿包装器 —— 在自证的 Xvfb + D-Bus 会话 +
# gnome-keyring Secret Service 环境里执行任意命令。
#
# 与 CI 容器腿（scripts/desktop-e2e-container-entrypoint.sh 的 gnome-libsecret
# 分支）同源 recipe；差别只在：X server 由本包装器在**自身命令生命周期内**
# 自持（E2B 实测教训：mega-setup 建立的 display 不跨命令存活），且栈可来自
# PAYSWAP_LINUX_LEG_STACK 前缀（leg-stack.cjs 解析后注入 PATH/库路径）。
#
# 自证纪律（fail loud，绝不静默退化）：
#   - Xvfb 起不来 → FATAL
#   - org.freedesktop.secrets 不在会话总线上 → FATAL（存储可用腿绝不允许
#     静默退化成 fallback-only 腿 —— 腿语义是断言）
#
# 用法：leg-session.sh <command> [args...]
set -uo pipefail

DISPLAY_NUM="${PAYSWAP_LEG_DISPLAY:-99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"

if [ "$#" -lt 1 ]; then
  echo "[leg-session] usage: leg-session.sh <command> [args...]" >&2
  exit 3
fi

rm -f "/tmp/.X11-unix/X${DISPLAY_NUM}" "/tmp/.X${DISPLAY_NUM}-lock"
Xvfb ":${DISPLAY_NUM}" -screen 0 1600x1000x24 -nolisten tcp >/tmp/leg-session-xvfb.log 2>&1 &
XVFB_PID=$!
cleanup() { kill "$XVFB_PID" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 1 20); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
  sleep 0.25
done
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[leg-session] FATAL: Xvfb :${DISPLAY_NUM} died during startup" >&2
  cat /tmp/leg-session-xvfb.log >&2
  exit 1
fi
export DISPLAY=":${DISPLAY_NUM}"
echo "[leg-session] Xvfb up (pid ${XVFB_PID}, display ${DISPLAY})"

dbus-run-session -- bash -c '
  set -uo pipefail
  export XDG_CURRENT_DESKTOP=GNOME
  printf "\n" | gnome-keyring-daemon --unlock --replace --components=secrets --daemonize
  secrets_on_bus=0
  for attempt in $(seq 1 30); do
    if dbus-send --session --print-reply --dest=org.freedesktop.DBus \
        /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null \
        | grep -q "org.freedesktop.secrets"; then secrets_on_bus=1; break; fi
    sleep 0.5
  done
  if [ "$secrets_on_bus" != "1" ]; then
    echo "[leg-session] FATAL: org.freedesktop.secrets NOT on the session bus after ${attempt:-0}x0.5s" >&2
    exit 1
  fi
  echo "[leg-session] secret service active (attempt ${attempt})"
  exec "$@"
' _ "$@"
status=$?
echo "[leg-session] command exit=${status}"
exit $status
