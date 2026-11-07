# Request-scoped authentication example

Register an authentication service with `scope: 'request'`, populate it from a SvelteKit `handle` that runs inside the SvelteX handler, then read it from `locals.sveltex` in server loads/actions. Never store a current user in a singleton provider: singleton instances are shared across requests.
