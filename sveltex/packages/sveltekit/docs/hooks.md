# SvelteKit hooks

The adapter exposes `createSvelteXHandler(app)` as a SvelteKit `Handle`. Keep your normal `src/hooks.server.ts` and compose it using SvelteKit's own `sequence` utility:

```ts
import { sequence } from '@sveltejs/kit/hooks';
import { createSvelteXHandler } from '@sveltex/sveltekit';
import { app } from '$lib/server/sveltex';
import { auditHandle } from '$lib/server/audit';

export const handle = sequence(createSvelteXHandler(app), auditHandle);
```

Place SvelteX before handles that need to resolve SvelteX services or inspect `event.locals.sveltex`. The SvelteX handle installs the request context before calling the next handle and removes it after the downstream chain returns.

SvelteKit's `sequence` is preferred for real SvelteKit applications because it owns framework-specific hook composition semantics. The adapter's `composeHandlers` and `HandlerPipeline` are framework-neutral helpers for custom integrations and tests. They preserve resolver options, support short-circuit responses, and reject a second call to the same next resolver.

Do not overwrite `event.locals.sveltex`. Use a different `localsKey` if your application already owns that property:

```ts
export const handle = createSvelteXHandler(app, { localsKey: 'services' });
```
