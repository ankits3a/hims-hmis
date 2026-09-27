import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { agents } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import { PRINT_DESTINATIONS } from "../printing/enqueue";
import type { Db } from "../db/client";

/**
 * WASA M-10 — a print grant the system cannot honour is refused where it is written, not
 * discovered at the counter: a misspelt destination would otherwise be a relay that silently
 * serves nothing, and an unknown agent name a grant written to nobody.
 */
export class AgentGrantError extends Error {
  constructor(
    readonly code: "unknown_print_destination" | "agent_not_found",
    message: string,
  ) {
    super(message);
    this.name = "AgentGrantError";
  }
}

/** Deduplicated, sorted, and every name a destination some document actually prints to. */
function normalisePrintDestinations(destinations: readonly string[]): string[] {
  const known = new Set<string>(PRINT_DESTINATIONS);
  const unknown = destinations.filter((d) => !known.has(d));
  if (unknown.length > 0) {
    throw new AgentGrantError(
      "unknown_print_destination",
      `unknown print destination(s): ${unknown.join(", ")} — declared: ${PRINT_DESTINATIONS.join(", ")}`,
    );
  }
  return [...new Set(destinations)].sort();
}

/**
 * Mint an agent and its API key (shown once; only the SHA-256 is stored).
 *
 * `printDestinations` is the WASA M-10 grant: an agent created without it is NOT a print relay and
 * `POST /print/claim` refuses it outright. A relay is created with the logical destinations its
 * own config maps to a printer (`tools/print-relay/README.md`).
 */
export async function createAgent(
  db: Db,
  name: string,
  opts: { printDestinations?: readonly string[] } = {},
): Promise<{ id: string; apiKey: string }> {
  const printDestinations = normalisePrintDestinations(opts.printDestinations ?? []);
  const id = newId();
  const apiKey = randomToken();
  await db.insert(agents).values({ id, name, apiKeyHash: sha256Hex(apiKey), printDestinations });
  return { id, apiKey };
}

export async function findAgentByKey(
  db: Db,
  apiKey: string,
): Promise<{ id: string; name: string; killSwitch: boolean } | null> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, killSwitch: agents.killSwitch })
    .from(agents)
    .where(eq(agents.apiKeyHash, sha256Hex(apiKey)));
  return rows[0] ?? null;
}

export async function setKillSwitch(db: Db, agentId: string, on: boolean): Promise<void> {
  await db.update(agents).set({ killSwitch: on }).where(eq(agents.id, agentId));
}

/** WASA M-10 — the destinations this agent may claim; empty for an agent that is not a relay. */
export async function agentPrintDestinations(db: Db, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ printDestinations: agents.printDestinations })
    .from(agents)
    .where(eq(agents.id, agentId));
  return rows[0]?.printDestinations ?? [];
}

/**
 * WASA M-10 — REPLACE an agent's print grant, by NAME (the handle `create-agent` was given). An
 * empty list revokes it: the agent stops being a print relay without losing its key or its
 * identity. Driven by `scripts/set-agent-print-destinations.ts`.
 */
export async function setAgentPrintDestinations(
  db: Db,
  agentName: string,
  destinations: readonly string[],
): Promise<{ id: string; printDestinations: string[] }> {
  const printDestinations = normalisePrintDestinations(destinations);
  const rows = await db
    .update(agents)
    .set({ printDestinations })
    .where(eq(agents.name, agentName))
    .returning({ id: agents.id, printDestinations: agents.printDestinations });
  const row = rows[0];
  if (row === undefined) throw new AgentGrantError("agent_not_found", `no agent named ${agentName}`);
  return row;
}
