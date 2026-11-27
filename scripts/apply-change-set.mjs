#!/usr/bin/env node
// 变更集（change set）执行器：让低推理能力的编码代理只做「搬运」，不产出任何内容。
// 动机（P4 wave 6 复盘）：执行器一旦自己写内容，就会改写测试、重排法则文本、替换注释，
// 甚至绕过宿主拦截。这里把全部判断收进确定性工具：内容由 TL 预先写好并以 SHA-256 钉死，
// 工具只做「前置校验 → 整体写入 → 复核 → 精确提交」，任何不符即整体拒写。
// 输出一律 ASCII：执行器终端的代码页不可控，STOP 行必须能逐字回传给 TL。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SCHEMA = 1;
const MAX_BUFFER = 16 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const NAME = /^[\w.-]{1,64}$/u;

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const isSingleLine = (value) =>
  typeof value === "string" && value.length > 0 && !value.includes("\n");

/** 文本规整：去 BOM、CRLF/CR → LF、结尾只留一个换行；二进制或非法 UTF-8 直接拒收。 */
export function normalizeText(buffer) {
  const body = buffer.subarray(0, 3).equals(BOM) ? buffer.subarray(3) : buffer;
  if (body.length === 0) return "";
  if (body.includes(0)) throw new Error("binary content is not a text change-set payload");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return text.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "\n");
}

