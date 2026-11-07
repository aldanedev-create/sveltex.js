# ADR-008: Deployment Capabilities Must Be Explicit

- **Status:** Accepted
- **Decision:** SvelteX must not assume that every SvelteKit adapter supports persistent processes, filesystem access, scheduled tasks, or WebSockets.

## Consequences

- Capability requirements are documented per integration.
- Persistent jobs use separately deployed workers or managed services.
- Realtime support may require an external gateway or a compatible long-running server.
- Unsupported configurations produce actionable diagnostics.
