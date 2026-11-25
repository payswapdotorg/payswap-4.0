// PaySwap custodian isolation probe —— v1.1 命名槽布局的回归矩阵（node --test，
// 零依赖，与 run-p2-acceptance.test.mjs 同款纪律；全部合成夹具，零凭据材料）。
//
// 缺陷史（2026-11-25，P3-D part 2 首次在 custodian v1.1+ 之后重跑五分类 runner 时
// 暴露）：isolation-probe.cjs 的 meaningful-green 前置与敌意子进程的 blob 攻击都
// 只认 legacy 单槽路径 `custodian-key.bin`；custodian v1.1（ADR-P2-3 命名槽）起
// blob 落盘为 `custodian-key-slot-<hash>.bin`（legacy wire 逐字不变 —— blob 文件
// 名不是 wire）。结果：真有在管材料时前置报 "key blob absent"（空洞 FAIL）。
// 回归矩阵钉住：blob 清单 = legacy（若在）+ 全部命名槽（严格 hex 名），非匹配
// 文件（endpoint/config/diag/杂散 .bin）绝不入列。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
// 以 CJS require 载入 probe 脚本 —— require.main !== module，main() 不执行。
const probe = require("./isolation-probe.cjs");

async function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function touch(dir, name, bytes = "x") {
  await fsp.writeFile(path.join(dir, name), bytes);
}

test("legacy single-slot layout only: the legacy blob is listed", async () => {
  const dir = await tmpDir("payswap-probe-legacy-");
  await touch(dir, "custodian-key.bin", "blob");
  const blobs = probe.listCustodianKeyBlobs(dir);
  assert.deepEqual(blobs, [path.join(dir, "custodian-key.bin")]);
});

test("v1.1+ named-slot layout only: every slot blob is listed (sorted), no legacy entry", async () => {
  const dir = await tmpDir("payswap-probe-slots-");
  await touch(dir, "custodian-key-slot-cb2623b10a06ea1262ffc10d39c04fe2.bin", "b1");
  await touch(dir, "custodian-key-slot-c2ac62673d9bdf9d20be361ca8aa48de.bin", "b2");
  const blobs = probe.listCustodianKeyBlobs(dir);
  assert.deepEqual(blobs, [
    path.join(dir, "custodian-key-slot-c2ac62673d9bdf9d20be361ca8aa48de.bin"),
    path.join(dir, "custodian-key-slot-cb2623b10a06ea1262ffc10d39c04fe2.bin"),
  ]);
});

test("mixed layout: legacy first, then the sorted slot blobs", async () => {
  const dir = await tmpDir("payswap-probe-mixed-");
  await touch(dir, "custodian-key-slot-aa.bin", "s1");
  await touch(dir, "custodian-key.bin", "legacy");
  await touch(dir, "custodian-key-slot-0f.bin", "s2");
  const blobs = probe.listCustodianKeyBlobs(dir);
  assert.deepEqual(blobs, [
    path.join(dir, "custodian-key.bin"),
    path.join(dir, "custodian-key-slot-0f.bin"),
    path.join(dir, "custodian-key-slot-aa.bin"),
  ]);
});

test("non-blob files are never listed: endpoint/config/diag, service dir and non-hex slot names are excluded", async () => {
  const dir = await tmpDir("payswap-probe-noise-");
  await touch(dir, "custodian-endpoint.json");
  await touch(dir, "custodian-config.json");
  await touch(dir, "custodian-diag.log");
  await touch(dir, "custodian-key-slot-not-hex.bin"); // 名字形状不符
  await touch(dir, "custodian-key-slot.bin"); // 无 hash 段
  await touch(dir, "svc.bin"); // 杂散 .bin
  await fs.mkdirSync(path.join(dir, "svc-bin"), { recursive: true });
  assert.deepEqual(probe.listCustodianKeyBlobs(dir), []);
});

test("an empty or unreadable custody directory lists zero blobs (no throw)", async () => {
  const dir = await tmpDir("payswap-probe-empty-");
  assert.deepEqual(probe.listCustodianKeyBlobs(dir), []);
  assert.deepEqual(probe.listCustodianKeyBlobs(path.join(dir, "does-not-exist")), []);
});