/** 只接受仓库相对的正斜杠路径：拒绝绝对路径、盘符、反斜杠、空段与 `..`，杜绝写到仓库之外。 */
export function safeRelativePath(value) {
  const shown = JSON.stringify(value);
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`path must be a non-empty string: ${shown}`);
  if (value.includes("\\") || value.includes(":") || value.includes("\0") || isAbsolute(value))
    throw new Error(`path must be repository-relative with forward slashes: ${shown}`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new Error(`path must not contain empty, "." or ".." segments: ${shown}`);
  return parts.join("/");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shortError(error) {
  return String(error.stderr ?? error.message).trim().split("\n")[0].slice(0, 300);
}

/** 所有问题一次性列出：执行器只需原样回传，不需要理解或修复。 */
function fail(problems, state) {
  if (problems.length === 0) return;
  throw new Error(
    problems.map((problem) => `STOP: ${problem}`).join("\n") +
      `\nSTOP: ${state}. Do not fix or work around this - report these lines verbatim.`,
  );
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function gitText(repoRoot, env, args) {
  const { stdout } = await exec("git", args, { cwd: repoRoot, env, maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

async function readBlob(repoRoot, env, spec) {
  const { stdout } = await exec("git", ["cat-file", "blob", spec], {
    cwd: repoRoot,
    env,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/** 目标目录若经符号链接落到仓库之外，返回 true（沿最近的已存在祖先判断）。 */
async function escapesRepo(repoRoot, directory) {
  let current = directory;
  for (;;) {
    try {
      return !isInside(repoRoot, await realpath(current));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/** change set 必须是仓库之外的目录：否则它自己就会把工作区弄脏。 */
async function locate(repoRoot, changeSetDir) {
  const problems = [];
  let root = null;
  let dir = null;
  try {
    root = await realpath(repoRoot);
  } catch {
    problems.push(`repository root not found: ${repoRoot}`);
  }
  try {
    dir = await realpath(changeSetDir);
  } catch {
    problems.push(`change-set directory not found: ${changeSetDir}`);
  }
  fail(problems, "nothing was written");
  if (isInside(root, dir))
    throw new Error(
      "STOP: the change-set directory must live outside the repository worktree\n" +
        "STOP: nothing was written. Do not fix or work around this - report these lines verbatim.",
    );
  return { root, dir };
}

async function listPayloads(filesDir) {
  const walk = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) paths.push(...(await walk(join(directory, entry.name), rel)));
      else if (entry.isFile()) paths.push(rel);
      else
        throw new Error(
          `unsupported entry in the change set (symlink or special file): ${rel}`,
        );
    }
    return paths;
  };
  return (await walk(filesDir, "")).sort();
}

/** 由暂存方运行一次：读取 files/ 下的完整文件，按 base 提交钉住 before/after 哈希。 */
export async function packChangeSet({
  repoRoot,
  changeSetDir,
  base,
  name,
  subject,
  body,
  trailers = [],
  env = process.env,
}) {
  const { root, dir } = await locate(repoRoot, changeSetDir);
  const problems = [];
  if (!COMMIT.test(base ?? ""))
    problems.push(`--base must be a full 40-hex commit sha, got ${JSON.stringify(base)}`);
  if (typeof name !== "string" || !NAME.test(name))
    problems.push(`--name must match [A-Za-z0-9_.-]{1,64}, got ${JSON.stringify(name)}`);
  if (subject !== undefined && !isSingleLine(subject))
    problems.push("--subject must be a single non-empty line");
  if (body !== undefined && typeof body !== "string") problems.push("--body must be a string");
  if (!Array.isArray(trailers) || trailers.some((trailer) => !isSingleLine(trailer)))
    problems.push("every --trailer must be a single non-empty line");
  fail(problems, "nothing was written");
  const filesDir = join(dir, "files");
  let payloads = [];
  try {
    payloads = await listPayloads(filesDir);
  } catch (error) {
    problems.push(error.message);
  }
  if (payloads.length === 0)
    problems.push(`the change set has no files under ${join(changeSetDir, "files")}`);
  let tracked = null;
  try {
    await gitText(root, env, ["cat-file", "-e", `${base}^{commit}`]);
    const { stdout } = await exec("git", ["ls-tree", "-r", "--name-only", "-z", base], {
      cwd: root,
      env,
      maxBuffer: MAX_BUFFER,
    });
    tracked = new Set(stdout.split("\0").filter(Boolean));
  } catch (error) {
    problems.push(`base commit is not reachable in this repository: ${shortError(error)}`);
  }
  const entries = [];
  if (tracked) {
    for (const payload of payloads) {
      try {
        const path = safeRelativePath(payload);
        const staged = normalizeText(await readFile(join(filesDir, ...path.split("/"))));
        const before = tracked.has(path)
          ? sha256(normalizeText(await readBlob(root, env, `${base}:${path}`)))
          : null;
        entries.push({ path, before, after: sha256(staged) });
      } catch (error) {
        problems.push(`${payload}: ${error.message}`);
      }
    }
  }
  const manifestPath = join(dir, "manifest.json");
  if (await exists(manifestPath))
    problems.push("manifest.json already exists in this change set (use a fresh directory)");
  fail(problems, "nothing was written");
  const manifest = { schema: SCHEMA, name, base, files: entries };
  if (subject !== undefined) {
    manifest.commit = { subject };
    if (body !== undefined) manifest.commit.body = body;
    if (trailers.length > 0) manifest.commit.trailers = trailers;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 由执行器运行：两阶段（先全量校验、后整体写入），可选精确提交；返回回执。 */
export async function applyChangeSet({ repoRoot, changeSetDir, env = process.env }) {
  const { root, dir } = await locate(repoRoot, changeSetDir);
  const problems = [];
  let manifest = null;
  let parsed = false;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    parsed = true;
  } catch (error) {
    problems.push(`manifest.json is missing or not valid JSON: ${error.message}`);
  }
  if (parsed && (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))) {
    problems.push("manifest.json must contain a JSON object");
    manifest = null;
  }
  const plan = [];
  if (manifest) {
    if (manifest.schema !== SCHEMA)
      problems.push(`unsupported manifest schema ${JSON.stringify(manifest.schema)} (expected ${SCHEMA})`);
    if (!COMMIT.test(manifest.base ?? ""))
      problems.push("manifest.base must be a full 40-hex commit sha");
    if (typeof manifest.name !== "string" || !NAME.test(manifest.name))
      problems.push("manifest.name must match [A-Za-z0-9_.-]{1,64}");
    if (manifest.commit !== undefined) {
      if (typeof manifest.commit !== "object" || manifest.commit === null)
        problems.push("manifest.commit must be an object");
      else {
        if (!isSingleLine(manifest.commit.subject))
          problems.push("manifest.commit.subject must be a single non-empty line");
        if (manifest.commit.body !== undefined && typeof manifest.commit.body !== "string")
          problems.push("manifest.commit.body must be a string");
        if (
          manifest.commit.trailers !== undefined &&
          (!Array.isArray(manifest.commit.trailers) ||
            manifest.commit.trailers.some((trailer) => !isSingleLine(trailer)))
        )
          problems.push("manifest.commit.trailers must be an array of single-line strings");
      }
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (files.length === 0) problems.push("manifest.files must be a non-empty array");
    const seen = new Set();
    files.forEach((entry, index) => {
      try {
        const path = safeRelativePath(entry?.path);
        if (seen.has(path)) throw new Error("duplicate path");
        seen.add(path);
        if (entry.before !== null && !SHA256.test(entry.before ?? ""))
          throw new Error("before must be null or a 64-hex sha256");
        if (!SHA256.test(entry.after ?? "")) throw new Error("after must be a 64-hex sha256");
        plan.push({ path, before: entry.before, after: entry.after });
      } catch (error) {
        problems.push(`manifest.files[${index}]: ${error.message}`);
      }
    });
  }
  fail(problems, "nothing was written");
  let headBefore = "";
  let branch = "";
  try {
    if (await gitText(root, env, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      throw new Error("worktree is not clean (commit, stash or remove every change first)");
    branch = await gitText(root, env, ["rev-parse", "--abbrev-ref", "HEAD"]);
    headBefore = await gitText(root, env, ["rev-parse", "HEAD"]);
    const ancestor = await exec(
      "git",
      ["merge-base", "--is-ancestor", manifest.base, "HEAD"],
      { cwd: root, env },
    ).then(
      () => true,
      (error) => {
        if (error.code === 1) return false;
        throw error;
      },
    );
    if (!ancestor) throw new Error(`base ${manifest.base} is not an ancestor of HEAD ${headBefore}`);
  } catch (error) {
    problems.push(
      typeof error?.code === "number" ? `git failed: ${shortError(error)}` : error.message,
    );
  }
  fail(problems, "nothing was written");
  for (const item of plan) {
    const target = join(root, ...item.path.split("/"));
    try {
      const staged = normalizeText(await readFile(join(dir, "files", ...item.path.split("/"))));
      if (sha256(staged) !== item.after)
        throw new Error("payload does not match manifest.after (the staged file changed after pack)");
      if (await escapesRepo(root, dirname(target)))
        throw new Error("target directory escapes the repository (symlink?)");
      const current = await readFile(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (item.before === null) {
        if (current !== null) throw new Error("expected a new file but the target already exists");
      } else if (current === null) {
        throw new Error("expected an existing file but the target is missing");
      } else if (sha256(normalizeText(current)) !== item.before) {
        throw new Error("target no longer matches the base content (base drift)");
      }
    } catch (error) {
      problems.push(`${item.path}: ${error.message}`);
    }
  }
  fail(problems, "nothing was written");
  const written = [];
  for (const item of plan) {
    const target = join(root, ...item.path.split("/"));
    try {
      await mkdir(dirname(target), { recursive: true });
      if (await escapesRepo(root, dirname(target)))
        throw new Error("target directory escapes the repository (symlink?)");
      const content = normalizeText(await readFile(join(dir, "files", ...item.path.split("/"))));
      await writeFile(target, content, "utf8");
      if (sha256(await readFile(target)) !== item.after)
        throw new Error("written bytes do not match manifest.after");
      written.push(item);
    } catch (error) {
      throw new Error(
        [
          `STOP: ${item.path}: ${error.message}`,
          `STOP: ${written.length} of ${plan.length} files were already written; the worktree is now dirty.`,
          "STOP: Do not fix or work around this - report these lines verbatim.",
        ].join("\n"),
      );
    }
  }
  let commit = null;
  if (manifest.commit) {
    try {
      const { subject, body, trailers = [] } = manifest.commit;
      await gitText(root, env, ["add", "--", ...plan.map((item) => item.path)]);
      const { stdout } = await exec("git", ["diff", "--cached", "--name-only", "-z"], {
        cwd: root,
        env,
      });
      const staged = stdout.split("\0").filter(Boolean).sort();
      const expected = plan.map((item) => item.path).sort();
      if (staged.join("\n") !== expected.join("\n"))
        throw new Error(
          [
            "staged files differ from the change set.",
            `  staged:   ${staged.join(", ") || "(none)"}`,
            `  expected: ${expected.join(", ")}`,
          ].join("\n"),
        );
      // whitespace 清理：去掉行尾空白但保留以 # 开头的行，提交说明逐字来自 manifest。
      const args = ["commit", "--cleanup=whitespace", "-m", subject];
      if (body) args.push("-m", body);
      if (trailers.length > 0) args.push("-m", trailers.join("\n"));
      await gitText(root, env, args);
      commit = await gitText(root, env, ["rev-parse", "HEAD"]);
    } catch (error) {
      const reason =
        typeof error?.code === "number" ? `git failed: ${shortError(error)}` : error.message;
      throw new Error(
        [
          ...reason.split("\n").map((line, index) => (index === 0 ? `STOP: ${line}` : line)),
          "STOP: files are written (and staged) but NOT committed. Do not fix or work around this - report these lines verbatim.",
        ].join("\n"),
      );
    }
  }
  return {
    name: manifest.name,
    base: manifest.base,
    branch,
    headBefore,
    headAfter: commit ?? headBefore,
    commit,
    files: plan.map((item) => ({
      ...item,
      status: item.before === null ? "added" : "modified",
    })),
  };
}

function usage() {
  return [
    "usage:",
    "  node scripts/apply-change-set.mjs pack <change-set-dir> --base <commit> --name <id>" +
      " [--subject <s>] [--body <b>] [--trailer <t>]",
    "  node scripts/apply-change-set.mjs apply <change-set-dir>",
  ].join("\n");
}

function parse(argv) {
  const [verb, dir, ...rest] = argv;
  if ((verb !== "pack" && verb !== "apply") || !dir) throw new Error(usage());
  const options = { verb, dir, trailers: [] };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}\n${usage()}`);
    if (flag === "--trailer") options.trailers.push(value);
    else if (["--base", "--name", "--subject", "--body"].includes(flag))
      options[flag.slice(2)] = value;
    else throw new Error(`unknown argument ${flag}\n${usage()}`);
    index++;
  }
  if (verb === "pack" && (!options.base || !options.name))
    throw new Error(`pack requires --base and --name\n${usage()}`);
  return options;
}

async function main(argv) {
  const options = parse(argv);
  const env = process.env;
  const repoRoot = await realpath(
    await gitText(process.cwd(), env, ["rev-parse", "--show-toplevel"]),
  );
  if (options.verb === "pack") {
    const manifest = await packChangeSet({
      repoRoot,
      changeSetDir: options.dir,
      base: options.base,
      name: options.name,
      subject: options.subject,
      body: options.body,
      trailers: options.trailers,
      env,
    });
    for (const entry of manifest.files)
      console.log(`packed   ${entry.before === null ? "A" : "M"} ${entry.path} after=${entry.after}`);
    console.log(
      `packed   ${manifest.files.length} file(s) into manifest.json (base ${manifest.base}, name ${manifest.name})`,
    );
    return;
  }
  const receipt = await applyChangeSet({ repoRoot, changeSetDir: options.dir, env });
  for (const entry of receipt.files)
    console.log(`${entry.status.padEnd(9)} ${entry.path} sha256=${entry.after}`);
  console.log(
    `applied  change set ${receipt.name}: ${receipt.files.length} file(s) on ${receipt.branch}`,
  );
  console.log(`applied  base ${receipt.base}`);
  console.log(`applied  head ${receipt.headBefore} -> ${receipt.headAfter}`);
  console.log(receipt.commit ? `commit   ${receipt.commit}` : "commit   none (manifest has no commit block)");
  console.log("next     run the gate commands from the run sheet, then report this receipt verbatim");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(/(^|\n)STOP: /u.test(error.message) ? error.message : `STOP: ${error.message}`);
    process.exitCode = 1;
  }
}
