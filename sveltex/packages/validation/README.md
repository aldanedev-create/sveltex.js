# @sveltex/validation

Standard Schema v1-compatible validation primitives for server input and application boundaries.

## Install

```sh
pnpm add @sveltex/validation
```

## Validate input

```ts
import { safeValidate, validate } from '@sveltex/validation';

const result = await safeValidate(schema, input);
if (!result.success) {
  // Return a controlled 400/422 response from your SvelteKit endpoint/action.
  console.error(result.issues);
} else {
  const data = result.data;
}

// Or throw ValidationError when invalid input should follow your error path.
const data = await validate(schema, input);
```

The package accepts Standard Schema v1 implementations and normalizes issue paths. It does not require Zod, Valibot, or another schema library as a runtime dependency.

## Status

Initial 0.1.0 foundation. HTTP response mapping and provider-specific convenience adapters are not included yet.
