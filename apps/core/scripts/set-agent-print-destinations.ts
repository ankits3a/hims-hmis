import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { setAgentPrintDestinations } from "../src/kernel/auth/agents";

/**
 * WASA M-10 — REPLACE an existing agent's print grant (docs/runbooks/wasa-database-roles.md §4):
 *
 *   AGENT_NAME=print-relay-hajipur AGENT_PRINT_DESTINATIONS=front_desk_thermal,front_desk_a4 \
 *     pnpm tsx scripts/set-agent-print-destinations.ts
 *
 * The list REPLACES the grant (it is not merged). `AGENT_PRINT_DESTINATIONS=` (empty) revokes it:
 * the agent keeps its key but stops being a print relay. An unknown destination or agent name is
 * refused before anything is written.
 */
export function parseDestinationList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((d) => d.trim()).filter((d) => d !== "");
}

async function main(): Promise<void> {
  const name = requireEnv("AGENT_NAME");
  if (process.env["AGENT_PRINT_DESTINATIONS"] === undefined) {
    throw new Error("set AGENT_PRINT_DESTINATIONS (comma-separated; empty to revoke the grant)");
  }
  const destinations = parseDestinationList(process.env["AGENT_PRINT_DESTINATIONS"]);
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const row = await setAgentPrintDestinations(db, name, destinations);
    console.log(`agent ${name} (${row.id}) may now claim: ${row.printDestinations.length === 0 ? "(nothing — not a print relay)" : row.printDestinations.join(", ")}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
