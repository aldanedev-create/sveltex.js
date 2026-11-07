# Test Requirements

## Configuration

- Valid minimal configuration.
- Valid full configuration.
- Missing required values.
- Invalid types and unsupported options.
- Unknown keys policy.
- Secret values never appear in error output.
- Importing core causes no external side effects.

## Module graph

- Empty graph.
- Single module.
- Linear dependencies.
- Multiple independent modules.
- Deterministic ordering.
- Duplicate module names.
- Missing dependency.
- Self-dependency.
- Two-node cycle.
- Longer cycle.
- Multiple cycles.
- Large graph behavior.

## Dependency injection

- Singleton returns the same instance.
- Concurrent singleton resolutions construct once.
- Transient returns distinct instances.
- Request provider is scoped to one request.
- Two overlapping request scopes do not share request instances.
- Missing token error.
- Direct and indirect provider cycles.
- Async factory success and failure.
- Cleanup after scope disposal.
- Repeated disposal.
- Failed factory retry behavior.

## Lifecycle

- Correct dependency-first startup.
- Reverse-order shutdown.
- Startup called twice.
- Concurrent startup calls.
- Shutdown before startup.
- Shutdown called twice.
- Initializer failure.
- Rollback after partial startup.
- Multiple cleanup failures.
- State transition validation.

## SvelteKit integration (later stage)

- Page request.
- Server load.
- Form action.
- `+server.ts` endpoint.
- Existing `handle` composition.
- Hook order.
- Concurrent request isolation.
- Request cleanup on success and error.
- SSR production build.
- Development reload behavior.
- Native SvelteKit APIs remain usable.

## CLI (later stage)

- Generate a valid application.
- Install and build generated app.
- Windows path handling.
- Spaces and Unicode in project path.
- Existing directory protection.
- Invalid command arguments.
- Missing package manager.
- Network/install failure diagnostics.
- Idempotent doctor/inspection commands.
