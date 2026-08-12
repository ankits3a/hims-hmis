import { Client } from "pg";
import { requireEnv } from "../src/kernel/config";

async function main(): Promise<void> {
  const client = new Client({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();
  const res = await client.query("select version()");
  console.log(res.rows[0].version);
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
