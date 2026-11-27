import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  applyChangeSet,
  normalizeText,
  packChangeSet,
  safeRelativePath,
} from "../apply-change-set.mjs";

const exec = promisify(execFile);
const script = join(import.meta.dirname, "..", "apply-change-set.mjs");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const TRAILER = "Co-authored-by: Test <test@example.invalid>";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "change-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  // 配置经环境注入：工具内部的 git 调用必须拿到同一组设置（不签名、LF、不挂全局 hook）。
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.autocrlf",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "",
    // 身份也经环境注入：机器可能没有全局 user.name/email，而工具内部的提交同样需要它。
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = async (...args) => (await exec("git", args, { cwd: repo, env })).stdout.trim();
  await mkdir(join(repo, "packages", "old"), { recursive: true });
  await writeFile(join(repo, "packages", "old", "kept.ts"), "kept\n");
  await writeFile(join(repo, "packages", "old", "edited.ts"), "before\n");
  await git("init");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  return { repo, env, git, base: await git("rev-parse", "HEAD"), dir: join(root, "set") };
}

// 写入载荷并 pack；payloads 的键是仓库相对路径。
async function stage(f, payloads, options = {}) {
  for (const [path, content] of Object.entries(payloads)) {
    const target = join(f.dir, "files", ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return packChangeSet({
    repoRoot: f.repo,
    changeSetDir: f.dir,
    base: f.base,
    name: options.name ?? "demo",
    env: f.env,
    ...options,
  });
}

test("normalizeText strips a BOM, folds CRLF/CR to LF and keeps one trailing newline", () => {
  assert.equal(
    normalizeText(Buffer.concat([BOM, Buffer.from("a\r\nb\rc\n\n\n")])),
    "a\nb\nc\n",
  );
  assert.equal(normalizeText(Buffer.from("no newline")), "no newline\n");
  assert.equal(normalizeText(Buffer.alloc(0)), "");
  assert.throws(() => normalizeText(Buffer.from([0x61, 0x00, 0x62])), /binary content/);
  assert.throws(() => normalizeText(Buffer.from([0xff, 0xfe, 0xfd])), /utf-8/i);
});

test("safeRelativePath accepts repo-relative paths and refuses every escape", () => {
  assert.equal(safeRelativePath("packages/old/edited.ts"), "packages/old/edited.ts");
  const escapes = [
    "../escaped.ts",
    "/absolute.ts",
    "C:/drive.ts",
    "a\\b.ts",
    "a/../b.ts",
    "a//b.ts",
    ".",
    "",
    undefined,
  ];
  for (const bad of escapes) assert.throws(() => safeRelativePath(bad), /path must/);
});

test("pack pins before/after hashes and apply writes exact bytes, then commits only the listed files", async (t) => {
  const f = await fixture(t);
  // 载荷故意带 BOM、CRLF 和多余结尾换行：写出必须是规整后的 LF 字节。
  const manifest = await stage(
    f,
    {
      "packages/new/added.ts": "added\n",
      "packages/old/edited.ts": Buffer.concat([BOM, Buffer.from("after\r\nline\r\n\r\n")]),
    },
    { subject: "feat(demo): add a file", body: "Body line.", trailers: [TRAILER] },
  );
  assert.deepEqual(
    manifest.files.map((entry) => [entry.path, entry.before === null]),
    [
      ["packages/new/added.ts", true],
      ["packages/old/edited.ts", false],
    ],
  );
  assert.equal(
    await readFile(join(f.dir, "manifest.json"), "utf8"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const receipt = await applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env });
  assert.equal(await readFile(join(f.repo, "packages", "old", "edited.ts"), "utf8"), "after\nline\n");
  assert.equal(await readFile(join(f.repo, "packages", "new", "added.ts"), "utf8"), "added\n");
  assert.equal(await readFile(join(f.repo, "packages", "old", "kept.ts"), "utf8"), "kept\n");
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.equal(receipt.commit, await f.git("rev-parse", "HEAD"));
  assert.deepEqual(
    receipt.files.map((entry) => [entry.status, entry.path]),
    [
      ["added", "packages/new/added.ts"],
      ["modified", "packages/old/edited.ts"],
    ],
  );
  assert.equal(
    await f.git("show", "-s", "--format=%B", "HEAD"),
    `feat(demo): add a file\n\nBody line.\n\n${TRAILER}`,
  );
  assert.deepEqual(
    (await f.git("show", "--name-only", "--format=", "HEAD")).split("\n").sort(),
    ["packages/new/added.ts", "packages/old/edited.ts"],
  );
});

test("apply refuses a dirty worktree before touching any file", async (t) => {
  const f = await fixture(t);
  await stage(f, { "packages/new/added.ts": "added\n" });
  await writeFile(join(f.repo, "packages", "old", "kept.ts"), "dirty\n");
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: worktree is not clean[\s\S]*STOP: nothing was written/,
  );
  await assert.rejects(readFile(join(f.repo, "packages", "new", "added.ts")), { code: "ENOENT" });
});

test("apply is all-or-nothing when one file drifted from its base content", async (t) => {
  const f = await fixture(t);
  await stage(f, { "packages/new/added.ts": "added\n", "packages/old/edited.ts": "after\n" });
  await writeFile(join(f.repo, "packages", "old", "edited.ts"), "drifted\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "drift");
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: packages\/old\/edited\.ts: target no longer matches the base content/,
  );
  await assert.rejects(readFile(join(f.repo, "packages", "new", "added.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.repo, "packages", "old", "edited.ts"), "utf8"), "drifted\n");
});

test("apply refuses a payload that changed after pack", async (t) => {
  const f = await fixture(t);
  await stage(f, { "packages/new/added.ts": "added\n" });
  await writeFile(join(f.dir, "files", "packages", "new", "added.ts"), "tampered\n");
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: packages\/new\/added\.ts: payload does not match manifest\.after/,
  );
  await assert.rejects(readFile(join(f.repo, "packages", "new", "added.ts")), { code: "ENOENT" });
});

test("apply refuses a declared new file whose target already exists at HEAD", async (t) => {
  const f = await fixture(t);
  await stage(f, { "packages/new/added.ts": "added\n" });
  await mkdir(join(f.repo, "packages", "new"), { recursive: true });
  await writeFile(join(f.repo, "packages", "new", "added.ts"), "committed later\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "later");
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: packages\/new\/added\.ts: expected a new file but the target already exists/,
  );
});

test("apply refuses a base that is missing or not an ancestor of HEAD", async (t) => {
  const f = await fixture(t);
  await stage(f, { "packages/new/added.ts": "added\n" });
  const manifestPath = join(f.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, base: "1".repeat(40) }));
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: git failed:/,
  );
  await writeFile(manifestPath, JSON.stringify(manifest));
  await f.git("checkout", "--orphan", "solo");
  await f.git("commit", "-m", "solo");
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: base [0-9a-f]{40} is not an ancestor of HEAD/,
  );
});

