/**
 * prebuilt-binary-extract 的 tar 解包回归 —— Windows 平台缺陷（2026-11-16，
 * P2 Windows 验收的 desktop 构建中演示）：GNU tar（Git Bash）把绝对路径里的
 * 盘符冒号（C:）当远程主机名。`resolveTarArchiveArg` 的相对路径优先策略此前
 * 只覆盖 cwd 子树内的归档 —— 同盘符但子树外（相对路径带 `..` 前缀）时退回
 * `C:/...` 绝对路径，GNU tar 直接失败（`tar (child): Cannot connect to C:
 * resolve failed`），bundled-npm stage（desktop 构建依赖）随之失败。
 *
 * 法则：同一盘符上的归档永远用相对 cwd 的 tar 参数（`..` 前缀也安全 —— 归档
 * 路径按 tar 进程 cwd 解析，-C 只影响成员输出，不参与 -f 的 rsh 语法解析）；
 * 跨盘符才退回绝对路径（bsdtar 可用，GNU tar 下 fail loud）。对 Linux/macOS
 * CI（win32 分支不激活）与 bsdtar 无行为变化。
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
