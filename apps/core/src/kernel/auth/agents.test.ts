import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  AgentGrantError, agentPrintDestinations, createAgent, findAgentByKey, setAgentPrintDestinations, setKillSwitch,
} from "./agents";
import { agents, printJobs } from "../db/schema";
import { PRINT_DESTINATIONS } from "../printing/enqueue";
import type { Db } from "../db/client";

describe("agents", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates an agent and finds it by key", async () => {
    const { id, apiKey } = await createAgent(db, "digest-writer");
    const found = await findAgentByKey(db, apiKey);
    expect(found).toEqual({ id, name: "digest-writer", killSwitch: false });
    expect(await findAgentByKey(db, "wrong-key")).toBeNull();
  });

  it("kill switch state is visible on lookup", async () => {
    const { id, apiKey } = await createAgent(db, "sla-chaser");
    await setKillSwitch(db, id, true);
    expect((await findAgentByKey(db, apiKey))!.killSwitch).toBe(true);
  });

  it("rejects duplicate agent names", async () => {
    await createAgent(db, "digest-writer");
    await expect(createAgent(db, "digest-writer")).rejects.toThrow();
  });

  /**
   * WASA M-10 — THE PRINT GRANT. An agent is a print relay only if it is granted destinations, and
   * the grant names only destinations a job can actually carry: a typo in a grant would otherwise
   * be a relay that silently serves nothing.
   */
  describe("WASA M-10 — print destination grants", () => {
    it("G1: a new agent holds NO print destinations unless it is created with them", async () => {
      const plain = await createAgent(db, "lab-bridge");
      expect(await agentPrintDestinations(db, plain.id)).toEqual([]);
      const relay = await createAgent(db, "relay-site-1", { printDestinations: ["pharmacy_thermal", "front_desk_a4", "front_desk_a4"] });
      expect(await agentPrintDestinations(db, relay.id)).toEqual(["front_desk_a4", "pharmacy_thermal"]);
    });

    it("G2: a grant naming a destination no document prints to is refused — at creation and on change", async () => {
      await expect(createAgent(db, "typo-relay", { printDestinations: ["front_desk_thermall"] }))
        .rejects.toMatchObject({ code: "unknown_print_destination" });
      expect(await db.select().from(agents)).toEqual([]);

      const relay = await createAgent(db, "relay-site-1", { printDestinations: ["front_desk_thermal"] });
      await expect(setAgentPrintDestinations(db, "relay-site-1", ["icu-printer"]))
        .rejects.toBeInstanceOf(AgentGrantError);
      expect(await agentPrintDestinations(db, relay.id)).toEqual(["front_desk_thermal"]);
    });

    it("G3: the grant is narrowed (or cleared) by agent NAME, and an unknown name is refused", async () => {
      const relay = await createAgent(db, "relay-site-1", { printDestinations: [...PRINT_DESTINATIONS] });
      expect(await setAgentPrintDestinations(db, "relay-site-1", ["front_desk_thermal", "front_desk_a4"]))
        .toEqual({ id: relay.id, printDestinations: ["front_desk_a4", "front_desk_thermal"] });
      expect(await agentPrintDestinations(db, relay.id)).toEqual(["front_desk_a4", "front_desk_thermal"]);
      expect((await setAgentPrintDestinations(db, "relay-site-1", [])).printDestinations).toEqual([]);
      await expect(setAgentPrintDestinations(db, "no-such-agent", ["front_desk_a4"]))
        .rejects.toMatchObject({ code: "agent_not_found" });
    });
  });

  /**
   * ═══ THE MIGRATION'S BACKFILL, RUN FROM THE FILE THAT SHIPS ═══
   *
   * The `0096` precedent (`test/backfill-encounter-refs.test.ts`): a backfill runs once against an
   * EMPTY database on every test and CI box, so a green suite says nothing about it. This reads the
   * migration off disk — found by its NAME, not its serial, because the serial is assigned at rebase
   * — takes the one statement marked `WASA M-10 BACKFILL`, and executes it against agents shaped the
   * way production's are: a relay that has claimed jobs (one under a destination no longer
   * declared), and a key that has never claimed anything.
   */
  it("B1: the migration grants every agent that has CLAIMED a job all declared destinations plus its history, and nobody else anything", async () => {
    const dir = join(__dirname, "..", "..", "..", "drizzle");
    const file = readdirSync(dir).filter((f) => f.endsWith("_wasa_audit_append_only_agent_bindings.sql"));
    expect(file).toHaveLength(1);
    const statements = readFileSync(join(dir, file[0]!), "utf8").split("--> statement-breakpoint");
    const backfill = statements.filter((s) => s.includes("WASA M-10 BACKFILL"));
    expect(backfill).toHaveLength(1);

    const relay = await createAgent(db, "print-relay-hajipur");
    const bridge = await createAgent(db, "lab-bridge");
    const job = (destination: string, claimedBy: string | null) => ({
      id: newId(), document: "opd_token_slip", destination, params: {}, dedupeKey: newId(),
      status: claimedBy === null ? "queued" : "printed", claimedBy,
    });
    await db.insert(printJobs).values([
      job("front_desk_thermal", relay.id),
      job("legacy_label_printer", relay.id), // a destination the code no longer declares
      job("pharmacy_thermal", null), // queued, never claimed: evidence of nobody
    ]);

    await db.execute(sql.raw(backfill[0]!));
    await db.execute(sql.raw(backfill[0]!)); // and it is safe to run twice

    const grant = async (id: string): Promise<string[]> =>
      (await db.select({ d: agents.printDestinations }).from(agents).where(eq(agents.id, id)))[0]!.d;
    // A LITERAL, not `PRINT_DESTINATIONS`: the migration is history and grants what was declared the
    // day it ran. A destination added later is granted by the operator, never retroactively here.
    expect(await grant(relay.id)).toEqual([
      "front_desk_a4", "front_desk_thermal", "legacy_label_printer", "pharmacy_thermal", "vitals_thermal",
    ]);
    expect(await grant(bridge.id)).toEqual([]);
  });
});
