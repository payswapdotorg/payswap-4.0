#!/usr/bin/env bash
# Desktop Electron E2E 容器入口（Dockerfile.desktop-e2e 的 CMD 载体）。
#
# 两条腿（P2 架构师评审 2026-11-14 第 4 项 —— 连接臂 E2E 的环境自适应闭集
# 需要「存储可用」环境来跑 happy-path/refresh/revoke/损坏键重启四臂）：
#
# - ZCODE_E2E_KEYRING 缺席/absent（缺省，行为与历史 CMD 逐字节等价）：
#   容器内无 Secret Service —— Electron safeStorage 无 OS 钥匙串后端，
#   连接臂按其文档化闭集走 fallback-only 拒绝分支（Gate E2 条款本体），
#   存储四臂诚实跳过。
# - ZCODE_E2E_KEYRING=gnome-libsecret：dbus-run-session 内启动真实
#   gnome-keyring 守护（空口令 login keyring —— CI 标准 recipe；守护在
#   会话总线上注册 org.freedesktop.secrets）+ XDG_CURRENT_DESKTOP=GNOME +
#   Electron --password-store=gnome-libsecret —— safeStorage 选择
#   gnome_libsecret（真实 Libsecret 代码路径，与 Linux 桌面同一后端）。
#   连接臂的存储四臂（connected+at-rest 密文 / refresh 闭集 / revoke /
#   损坏键真实重启 → typed 存储 refusal）在该腿执行。
#
# 环境的自证（不靠静默降级）：守护启动后 dbus-send 探测
# org.freedesktop.secrets 在场，缺席即 FATAL —— 宁可腿红也不让「存储可用腿」
# 静默退化成 fallback-only 腿。spec 侧的 ZCODE_E2E_KEYRING 期望标记
# （payswap-connection-ui.test.ts）在同一方向上加压：leg 语义是断言，不是愿望。
#
# 两条腿都跑完整 E2E_SPEC 电池（其它 10 个 spec 与存储无关 —— 同电池双跑
# 顺带证明 keyring 在场不改变 P1 面的行为）。

set -euo pipefail

if [ "${ZCODE_E2E_KEYRING:-absent}" = "gnome-libsecret" ]; then
  exec dbus-run-session -- bash -c '
    set -euo pipefail
    # Electron 的后端选择：GNOME 家族桌面 → gnome_libsecret（Libsecret 路径）。
    export XDG_CURRENT_DESKTOP=GNOME
    # 显式 pin 后端（DE 探测的双保险 —— 开关与 XDG 探测同源同效）。
    export ZCODE_E2E_EXTRA_APP_ARGS="${ZCODE_E2E_EXTRA_APP_ARGS:-} --password-store=gnome-libsecret"
    # 空口令 login keyring（CI 标准 recipe；stdin 为口令行）。
    printf "\n" | gnome-keyring-daemon --unlock --replace --components=secrets --daemonize
    # 自证：Secret Service 必须真的在会话总线上 —— 缺席 = 腿配置失败（fail loud）。
    if ! dbus-send --session --print-reply --dest=org.freedesktop.DBus \
        /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null \
        | grep -q "org.freedesktop.secrets"; then
      echo "[desktop-e2e-entrypoint] FATAL: org.freedesktop.secrets not on the session bus after gnome-keyring-daemon start (gnome-libsecret leg)" >&2
      exit 1
    fi
    echo "[desktop-e2e-entrypoint] secret service active: org.freedesktop.secrets on the session bus (gnome-libsecret leg)"
    pnpm --filter @zcode/desktop test:e2e ${EXTRA_WDIO_ARGS:-}
  '
else
  # 历史缺省路径（与旧 CMD 等价：无钥匙串环境 —— fallback-only 证明腿）。
  exec dbus-run-session -- pnpm --filter @zcode/desktop test:e2e ${EXTRA_WDIO_ARGS:-}
fi
