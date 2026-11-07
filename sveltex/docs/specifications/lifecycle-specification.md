# Lifecycle Specification

## Startup contract

Startup is a single well-defined operation. Concurrent calls should either share the same startup promise or reject consistently; they must not initialize resources twice.

## Startup order

Modules and their resources initialize dependency-first. If resource B depends on A, A must be ready before B initializes.

## Failure rollback

If initialization fails:
1. Preserve the initialization error.
2. Stop already initialized resources in reverse order.
3. Attempt all rollback handlers.
4. Record rollback failures.
5. Mark the application failed.
6. Reject startup.

## Shutdown contract

- Shutdown is safe to call more than once.
- Shutdown attempts all cleanup handlers.
- Cleanup order is reverse startup order.
- A failure in one cleanup handler does not skip the rest.
- Final state is stopped, with errors reported to the caller.

## Hooks

Hook signatures should be typed and narrow. Hooks must not mutate framework internals or alter dependency graph ordering.
