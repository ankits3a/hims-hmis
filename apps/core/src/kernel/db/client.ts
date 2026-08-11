import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
