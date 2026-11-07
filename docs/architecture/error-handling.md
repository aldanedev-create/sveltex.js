# Error Handling

## Principles

- Errors should be typed and actionable.
- Preserve the original cause.
- Avoid leaking secrets, credentials, SQL parameters, or personal data in messages.
- Distinguish configuration, module graph, provider resolution, lifecycle, request, and integration failures.
- Do not swallow errors silently.

## Proposed categories

- `CONFIGURATION_ERROR`
- `MODULE_DUPLICATE`
- `MODULE_NOT_FOUND`
- `MODULE_CYCLE`
- `PROVIDER_NOT_FOUND`
- `PROVIDER_CYCLE`
- `PROVIDER_CREATION_FAILED`
- `APPLICATION_INVALID_STATE`
- `APPLICATION_START_FAILED`
- `APPLICATION_STOP_FAILED`
- `REQUEST_SCOPE_DISPOSE_FAILED`

Exact class names and codes will be finalized during implementation.

## Aggregated cleanup errors

When several shutdown hooks fail, all hooks should still be attempted. Report a primary failure plus structured secondary failures, using `AggregateError` where supported by the chosen runtime baseline.

## SvelteKit boundary

The SvelteKit adapter must preserve native error behavior unless the developer explicitly configures an error mapping. Framework errors should not automatically become successful responses or expose internal stack traces to production users.
