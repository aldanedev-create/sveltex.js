# @sveltex/shared

Framework-neutral types and small utilities shared by SvelteX packages.

## Install

```sh
pnpm add @sveltex/shared
```

## Public API

```ts
import {
  SvelteXError,
  isPlainObject,
  toError,
  type Awaitable,
  type Disposable,
} from '@sveltex/shared';

const error = new SvelteXError('Provider failed', {
  code: 'PROVIDER_FAILED',
  details: { provider: 'database' },
});
```

Keep this package small. A type or utility belongs here only when multiple packages need the same framework-neutral contract.

## Status

Initial 0.1.0 foundation. APIs may change before 1.0.
