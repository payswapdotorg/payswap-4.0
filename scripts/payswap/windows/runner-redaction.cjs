// 凭据置换与泄漏处置原语（自 run-p2-acceptance.cjs 拆出 —— 800 行仓库上限）。
// RedactingLog 流式 carry-over 置换 + 工件字节级泄漏自检/就地消毒。

const fsp = require("node:fs/promises");
const path = require("node:path");

const REDACTION = "<redacted-live-key>";


/** secret 在 pending 尾部的最长「真前缀」后缀长度（0..secret.length-1）——
 *  跨 chunk 分裂的凭据前半会停在这里，直到后续 chunk 补全或 flush 兜底置换。 */
function longestSecretPrefixSuffix(text, secret) {
  const max = Math.min(secret.length - 1, text.length);
  for (let len = max; len >= 1; len -= 1) {
    if (secret.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

class RedactingLog {
  constructor(filePath, secret, options = {}) {
    this.filePath = filePath;
    this.secret = secret && secret.length > 0 ? secret : null;
    this.chunks = [];
    this.scrubbed = 0;
    this.echo = options.echo !== false;
    this.pending = ""; // 未定稿的原文尾部（可能携带分裂凭据的前缀，永不落盘/回显）
  }
  /** 流式置换：完整命中即刻置换；尾部最长 secret.length-1 字符扣留待续。
   *  任何时刻 emitted+pending 的拼接与原文流一致，但 emitted 永不含完整键值 ——
   *  单 chunk、双 chunk、逐字节分裂、stderr 混流均覆盖。 */
  append(text) {
    if (!text) return;
    this.pending += text;
    let emitLen;
    if (this.secret) {
      const last = this.pending.lastIndexOf(this.secret);
      if (last >= 0) {
        const afterStart = last + this.secret.length;
        const rest = this.pending.slice(afterStart);
        emitLen = afterStart + rest.length - longestSecretPrefixSuffix(rest, this.secret);
        this.scrubbed += 1;
      } else {
        emitLen = this.pending.length - longestSecretPrefixSuffix(this.pending, this.secret);
      }
    } else {
      emitLen = this.pending.length;
    }
    const emitRaw = this.pending.slice(0, emitLen);
    this.pending = this.pending.slice(emitLen);
    const emitSafe = this.secret ? emitRaw.split(this.secret).join(REDACTION) : emitRaw;
    if (emitSafe) {
      this.chunks.push(emitSafe);
      if (this.echo) process.stdout.write(emitSafe);
    }
  }
  /** flush：扣留尾部兜底置换（此处必然无后续 chunk，可全量产出），再落盘。 */
  async flush() {
    let emitSafe;
    if (this.secret) {
      const last = this.pending.lastIndexOf(this.secret);
      if (last >= 0) {
        this.scrubbed += 1;
        emitSafe = this.pending.slice(0, last) + REDACTION + this.pending.slice(last + this.secret.length);
      } else {
        emitSafe = this.pending;
      }
      this.pending = "";
    } else {
      emitSafe = this.pending;
      this.pending = "";
    }
    if (emitSafe) {
      this.chunks.push(emitSafe);
      if (this.echo) process.stdout.write(emitSafe);
    }
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = this.chunks.join("");
    if (this.secret && body.includes(this.secret)) {
      // 纵深防御：理论上不可达 —— 命中即说明置换不变量被破坏，绝不写原文。
      throw new Error(`redaction invariant violated for ${this.filePath}`);
    }
    await fsp.writeFile(this.filePath, body, "utf8");
  }
}


/** 工件字节级泄漏自检（返回命中的文件名列表；空 = 干净）。 */
async function leakScan(dir, secret) {
  if (!secret) return [];
  const hits = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const buf = await fsp.readFile(full);
        if (buf.includes(Buffer.from(secret, "utf8"))) hits.push(path.relative(dir, full));
      }
    }
  }
  await walk(dir);
  return hits;
}

/** 污染工件就地消毒（命中字节置换为 REDACTION 标记）；返回已消毒文件列表。
 *  manifest 与 summary 只允许在消毒后复扫干净的艺术品上产生。 */
async function sanitizeLeaks(dir, secret) {
  if (!secret) return [];
  const sanitized = [];
  async function walk(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const buf = await fsp.readFile(full);
        const needle = Buffer.from(secret, "utf8");
        if (buf.includes(needle)) {
          await fsp.writeFile(full, buf.toString("utf8").split(secret).join(REDACTION), "utf8");
          sanitized.push(path.relative(dir, full));
        }
      }
    }
  }
  await walk(dir);
  return sanitized;
}

module.exports = { REDACTION, longestSecretPrefixSuffix, RedactingLog, leakScan, sanitizeLeaks };
