# Module System

## Purpose

Modules provide an explicit way to group application providers and declare dependencies. They are application composition units, not plugins.

## Proposed module shape

```ts
import { defineModule } from '@sveltex/core';

export const TasksModule = defineModule({
  name: 'tasks',
  dependencies: ['database', 'users'],
  providers: [TaskService, TaskRepository],
  exports: [TaskService]
});
```

The example is a proposed API, not implemented code.

## Required behavior

- Module names are non-empty and unique.
- Dependencies must refer to registered modules or documented built-ins.
- Circular dependencies are rejected with a useful cycle path.
- Initialization order is deterministic and dependency-first.
- Duplicate registration is rejected unless an explicit replacement API is later justified.
- Exports define what other modules may resolve through module boundaries.
- Module metadata is validated before any module is initialized.
- Registration should be repeatable only where explicitly documented; accidental double registration must be detected.

## Dependency graph

The graph builder should:
1. Validate every module descriptor.
2. Build edges from dependency to dependent.
3. Detect missing nodes.
4. Detect cycles.
5. Produce a deterministic topological ordering.

The implementation should use a well-understood graph algorithm and test edge cases. Error messages should identify the modules involved.

## Scope

The first core version only needs static module descriptors and graph resolution. Dynamic module factories, conditional imports, auto-discovery, and hot replacement should be postponed until a demonstrated use case exists.
