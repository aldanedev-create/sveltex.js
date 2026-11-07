# Request context

Every request gets a fresh Core request container. Its request-scoped dependencies and disposables are isolated from other requests. Access it through `event.locals.sveltex`; use `getSvelteXContext(locals)` in reusable server-only functions. Do not retain the context beyond the request.
