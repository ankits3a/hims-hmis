import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { copilotActs, copilotAsks, events } from "../db/schema";
import { retentionSweep } from "../retention/sweep";
import {
  COPILOT_ASK_RETAIN_DAYS, acknowledgeNotice, noticeSeen, pruneCopilotAsks, readCopilotHealth, recordAsk,
} from "./ledger";
import type { Db } from "../db/client";

/**
 * E0.1 — the ledger's database half (spec done-means 4, 5, 6 and the health read's shape).
 * The HTTP half — one row per ask, whatever happened — is `test/copilot-ledger.e2e.test.ts`.
 */
const DAY = 24 * 60 * 60 * 1000;
const APPEND_ONLY = /audit_append_only/;

describe("E0.1 — the copilot ledger at the database", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  const anAct = (confirmId: unknown) => sql`insert into copilot_acts (id, actor_id, tool, args_hash, proposal_id, confirm_id)
    values (${newId()}, 'u-1', 'book_slot', 'h', 'p-1', ${confirmId})`;

  async function anAsk(ageMs: number, extra: Partial<Parameters<typeof recordAsk>[1]> = {}): Promise<string> {
    return recordAsk(db, {
      actor: { type: "user", id: "u-1" }, outcome: "answered", route: "phrasebook", intent: "queue_depth",
      answerKey: "copilot.answer.queueDepth", ms: 12, maskedQuestion: "kitna wait hai", screen: "opd",
      at: new Date(Date.now() - ageMs), ...extra,
    });
  }

  it("D4: an act row with no confirm id is refused by the database, and one confirm cannot be spent twice", async () => {
    await expect(db.execute(anAct(null))).rejects.toThrow(/confirm_id/);
    await expect(db.execute(anAct(""))).rejects.toThrow(/copilot_acts_confirm_ck/);
    await db.execute(anAct("c-1"));
    await expect(db.execute(anAct("c-1"))).rejects.toThrow(/copilot_acts_confirm_ux/);
    expect(await db.select().from(copilotActs)).toHaveLength(1);
  });

  it("D5: an act row can be neither updated nor deleted", async () => {
    await db.execute(anAct("c-2"));
    await expect(db.execute(sql`update copilot_acts set tool = 'other'`)).rejects.toThrow(APPEND_ONLY);
    await expect(db.execute(sql`delete from copilot_acts`)).rejects.toThrow(APPEND_ONLY);
    expect(await db.select().from(copilotActs)).toHaveLength(1);
  });

  it("an ask row cannot be edited, and a plain DELETE is refused even past the window", async () => {
    await anAsk((COPILOT_ASK_RETAIN_DAYS + 5) * DAY);
    await expect(db.execute(sql`update copilot_asks set masked_question = 'x'`)).rejects.toThrow(APPEND_ONLY);
    await expect(db.execute(sql`delete from copilot_asks`)).rejects.toThrow(APPEND_ONLY);
    expect(await db.select().from(copilotAsks)).toHaveLength(1);
  });

  it("D6: the retention sweep removes asks older than 180 days, keeps younger ones, and leaves acts alone", async () => {
    await anAsk(COPILOT_ASK_RETAIN_DAYS * DAY + 60 * 60 * 1000);
    await anAsk((COPILOT_ASK_RETAIN_DAYS + 40) * DAY);
    const young = await anAsk((COPILOT_ASK_RETAIN_DAYS - 2) * DAY);
    const today = await anAsk(DAY / 2);
    await db.execute(anAct("c-3"));

    const result = await retentionSweep(db, { enabled: true });
    expect(result.copilotAsksDeleted).toBe(2);
    expect((await db.select({ id: copilotAsks.id }).from(copilotAsks)).map((r) => r.id).sort()).toEqual([young, today].sort());
    expect(await db.select().from(copilotActs)).toHaveLength(1);
    // the destruction is evented with its count, as `search.audit_pruned` is
    const pruned = (await db.select().from(events)).filter((e) => e.name === "copilot.asks_pruned");
    expect(pruned).toHaveLength(1);
    expect((pruned[0]!.payload as { rows: number }).rows).toBe(2);
  });

  it("the prune's database floor refuses a window shorter than 179 days", async () => {
    await anAsk(100 * DAY);
    await expect(pruneCopilotAsks(db, { retainDays: 90 })).rejects.toThrow(APPEND_ONLY);
  });

  it("health: today's counts by outcome and route, timings per route, acts, and no per-person field", async () => {
    await anAsk(0, { ms: 10 });
    await anAsk(0, { ms: 30, actor: { type: "user", id: "u-2" } });
    await anAsk(0, { outcome: "notUnderstood", route: "none", intent: null, answerKey: null, ms: 5 });
    await anAsk(0, { route: "chooser", ms: 900 });
    await anAsk(3 * DAY); // another day: not counted
    await db.execute(anAct("c-4"));

    const h = await readCopilotHealth(db, istToday());
    expect(h.asks).toBe(4);
    expect(h.askers).toBe(2);
    expect(h.byOutcome.answered).toBe(3);
    expect(h.byOutcome.notUnderstood).toBe(1);
    expect(h.notUnderstoodShare).toBeCloseTo(0.25);
    expect(h.byRoute.phrasebook.asks).toBe(2);
    expect(h.byRoute.phrasebook.p50Ms).toBe(20);
    expect(h.byRoute.chooser.asks).toBe(1);
    expect(h.byRoute.model.asks).toBe(0);
    expect(h.byRoute.model.p50Ms).toBeNull();
    expect(h.acts).toBe(1);
    expect(Object.keys(h).sort()).toEqual(
      ["acts", "askers", "asks", "byOutcome", "byRoute", "date", "notUnderstoodShare"],
    );
    expect(JSON.stringify(h)).not.toMatch(/u-1|u-2/);
  });

  it("the staff notice: unseen until acknowledged, then seen for good; acknowledging twice is harmless", async () => {
    expect(await noticeSeen(db, "u-9")).toBe(false);
    await acknowledgeNotice(db, "u-9");
    await acknowledgeNotice(db, "u-9");
    expect(await noticeSeen(db, "u-9")).toBe(true);
    expect(await noticeSeen(db, "u-10")).toBe(false);
  });
});

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
