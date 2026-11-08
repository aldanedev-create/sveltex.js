# Changelog

## 0.1.0

- Initial driver-neutral lifecycle and transaction facade.
- Added real `PostgresAdapter` (`pg.Pool`) and `MysqlAdapter` (`mysql2/promise` pool) with pooled
  connections, dedicated transaction connections, `AsyncLocalStorage`-backed nested savepoints, and
  correct reported row counts.
- Added driver-neutral `MigrationRunner` with SHA-256 checksums, ordered-prefix validation,
  transactional application, and built-in `sqlite`/`postgres`/`mysql` dialects.
- Added shared `PoolConfig` contract (`max`, `idleTimeoutMs`, `connectionTimeoutMs`,
  `acquireTimeoutMs`) with strict validation.
- Fixed `SqliteAdapter` `rowCount`: plain `INSERT`/`UPDATE`/`DELETE` now report affected rows via
  `total_changes()` instead of `0`.
- Raised this package's Node.js requirement to `>=22.5.0` to match `node:sqlite`; the other
  SvelteX packages still declare `>=20.11`.
- PostgreSQL/MySQL integration tests run against real servers; CI provisions PostgreSQL 16,
  MySQL 8.0 and Redis 7 services so integration tests execute instead of being skipped.
