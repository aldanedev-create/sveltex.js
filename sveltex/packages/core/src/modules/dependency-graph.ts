import { SvelteXError } from '../errors/framework-error.js';
import type { ModuleDefinition } from './module.types.js';

/** Stable topological ordering: original registration order breaks ties. */
export function orderModules(modules: readonly ModuleDefinition[]): readonly ModuleDefinition[] {
  const byName = new Map<string, ModuleDefinition>();
  for (const module of modules) {
    if (byName.has(module.name)) throw new SvelteXError('SX_MODULE_DUPLICATE', `Module "${module.name}" is registered more than once.`);
    byName.set(module.name, module);
  }
  for (const module of modules) {
    for (const dependency of module.dependencies ?? []) {
      if (dependency === module.name) throw new SvelteXError('SX_MODULE_CYCLE', `Module "${module.name}" cannot depend on itself.`);
      if (!byName.has(dependency)) throw new SvelteXError('SX_MODULE_MISSING_DEPENDENCY', `Module "${module.name}" depends on missing module "${dependency}".`);
    }
  }
  const state = new Map<string, 0 | 1 | 2>();
  const ordered: ModuleDefinition[] = [];
  const stack: string[] = [];
  const visit = (name: string): void => {
    const status = state.get(name) ?? 0;
    if (status === 2) return;
    if (status === 1) {
      const start = stack.indexOf(name);
      const cycle = [...stack.slice(start), name];
      throw new SvelteXError('SX_MODULE_CYCLE', `Module dependency cycle: ${cycle.join(' -> ')}.`, { details: { cycle } });
    }
    state.set(name, 1);
    stack.push(name);
    const current = byName.get(name)!;
    for (const dependency of current.dependencies ?? []) visit(dependency);
    stack.pop();
    state.set(name, 2);
    ordered.push(current);
  };
  for (const module of modules) visit(module.name);
  return Object.freeze(ordered);
}
