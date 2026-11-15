/**
 * PaySwap live harness 的 node:sqlite throws-on-use stub。
 *
 * 背景（2026-11-14 harness 战果记录）：tsup/esbuild 的 CJS bundle 化会把源码中
 * 的 `node:sqlite` 说明符改写成 `sqlite` —— 在不带 node:sqlite 内建的运行时上
 * require 失败。P2 账户流（键仓/账户服务/桥）不触碰 session DB；本 stub 仅在
 * 真被使用时才响亮失败（load-time 零影响），由 main.cjs 的 resolve 钩子映射。
 */

"use strict";

module.exports = function throwOnUse() {
  throw new Error(
    "sqlite is stubbed in the PaySwap live harness bundle: the P2 account flow must not touch the session DB (node:sqlite was rewritten to 'sqlite' by the CJS bundler; see scripts/payswap/live/sqlite-stub.cjs)",
  );
};
