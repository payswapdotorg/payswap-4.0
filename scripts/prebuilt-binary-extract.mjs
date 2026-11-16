import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { runCommand } from "./spawn-command.mjs";

// Bugfix: Windows tar 的路径形态纪律（2026-11-16，P2 Windows 验收的 desktop
// 构建中演示）。PATH 上的 tar 可能是两种实现，路径语法不兼容：
// - MSYS GNU tar（Git Bash /usr/bin）：`-f C:/...` 的盘符冒号被当远程主机名
//   （Cannot connect to C:），`-C C:/...` 的冒号被转义成 `C\:/...` 打不开；
//   相对 `..` 路径在 MSYS 命名空间里解析（/tmp 只比根深一层），Windows 侧算出
//   的相对层数会指错位置（`realpath ../../../../.zcode` → `/.zcode` 实证）。
// - 系统 bsdtar（System32\tar.exe，Win10 1803+ 自带）：正斜杠绝对 Windows 路径
//   对 -f 与 -C 都原生可用。
// 纪律：win32 上优先固定调用系统 bsdtar（绝对路径，不受 PATH 影响），参数统一
// 正斜杠绝对路径；System32 bsdtar 缺席时退回 PATH tar + 原有子树内相对形式
// （GNU tar 下子树外/跨盘符 fail loud —— 不猜）。对 Linux/macOS CI 无影响。
function toTarPosixPath(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

function resolveTarArchiveArg(archivePath, cwd) {
  if (process.platform === "win32") {
    try {
      const relativeArchivePath = relative(cwd, archivePath);
      if (relativeArchivePath && !relativeArchivePath.startsWith("..")) {
        return toTarPosixPath(relativeArchivePath);
      }
    } catch {
      // 跨盘符时 relative 会抛错，退回正斜杠绝对路径（系统 bsdtar 可用）。
    }
  }

  return toTarPosixPath(archivePath);
}

/** win32 的 tar 可执行：优先系统 bsdtar（System32\tar.exe —— 原生理解 Windows
 * 路径，不受 PATH 上 MSYS GNU tar 的影响）；缺席（Win10 1803 前的老系统）退回
 * PATH tar —— 参数纪律回到子树内相对 + 绝对 fallback 的原有行为。 */
function resolveTarCommand() {
  if (process.platform !== "win32") return "tar";
  const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(systemTar) ? systemTar : "tar";
}

export function extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd }) {
  mkdirSync(extractDir, { recursive: true });
  if (archiveExt === "zip") {
    if (process.platform === "win32") {
      runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
      ]);
      return;
    }

    runCommand("unzip", ["-q", archivePath, "-d", extractDir], { cwd });
    return;
  }

  const tarCwd = cwd ?? process.cwd();
  runCommand(
    resolveTarCommand(),
    ["-xzf", resolveTarArchiveArg(archivePath, tarCwd), "-C", toTarPosixPath(extractDir)],
    { cwd: tarCwd },
  );
}

export function findPrebuiltBinary(rootDir, binaryName) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findPrebuiltBinary(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }

  return undefined;
}

export function assertPrebuiltArchiveSha256(expectedSha256) {
  const normalizedExpectedSha256 = String(expectedSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpectedSha256)) {
    throw new Error("missing prebuilt archive SHA-256");
  }
  return normalizedExpectedSha256;
}

export function verifyPrebuiltArchiveSha256(archivePath, expectedSha256) {
  const normalizedExpectedSha256 = assertPrebuiltArchiveSha256(expectedSha256);
  const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actualSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Archive SHA-256 mismatch: expected ${normalizedExpectedSha256}, received ${actualSha256}`,
    );
  }
}

export async function extractPrebuiltBinary({
  archiveExt,
  archivePath,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  targetPlatform,
  validateBinary,
}) {
  verifyPrebuiltArchiveSha256(archivePath, archiveSha256);
  mkdirSync(dirname(binaryPath), { recursive: true });
  mkdirSync(tmpdir(), { recursive: true });
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-prebuilt-binary-"));
  const extractDir = join(tempDir, "extract");

  try {
    extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // foreign target 不能靠执行目标文件验真，必须在覆盖正式路径前校验临时产物。
    await validateBinary?.(extractedBinaryPath);
    copyFileSync(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
  } finally {
    // Bugfix: Windows 下解压产物可能被杀毒/索引器或尚未退出的解压子进程短暂持有句柄，
    // rmSync 立即删除会 EPERM，且 finally 里抛出的异常会掩盖真正的解压错误。
    // 带重试删除，失败时仅告警，让原始错误正常抛出。
    try {
      rmSync(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[warn] 清理临时目录失败（可忽略）: ${tempDir}`);
      console.warn(`[warn] ${String(error)}`);
    }
  }
}
