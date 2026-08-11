import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/kernel/db/client";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev";
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("migrations applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
