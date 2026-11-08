import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface RouteInfo {
  readonly path: string;
  readonly kinds: readonly ('page' | 'endpoint' | 'layout')[];
  readonly files: readonly string[];
}

const PAGE_FILES = new Set(['+page.svelte', '+page.ts', '+page.js', '+page.server.ts', '+page.server.js']);
const ENDPOINT_FILES = new Set(['+server.ts', '+server.js']);
const LAYOUT_FILES = new Set(['+layout.svelte', '+layout.ts', '+layout.js', '+layout.server.ts', '+layout.server.js']);

function routePath(directory: string, routesRoot: string): string {
  const rel = relative(routesRoot, directory).split('\\').join('/');
  if (rel === '') return '/';
  const segments = rel.split('/').filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment));
  if (segments.length === 0) return '/';
  return `/${segments.map((segment) => {
    const match = /^\[\.\.\.(.+)\]$/.exec(segment);
    if (match !== null) return `:${match[1]}..`;
    if (segment.startsWith('[') && segment.endsWith(']')) return `:${segment.slice(1, -1)}`;
    return segment;
  }).join('/')}`;
}

/**
 * Derive routes from the SvelteKit filesystem convention only. No SvelteKit
 * build metadata is required and no project code is executed.
 */
export async function collectRoutes(root: string): Promise<readonly RouteInfo[]> {
  const routesRoot = join(root, 'src', 'routes');
  const grouped = new Map<string, { kinds: Set<RouteInfo['kinds'][number]>; files: string[] }>();

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let kind: RouteInfo['kinds'][number] | undefined;
      if (PAGE_FILES.has(entry.name)) kind = 'page';
      else if (ENDPOINT_FILES.has(entry.name)) kind = 'endpoint';
      else if (LAYOUT_FILES.has(entry.name)) kind = 'layout';
      if (kind === undefined) continue;
      const path = routePath(directory, routesRoot);
      const group = grouped.get(path) ?? { kinds: new Set<RouteInfo['kinds'][number]>(), files: [] };
      group.kinds.add(kind);
      group.files.push(relative(root, full).split('\\').join('/'));
      grouped.set(path, group);
    }
  }

  await walk(routesRoot);
  return Object.freeze([...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, group]) => Object.freeze({
      path,
      kinds: Object.freeze([...group.kinds].sort()),
      files: Object.freeze(group.files.sort()),
    })));
}
