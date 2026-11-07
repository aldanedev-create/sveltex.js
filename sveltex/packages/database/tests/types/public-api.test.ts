import { Database, type DatabaseDriver, type QueryResult } from '../../dist/index.js';
interface UserRow extends Record<string, unknown> { id: number; email: string; }
declare const driver: DatabaseDriver;
const db = new Database(driver);
const result: Promise<QueryResult<UserRow>> = db.query<UserRow>('select id, email from users where id = ?', [1]);
void result;
