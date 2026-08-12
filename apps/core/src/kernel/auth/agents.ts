import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { agents } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import type { Db } from "../db/client";

export async function createAgent(db: Db, name: string): Promise<{ id: string; apiKey: string }> {
  const id = newId();
  const apiKey = randomToken();
  await db.insert(agents).values({ id, name, apiKeyHash: sha256Hex(apiKey) });
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
