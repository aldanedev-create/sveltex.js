# Configuration

## Goals

Configuration should be typed, validated, environment-aware, and predictable. Configuration loading must not silently create external resources.

## Proposed user-facing shape

```ts
import { defineConfig } from '@sveltex/core';

export default defineConfig({
  app: {
    name: 'TaskFlow',
    environment: process.env.NODE_ENV ?? 'development'
  },
  modules: [
    './src/modules/users',
    './src/modules/tasks'
  ]
});
```

This is illustrative. The exact schema will be finalized during core implementation.

## Requirements

- `defineConfig` should preserve TypeScript inference.
- Configuration validation should return actionable paths and messages.
- Unknown keys should be rejected or warned about according to a documented policy.
- Secrets should be read from environment variables or secret providers, not committed.
- Normalized configuration should be immutable from the consumer's perspective.
- Defaults must be documented.
- Optional integrations must not be required by core.
- Loading configuration must not connect to databases, Redis, email providers, or other services.
- Environment-specific behavior must be explicit.

## Configuration lifecycle

1. Load the user's configuration module.
2. Apply documented defaults.
3. Validate structural and semantic constraints.
4. Normalize values.
5. Freeze or otherwise protect the resulting configuration.
6. Pass it to application construction.

Do not log secret values in validation errors or diagnostics.
