import { Pool } from "pg";
import { getConfig } from "./config";
const globalDb = globalThis as unknown as { webcardsPool?: Pool };
export function getDb() {
  return (globalDb.webcardsPool ??= new Pool({
    connectionString: getConfig().DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  }));
}
