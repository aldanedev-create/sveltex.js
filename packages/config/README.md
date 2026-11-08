# @sveltex/config

Typed configuration composition and validation helpers. This package performs no implicit filesystem access and does not read `process.env`.

## Install

```sh
pnpm add @sveltex/config
```

## Define and merge configuration

```ts
import { defineConfig, mergeConfig, validateConfig } from '@sveltex/config';

const base = defineConfig({ app: { name: 'Example' }, features: ['api'] });
const config = mergeConfig(base, { app: { name: 'Production' } });

const result = validateConfig(
  config,
  (value): value is typeof config => typeof value === 'object' && value !== null,
);
```

`defineConfig` clones and deeply freezes plain configuration data. `mergeConfig` recursively merges plain objects; arrays and scalar values from the override replace the base. Functions, symbols, and non-plain object instances are rejected.

## Status

Initial 0.1.0 foundation. Runtime config-file loading, environment expansion, schema libraries, and CLI integration are intentionally not included yet.
