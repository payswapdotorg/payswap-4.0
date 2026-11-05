/**
 * PaySwap canonical JSON（RFC 8785 — JSON Canonicalization Scheme，契约 w2-01 §6.4(5)）。
 *
 * 纪律（§6.4(5)，normative）：响应签名覆盖的是 envelope 的 **canonical JSON** 序列化 ——
 * UTF-8、对象键递归排序（UTF-16 码元序）、无空白。host（签名）与 child（验签）必须共用
 * **同一份实现**（本模块）；两份实现漂移即违约。属性测试钉住往返稳定性：
 * `canonical(parse(canonical(x))) === canonical(x)` 对协议产生的每个 envelope 成立。
 *
 * 拒绝面（§6.4(5)）：非有限数字（Infinity/NaN）与一切非 JSON 值（undefined、BigInt、
 * symbol、function、非 plain 对象/数组）必须抛错 —— 协议永远不签名它无法确定性序列化的
 * 值；child 侧对收到的 envelope 做同一 canonicalization，失败即整封拒绝（rev 2a，F16）。
 */

export class PayswapCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayswapCanonicalizationError";
  }
}

/**
 * RFC 8785 (JCS) canonical JSON serialization.
 *
 * - null / boolean / string / number / array / plain object only;
 * - object keys sorted recursively in UTF-16 code-unit order (JCS §3.2.3 —— 默认
 *   `Array.prototype.sort` 的比较即码元序，绝不能用 locale 比较);
 * - no insignificant whitespace;
 * - strings escaped per ECMAScript `JSON.stringify` (ES2019+ 与 JCS 的转义规则一致，
 *   含 lone surrogate 的 well-formed 转义);
 * - numbers serialized per ECMAScript JSON semantics (JCS §3.2.2.3 引用的正是它);
 * - throws PayswapCanonicalizationError on anything a JSON document cannot carry.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeValue(value, "$");
}

function serializeValue(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      // ES2019+ 的 JSON.stringify 与 JCS 字符串转义一致（含 \u0000-\u001f 小写十六进制转义）。
      return JSON.stringify(value);
    case "bigint":
    case "symbol":
    case "function":
    case "undefined":
      throw new PayswapCanonicalizationError(
        `canonical JSON cannot serialize ${typeof value} at ${path} (RFC 8785 / 契约 §6.4(5))`,
      );
    case "object":
      return serializeObject(value, path);
    default:
      throw new PayswapCanonicalizationError(`unsupported value at ${path}`);
  }
}

function serializeNumber(value: number, path: string): string {
  // JSON 没有非有限数字的位置；-0 序列化为 0（ES 语义），1e21 → "1e+21"。
  if (!Number.isFinite(value)) {
    throw new PayswapCanonicalizationError(
      `non-finite number at ${path} cannot be canonicalized (RFC 8785 / 契约 §6.4(5))`,
    );
  }
  return JSON.stringify(value);
}

function serializeObject(value: object, path: string): string {
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (item === undefined) {
        // 稀疏数组洞读作 undefined —— JSON 无法承载，必须拒绝而非静默丢位。
        throw new PayswapCanonicalizationError(
          `array hole / undefined at ${path}[${index}] cannot be canonicalized`,
        );
      }
      parts.push(serializeValue(item, `${path}[${index}]`));
    }
    return `[${parts.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Date/Map 等类实例不是 JSON 类型；隐性 toJSON 转换会引入非确定性 —— 拒绝。
    throw new PayswapCanonicalizationError(
      `non-plain object at ${path} cannot be canonicalized (RFC 8785 / 契约 §6.4(5))`,
    );
  }
  for (const symbolKey of Object.getOwnPropertySymbols(value)) {
    if (Object.getOwnPropertyDescriptor(value, symbolKey)?.enumerable) {
      throw new PayswapCanonicalizationError(
        `symbol key at ${path} cannot be canonicalized`,
      );
    }
  }

  // UTF-16 码元序（默认 sort），递归适用到每一层。
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) {
      throw new PayswapCanonicalizationError(
        `undefined value at ${path}.${key} cannot be canonicalized`,
      );
    }
    parts.push(`${JSON.stringify(key)}:${serializeValue(entry, `${path}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}
