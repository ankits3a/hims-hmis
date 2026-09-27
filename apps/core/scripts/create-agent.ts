import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createAgent } from "../src/kernel/auth/agents";
import { parseDestinationList } from "./set-agent-print-destinations";

/**
 * Mint an agent: `AGENT_NAME=<name> pnpm tsx scripts/create-agent.ts`.
 *
 * WASA M-10 — a PRINT RELAY is created with the logical destinations its own config maps to a
 * printer, comma-separated: `AGENT_PRINT_DESTINATIONS=front_desk_thermal,front_desk_a4`. Without
 * it the agent is not a relay and `POST /print/claim` refuses it (403 `print_relay_not_registered`).
 */
async function main(): Promise<void> {
  const printDestinations = parseDestinationList(process.env["AGENT_PRINT_DESTINATIONS"]);
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const { id, apiKey } = await createAgent(db, requireEnv("AGENT_NAME"), { printDestinations });
  await pool.end();
  console.log(`agent ${id} created — API key (shown once): ${apiKey}`);
  console.log(`print destinations: ${printDestinations.length === 0 ? "(none — not a print relay)" : printDestinations.join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
