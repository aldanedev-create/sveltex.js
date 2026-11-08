export interface DependencyEntry {
  readonly name: string;
  readonly version: string;
}

interface Section {
  readonly open: number;
  readonly close: number;
  readonly indent: string;
  readonly closingIndent: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locate a JSON object section with a string-aware brace scan. */
function findSection(source: string, key: string): Section | undefined {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*\\{`).exec(source);
  if (match === null) return undefined;
  const open = match.index + match[0].length - 1;
  const lineStart = source.lastIndexOf('\n', match.index) + 1;
  const baseIndent = source.slice(lineStart, match.index);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return Object.freeze({ open, close: index, indent: `${baseIndent}  `, closingIndent: baseIndent });
      }
    }
  }
  return undefined;
}

/**
 * Insert dependencies with a minimal text edit. Comments and formatting outside
 * the touched section are preserved; the manifest is never wholly rewritten.
 */
export function insertDependencies(source: string, entries: readonly DependencyEntry[], sectionName: 'dependencies' | 'devDependencies' = 'dependencies'): string {
  const section = findSection(source, sectionName);
  const inner = section === undefined ? '' : source.slice(section.open + 1, section.close);
  const existing = new Set<string>();
  for (const match of inner.matchAll(/"([^"]+)"\s*:/g)) {
    const name = match[1];
    if (name !== undefined) existing.add(name);
  }
  const additions = entries.filter((entry) => !existing.has(entry.name));
  if (additions.length === 0) return source;

  const lines = additions
    .map((entry) => `${section === undefined ? '    ' : section.indent}${JSON.stringify(entry.name)}: ${JSON.stringify(entry.version)}`)
    .join(',\n');

  if (section === undefined) {
    const rootOpen = source.indexOf('{');
    if (rootOpen === -1) throw new Error('package.json has no root object.');
    const block = `\n  "${sectionName}": {\n${lines}\n  },`;
    return `${source.slice(0, rootOpen + 1)}${block}${source.slice(rootOpen + 1)}`;
  }

  if (inner.trim() === '') {
    return `${source.slice(0, section.open + 1)}\n${lines}\n${section.closingIndent}${source.slice(section.close)}`;
  }
  return `${source.slice(0, section.open + 1)}\n${lines},${source.slice(section.open + 1)}`;
}

/** Remove named dependencies from both dependency sections with a minimal text edit. */
export function removeDependencies(source: string, names: readonly string[]): string {
  let result = source;
  for (const sectionName of ['dependencies', 'devDependencies'] as const) {
    const section = findSection(result, sectionName);
    if (section === undefined) continue;
    const inner = result.slice(section.open + 1, section.close);
    const patterns = names.map((name) => new RegExp(`^\\s*${escapeRegExp(JSON.stringify(name))}\\s*:`));
    const kept = inner.split('\n').filter((line) => !patterns.some((pattern) => pattern.test(line)));
    let last = -1;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if ((kept[index] ?? '').trim() !== '') { last = index; break; }
    }
    const replacement = last === -1 ? '' : kept.join('\n').replace(/,(\s*)$/, '$1');
    result = `${result.slice(0, section.open + 1)}${replacement}${result.slice(section.close)}`;
  }
  return result;
}
