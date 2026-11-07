# Dependency injection

Register providers in Core modules. Singleton providers are shared by the application root, request providers belong to one request scope, and transient providers are constructed per resolution. Request-scoped providers must be resolved from `locals.sveltex`, not from the application root.
