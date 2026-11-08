/** Keys whose values must never be printed. See docs/specification.md §5.8. */
export const SECRET_KEY_PATTERN = /(token|secret|password|passwd|private[_-]?key|credential|api[_-]?key|access[_-]?key|client[_-]?secret|connection[_-]?string)/i;

export const REDACTED = '[REDACTED]';

export function isSecretKey(key: string, extraKeys: readonly string[] = []): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return extraKeys.some((extra) => extra.toLowerCase() === key.toLowerCase());
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-clone a value, replacing secret values with a redaction marker. */
export function redactValue(value: unknown, extraKeys: readonly string[] = []): unknown {
  return walk(value, undefined, extraKeys);
}

function walk(value: unknown, key: string | undefined, extraKeys: readonly string[]): unknown {
  if (key !== undefined && isSecretKey(key, extraKeys)) return REDACTED;
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => walk(entry, undefined, extraKeys)));
  if (isPlainRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = walk(entryValue, entryKey, extraKeys);
    }
    return Object.freeze(output);
  }
  return value;
}

/** Redact `KEY=value` style lines in raw text without ever echoing the value. */
export function redactEnvAssignments(text: string, extraKeys: readonly string[] = []): string {
  return text.split('\n').map((line) => {
    const match = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/.exec(line);
    if (match === null) return line;
    const key = match[1] ?? '';
    const name = key.replace(/=.*$/, '').replace(/^export\s+/, '').trim();
    const value = match[2] ?? '';
    if (value === '' || isSecretKey(name, extraKeys)) return `${key}${value === '' ? '' : REDACTED}`;
    return line;
  }).join('\n');
}
