/**
 * Canonical JSON: deterministic serialisation used for hashing (audit chain, export checksums).
 *
 *  - Object keys sorted by UTF-16 code unit order; no whitespace.
 *  - `undefined` object properties and functions/symbols are omitted (as JSON.stringify does);
 *    inside arrays they become `null`.
 *  - Non-finite numbers → null; -0 → 0; bigint → decimal string.
 *  - Date → ISO string; Uint8Array → { "$bytes": "<base64>" } so binary data hashes stably.
 *  - Cycles throw (a cyclic value can never be hashed deterministically).
 */

export function canonicalJson(value: unknown): string {
  return write(value, new Set<object>());
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? (Object.is(value, -0) ? '0' : JSON.stringify(value)) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }
  const obj = value as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'null' : JSON.stringify(obj.toISOString());
  if (obj instanceof Uint8Array) return `{"$bytes":${JSON.stringify(Buffer.from(obj).toString('base64'))}}`;
  if (seen.has(obj)) throw new TypeError('canonicalJson: cyclic structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((el) => write(el, seen)).join(',')}]`;
    const src = obj as Record<string, unknown>;
    // toJSON support (e.g. URL, custom classes) mirrors JSON.stringify semantics.
    const withToJson = src as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') return write(withToJson.toJSON(), seen);
    const keys = Object.keys(src).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const el = src[k];
      if (el === undefined || typeof el === 'function' || typeof el === 'symbol') continue;
      parts.push(`${JSON.stringify(k)}:${write(el, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
