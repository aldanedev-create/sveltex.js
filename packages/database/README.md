# @sveltex/database

Driver-neutral database lifecycle and transaction contracts for SvelteX. Install a database-specific driver separately and pass it to `new Database(driver)`.

```ts
const db = new Database(driver);
await db.connect();
try {
  const users = await db.query('select id, email from users where id = ?', [userId]);
  await db.transaction(async tx => {
    await tx.query('update accounts set balance = balance - ? where id = ?', [amount, accountId]);
  });
} finally { await db.close(); }
```

Transaction executors become invalid as soon as the transaction callback settles. The package does not parse, interpolate, or sanitize SQL. Use parameterized queries and a trusted driver. Do not share one connection-bound transaction executor outside its callback. Choose a driver with pooling, TLS, migrations and dialect-specific protections appropriate to deployment.
