# @sveltex/example-reference-app

Stage 3 退出标准的参考应用：用**真实的 `@sveltex/*` 包**把持久化、校验、认证、授权、会话与缓存端到端串起来。它不是一个演示用的假实现，也没有任何"未验证的支持声明"。

## 串联的包

| 关注点 | 包 | 本应用使用的真实实现 |
| --- | --- | --- |
| 持久化 | `@sveltex/database` | `SqliteAdapter`（`node:sqlite`）+ `Database` 生命周期/事务 |
| 校验 | `@sveltex/validation` | `validate` / `safeValidate` + 手写 Standard Schema v1 |
| 认证 | `@sveltex/auth` | `AuthService` + `Argon2Hasher`（Argon2id，`@node-rs/argon2`） |
| 会话 | `@sveltex/session` | `SessionManager` + `MemorySessionStore` 或 `RedisSessionStore`（Lua 原子脚本） |
| 缓存 | `@sveltex/cache` | `MemoryCache` 或 `RedisCache`（cache-aside + 写失效） |
| 授权 | 应用层 | 基于**数据库最新记录**的角色检查 |

## 运行

```sh
# 默认：进程内适配器（SQLite :memory: + MemorySessionStore + MemoryCache）
pnpm --filter @sveltex/example-reference-app build
pnpm --filter @sveltex/example-reference-app test

# 附带真实 Redis 集成（需要本机 Redis；不可用时该用例自动跳过，绝不伪造）
SVELTEX_REDIS_URL=redis://127.0.0.1:6379 \
  pnpm --filter @sveltex/example-reference-app test
```

`createApp({ redisUrl })` 会切换到真实的 `RedisSessionStore` + `RedisCache`（`ioredis`），并显式 `connect()` / `disconnect()`。不传 `redisUrl` 时使用进程内适配器——两条路径都是真实实现，没有 fake provider。

## 用法

```ts
import { createApp } from '@sveltex/example-reference-app';

const app = await createApp({
  databasePath: 'app.sqlite',
  redisUrl: process.env.REDIS_URL,        // 可选
  adminEmails: ['boss@example.com'],      // 唯一的可信授权来源
});

const user = await app.register({
  email: 'Alice@Example.com',
  password: 'correct-horse-battery-staple-42',
  displayName: 'Alice',
});

const token = await app.login('alice@example.com', 'correct-horse-battery-staple-42');
const post = await app.createPost(token.id, { title: 'Hello', body: 'World' });
const posts = await app.listPosts();

const rotated = await app.rotateSession(token.id); // 会话固定防御
await app.logout(rotated.id);
await app.close();
```

## 安全设计

- **不允许自助提权**：注册 payload 只接受 `email` / `password` / `displayName`。`roles` 绝不来自用户输入，`admin` 只能由可信的 `adminEmails` bootstrap 配置授予。
- **授权读新鲜记录**：`#principal()` 每次从 `users` 表读取当前角色，而不是信任会话载荷或缓存中的旧角色；`grantRole` 在事务内改权限并立即失效资料缓存。
- **`authorId` 来自会话**：`createPost` 忽略 payload 中任何 `authorId`，写入的归属一律取当前 principal。
- **参数化 SQL**：所有查询都用 `?` 占位符，绝不拼接用户输入。
- **原子轮换**：`AuthService.rotateSession` 经由 `SessionManager.rotate`，Redis 路径由 Lua `EVAL` 保证原子性；旧 id 立即失效。
- **Argon2id + 时间侧信道缓解**：`dummyPasswordHash` 是真实 Argon2id 哈希，用户不存在时也会做一次等价的 verify。
- **会话标识校验**：所有接受 session id 的方法统一校验 16–256 位 URL-safe 字符。

## 退出标准覆盖

| 能力 | 演示入口 |
| --- | --- |
| 持久化 | `register` / `createPost` 落 SQLite；`grantRole` 走事务 |
| 校验 | `register` / `createPost` 经 `validate(registerSchema/postSchema)` |
| 认证 | `login` / `logout` / `currentUser`（Argon2id 校验） |
| 授权 | `listUsers`（admin-only）/ `grantRole`（角色白名单） |
| 会话 | `login` 建会话、`rotateSession` 轮换、过期拒绝、跨实例（Redis）存活 |
| 缓存 | `listPosts` / `getPublicProfile` cache-aside + 写失效 |

## 不在范围内

Cookie 传输、CSRF、PostgreSQL/MySQL 适配器、迁移管理、HTTP 路由层均**未**在此声明支持；它们属于后续阶段的独立工作。本应用是库级装配，不是 Web 服务器。
