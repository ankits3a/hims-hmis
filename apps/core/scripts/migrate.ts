import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("migrations applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
