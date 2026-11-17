"use strict";

/**
 * PaySwap P2-Linux —— 桌面腿栈解析（Xvfb / D-Bus / gnome-keyring 前缀）。
 *
 * Linux 桌面验收腿需要一个可自证的显示/钥匙串栈：Xvfb（X server）+
 * dbus-run-session（会话总线）+ gnome-keyring-daemon（org.freedesktop.secrets
 * Secret Service）+ libsecret 库。三种部署形态都合法：
 *
 *   1. 系统安装（普通 Linux 桌面 / apt 装好的 VM）：都在 PATH 上。
 *   2. 前缀安装（无 root 的沙箱：debs 解包到用户目录）：设
 *      PAYSWAP_LINUX_LEG_STACK=<prefix> —— 本模块把 <prefix>/usr/bin 加入
 *      PATH、<prefix>/usr/lib/<triplet> 加入 LD_LIBRARY_PATH、
 *      <prefix>/usr/share/glib-2.0/schemas 加入 GSETTINGS_SCHEMA_DIR。
 *   3. 未配置前缀时按系统 PATH 解析（形态 1 的缺省）。
 *
 * preflight（能力裁决）与 runner（执行）共用同一解析 —— 二者看到的栈必须一致，
 * 否则能力裁决与实际执行面漂移。
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** 前缀部署下 glib schema 的既定位置（bootstrap-desktop-stack.sh 的安装形态）。 */
function stackSchemaDir(prefix) {
  return path.join(prefix, "usr", "share", "glib-2.0", "schemas");
}

/** 前缀部署下原生库目录（x86_64 的 Debian multiarch 形态；存在性自证）。 */
function stackLibDir(prefix) {
  const candidates = [
    path.join(prefix, "usr", "lib", "x86_64-linux-gnu"),
    path.join(prefix, "usr", "lib64"),
    path.join(prefix, "usr", "lib"),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

/** 解析腿栈环境（纯函数；不修改 process.env —— 由调用方显式采用）。
 *  返回 { prefix, env }：prefix 为 null 表示系统形态；env 为该形态下的
 *  PATH/LD_LIBRARY_PATH/GSETTINGS_SCHEMA_DIR 增量。 */
function resolveLegStackEnvironment(baseEnv = process.env) {
  const prefix = (baseEnv.PAYSWAP_LINUX_LEG_STACK || "").trim() || null;
  if (!prefix) {
    return { prefix: null, env: {} };
  }
  if (!fs.existsSync(prefix)) {
    return { prefix, error: `PAYSWAP_LINUX_LEG_STACK='${prefix}' does not exist` };
  }
  const env = {};
  const binDir = path.join(prefix, "usr", "bin");
  if (fs.existsSync(binDir)) {
    env.PATH = `${binDir}${baseEnv.PATH ? `:${baseEnv.PATH}` : ""}`;
  }
  const libDir = stackLibDir(prefix);
  if (libDir) {
    env.LD_LIBRARY_PATH = `${libDir}${baseEnv.LD_LIBRARY_PATH ? `:${baseEnv.LD_LIBRARY_PATH}` : ""}`;
  }
  const schemaDir = stackSchemaDir(prefix);
  if (fs.existsSync(path.join(schemaDir, "gschemas.compiled"))) {
    env.GSETTINGS_SCHEMA_DIR = schemaDir;
  }
  return { prefix, env };
}

/** 在给定 env 下解析命令路径（which；不抛错）。 */
function resolveCommandInEnv(command, env) {
  try {
    return execFileSync("which", [command], { env, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** 腿栈必需命令（显示/总线/钥匙串三件套）。 */
const LEG_STACK_COMMANDS = ["Xvfb", "dbus-run-session", "gnome-keyring-daemon"];

/** 腿栈能力面自证：每个必需命令解析到可执行文件。
 *  返回 { ok, env, prefix, commands: [{command, path, ok}] }。 */
function probeLegStack(baseEnv = process.env) {
  const { prefix, env, error } = resolveLegStackEnvironment(baseEnv);
  const merged = { ...baseEnv, ...env };
  const commands = LEG_STACK_COMMANDS.map((command) => {
    const resolved = resolveCommandInEnv(command, merged);
    return { command, path: resolved, ok: Boolean(resolved) };
  });
  return {
    ok: !error && commands.every((c) => c.ok),
    env,
    prefix,
    error: error || null,
    commands,
  };
}

/** 腿栈环境下的 XDG_RUNTIME_DIR（dbus-run-session 需要；runner 统一固定到
 *  /tmp/xdg-runtime 并确保 0700 —— 多次运行复用同一目录是安全的）。 */
function ensureXdgRuntimeDir() {
  const dir = "/tmp/xdg-runtime";
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 非 owner 场景交给 dbus 自证 */
  }
  return dir;
}

module.exports = {
  LEG_STACK_COMMANDS,
  resolveLegStackEnvironment,
  probeLegStack,
  ensureXdgRuntimeDir,
};
