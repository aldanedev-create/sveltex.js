# Deployment

The adapter does not assume a persistent Node process and does not register process signal handlers. Keep app-wide state in singleton services only when it is safe to share. Never store request data in singleton services. Verify behavior with the actual SvelteKit adapter (Node, serverless, or edge) used in production.
