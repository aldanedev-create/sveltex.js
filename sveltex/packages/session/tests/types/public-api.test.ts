import { MemorySessionStore, SessionManager, type SessionStore } from '../../dist/index.js';
type Data = { userId: string };
const store: SessionStore<Data> = new MemorySessionStore<Data>();
const manager = new SessionManager<Data>(store);
const created: Promise<Readonly<{ id: string; data: Readonly<Data>; createdAt: number; expiresAt: number; revision: number }>> = manager.create({ userId: 'u1' });
void created;