test("apply refuses unsafe manifest paths and a change set inside the worktree", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.dir, "files"), { recursive: true });
  await writeFile(
    join(f.dir, "manifest.json"),
    JSON.stringify({
      schema: 1,
      name: "evil",
      base: f.base,
      files: [{ path: "../escaped.ts", before: null, after: "0".repeat(64) }],
    }),
  );
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: manifest\.files\[0\]: path must not contain empty, "\." or "\.\." segments/,
  );
  const inside = join(f.repo, "set");
  await mkdir(inside);
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: inside, env: f.env }),
    /STOP: the change-set directory must live outside the repository worktree/,
  );
});

test("apply without a commit block writes the files and leaves the index untouched", async (t) => {
  const f = await fixture(t);
  await stage(f, { "packages/old/edited.ts": "after\n" });
  const receipt = await applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env });
  assert.equal(receipt.commit, null);
  assert.equal(receipt.headAfter, f.base);
  assert.equal(receipt.branch, await f.git("rev-parse", "--abbrev-ref", "HEAD"));
  assert.equal(await readFile(join(f.repo, "packages", "old", "edited.ts"), "utf8"), "after\n");
  assert.equal(await f.git("diff", "--cached", "--name-only"), "");
  // git status --porcelain 的首列是暂存区状态；fixture 的 git 助手会 trim 掉行首空格，
  // 这里必须用未 trim 的原始输出逐行断言，才能验证「索引未被触碰」（空格 + M）。
  const status = (await exec("git", ["status", "--porcelain"], { cwd: f.repo, env: f.env })).stdout;
  assert.deepEqual(status.split("\n").filter(Boolean), [" M packages/old/edited.ts"]);
});

test("apply refuses a malformed or empty manifest", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.dir, "files"), { recursive: true });
  const manifestPath = join(f.dir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ schema: 1, name: "bad", base: f.base, files: [] }),
  );
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
    /STOP: manifest\.files must be a non-empty array/,
  );
  for (const content of ["{not json", "null", "[]"]) {
    await writeFile(manifestPath, content);
    await assert.rejects(
      applyChangeSet({ repoRoot: f.repo, changeSetDir: f.dir, env: f.env }),
      /STOP: manifest\.json (is missing or not valid JSON|must contain a JSON object)/,
    );
  }
  await assert.rejects(
    applyChangeSet({ repoRoot: f.repo, changeSetDir: join(f.dir, "missing"), env: f.env }),
    /STOP: change-set directory not found/,
  );
});

test("pack refuses binary payloads and never overwrites an existing manifest", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stage(f, { "packages/new/blob.bin": Buffer.from([0x00, 0x01]) }),
    /STOP: packages\/new\/blob\.bin: binary content/,
  );
  await assert.rejects(readFile(join(f.dir, "manifest.json")), { code: "ENOENT" });
  // 拒收不改写目录：change-set 里还留着那次拒收的二进制载荷。不删掉它，下一次
  // pack 会先撞上二进制拒收，而不是这一步要验证的 manifest 覆盖拒收。
  await rm(join(f.dir, "files", "packages", "new", "blob.bin"));
  await stage(f, { "packages/new/added.ts": "added\n" });
  await assert.rejects(
    stage(f, { "packages/new/added.ts": "added\n" }),
    /STOP: manifest\.json already exists/,
  );
});

test("the CLI packs, applies and exits 1 with a STOP line without writing on failure", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.dir, "files"), { recursive: true });
  await writeFile(join(f.dir, "files", "note.txt"), "note\n");
  const run = (args) => exec(process.execPath, [script, ...args], { cwd: f.repo, env: f.env });
  const packed = await run([
    "pack",
    f.dir,
    "--base",
    f.base,
    "--name",
    "cli",
    "--subject",
    "feat(cli): add note",
  ]);
  assert.match(packed.stdout, /packed   1 file\(s\) into manifest\.json \(base [0-9a-f]{40}, name cli\)/);
  const applied = await run(["apply", f.dir]);
  assert.match(applied.stdout, /commit   [0-9a-f]{40}\nnext     run the gate commands/u);
  assert.equal(await readFile(join(f.repo, "note.txt"), "utf8"), "note\n");
  await writeFile(join(f.dir, "files", "note.txt"), "tampered\n");
  await assert.rejects(run(["apply", f.dir]), (error) =>
    error.code === 1 && /STOP: note\.txt: payload does not match manifest\.after/u.test(error.stderr),
  );
  await assert.rejects(run(["apply"]), /usage:/);
});
