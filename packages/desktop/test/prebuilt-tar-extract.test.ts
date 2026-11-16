/**
 * prebuilt-binary-extract 的 tar 解包回归 —— Windows 平台缺陷（2026-11-16，
 * P2 Windows 验收的 desktop 构建中演示）：PATH 上的 tar 可能是 MSYS GNU tar
 * 或系统 bsdtar，路径语法不兼容。bundled-npm stage（desktop 构建依赖）以
 * cwd = 临时 workDir、归档在 repo 缓存（cwd 子树外）的形态调用解包 —— GNU
 * tar 下绝对 `C:/...` 归档被当远程主机名（Cannot connect to C:），相对 `..`
 * 层数又在 MSYS 命名空间里指错位置（`realpath ../../../../x` → `/x` 实证），
 * 构建随之失败。
 *
 * 法则：win32 上 tar 可执行固定为系统 bsdtar（System32\\tar.exe —— 原生理解
 * Windows 路径，不受 PATH 影响），正斜杠绝对路径对 -f 与 -C 都可用；缺席时
 * 退回 PATH tar + 原有子树内相对形式（GNU tar 下子树外 fail loud，不猜）。
 * 对 Linux/macOS CI（win32 分支不激活）无行为变化。
 */

import { mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractPrebuiltArchive } from "../../../scripts/prebuilt-binary-extract.mjs";

const createdDirs: string[] = [];

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTarballFixture(): Promise<{ archivePath: string; payloadDir: string }> {
  const payloadDir = await mkdtemp(join(tmpdir(), "prebuilt-tar-payload-"));
  createdDirs.push(payloadDir);
  // npm registry tarball 形态：归档根是 package/ 目录。
  await writeFile(join(payloadDir, "marker.txt"), "prebuilt-tar-extract regression\n", "utf8");
  const packageDir = join(payloadDir, "package");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "marker.txt"), "prebuilt-tar-extract regression\n", "utf8");
  // 用系统 tar 创建归档（相对路径 —— 所有平台的安全形态；与被测的解包方向无关）。
  const archivePath = join(payloadDir, "fixture.tgz");
  execFileSync("tar", ["-czf", "fixture.tgz", "package"], { cwd: payloadDir });
  return { archivePath, payloadDir };
}

describe("prebuilt-binary-extract tar face — Windows drive-colon regression (law: archive arg never needs a drive-letter absolute form on the same drive)", () => {
  it("extracts an archive outside the tar cwd subtree on the same drive (the bundled-npm cache shape)", async () => {
    const { archivePath, payloadDir } = await makeTarballFixture();
    // 解包 cwd 取系统临时目录下另一个目录 —— 归档在 cwd 子树之外（相对路径带
    // `..` 前缀），同一盘符。此前该形态退回 `C:/...` 绝对路径，Git Bash GNU
    // tar 把 C: 当远程主机名而解包失败。
    const workDir = await mkdtemp(join(tmpdir(), "prebuilt-tar-work-"));
    createdDirs.push(workDir);
    const extractDir = join(workDir, "extracted");

    extractPrebuiltArchive({ archivePath, archiveExt: "tgz", extractDir, cwd: workDir });

    const entries = await readdir(join(extractDir, "package"));
    expect(entries).toContain("marker.txt");
    // 归档与其载荷留在原位（fixture 自身不被解包步骤改动）。
    expect(await readdir(payloadDir)).toContain("fixture.tgz");
  });
});
