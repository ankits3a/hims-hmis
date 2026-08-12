import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createAgent } from "../src/kernel/auth/agents";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const { id, apiKey } = await createAgent(db, requireEnv("AGENT_NAME"));
  await pool.end();
  console.log(`agent ${id} created — API key (shown once): ${apiKey}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
