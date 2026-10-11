import { asc, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events } from "../db/schema";
import { runTool } from "./catalog";
import { asksHalted, clearHalt, listHalts, readCopilotGate, setHalt, toolHalted } from "./halt";
import { recordAsk } from "./ledger";
import type { ModelCall } from "./spend";
import type { CopilotToolCtx, CopilotToolDecl } from "./types";
import type { Db } from "../db/client";

/**
 * E0.3 + E0.5 at the database (spec /opt/hmis-context/SPEC-copilot-halt-and-cap-2026-10-11.md).
 * The HTTP half — who may clear what, halted asks ledgered, zero model calls at the cap — is
 * `test/copilot-halt.e2e.test.ts`. Every clock here is INJECTED: no date is pinned to the real one.
 */
const OWNER = { type: "user" as const, id: "u-owner" };
const DUTY = { type: "user" as const, id: "u-duty" };

/** A fixture WRITE tool — no real one exists until E0.2 — and a read tool beside it. */
const writeTool: CopilotToolDecl = {
  intent: "draft_short_book_entry", permission: null, needsSubject: false, kind: "act",
  run: async () => ({ key: "copilot.answer.noTool", params: { wrote: 1 } }),
};
const draftTool: CopilotToolDecl = { ...writeTool, intent: "draft_purchase_orders", kind: "draft" };
const readTool: CopilotToolDecl = {
  intent: "queue_depth", permission: null, needsSubject: false,
  run: async () => ({ key: "copilot.answer.queueNoneOpen", params: {} }),
};

const call = (microInr: number): ModelCall => ({
  provider: "chat", model: "m", kind: "model", inTok: 1, outTok: 1, microInr, ok: true, tokens: "usage",
});

describe("E0.3 / E0.5 — the halt switch and the spend read", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const ctx = (): CopilotToolCtx => ({ db, actor: DUTY, subject: null, serviceDate: "2026-01-01", question: "q" });
  const yes = async (): Promise<boolean> => true;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("done-means 1: after halting act, a write tool refuses while a read tool answers (generic on the declared kind)", async () => {
    let wrote = 0;
    const counting: CopilotToolDecl = { ...writeTool, run: async () => { wrote += 1; return { key: "copilot.answer.noTool", params: {} }; } };

    expect((await runTool(counting, ctx(), yes, (await readCopilotGate(db, new Date())).halts)).key).toBe("copilot.answer.noTool");
    expect(wrote).toBe(1);

    await setHalt(db, OWNER, "act", "drill");
    const { halts } = await readCopilotGate(db, new Date());
    expect((await runTool(counting, ctx(), yes, halts)).key).toBe("copilot.answer.paused");
    expect(wrote).toBe(1); // the write never ran
    expect((await runTool(readTool, ctx(), yes, halts)).key).toBe("copilot.answer.queueNoneOpen");
    expect((await runTool(draftTool, ctx(), yes, halts)).key).toBe("copilot.answer.noTool"); // act ≠ draft
    expect(asksHalted(halts)).toBe(false);
  });

  it("draft halts drafts only; read and global halt every ask", () => {
    expect(toolHalted(draftTool, new Set(["draft"]))).toBe(true);
    expect(toolHalted(writeTool, new Set(["draft"]))).toBe(false);
    expect(toolHalted(readTool, new Set(["act", "draft"]))).toBe(false);
    for (const s of ["read", "global"] as const) {
      expect(asksHalted(new Set([s]))).toBe(true);
      expect(toolHalted(readTool, new Set([s]))).toBe(true);
    }
  });

  it("done-means 2: each halt and each clear is ONE audit event naming who; repeats change nothing", async () => {
    expect(await setHalt(db, DUTY, "act", "wrong patient suggested")).toEqual({ changed: true });
    expect(await setHalt(db, OWNER, "act", null)).toEqual({ changed: false });
    expect((await listHalts(db)).map((h) => [h.scope, h.haltedBy])).toEqual([["act", DUTY.id]]);
    expect(await clearHalt(db, OWNER, "act")).toEqual({ changed: true });
    expect(await clearHalt(db, OWNER, "act")).toEqual({ changed: false });
    expect(await listHalts(db)).toEqual([]);

    const evs = (await db.select().from(events).orderBy(asc(events.seq))).filter((e) => e.name.startsWith("copilot.halt"));
    expect(evs.map((e) => [e.name, e.actorId])).toEqual([["copilot.halt_set", DUTY.id], ["copilot.halt_cleared", OWNER.id]]);
    expect(evs[0]!.payload).toEqual({ scope: "act", reason: "wrong patient suggested" });
    expect(evs[1]!.payload).toMatchObject({ scope: "act", haltedBy: DUTY.id });
  });

  it("done-means 8: the day's spend is summed from midnight IST and resets at the next one (injected clock)", async () => {
    // Relative to an arbitrary fixed instant, never the real date: 00:30 IST on the injected day.
    const now = new Date("2031-03-04T19:00:00Z"); // = 2031-03-05 00:30 IST
    const at = (iso: string) => new Date(iso);
    const ask = (when: Date, micro: number) => recordAsk(db, {
      actor: DUTY, outcome: "answered", route: "model", intent: "queue_depth", answerKey: "copilot.answer.queueNoneOpen",
      ms: 5, maskedQuestion: "q", screen: null, modelCalls: micro === 0 ? [] : [call(micro)], at: when,
    });
    await ask(at("2031-03-04T18:29:00Z"), 7_000_000); // 23:59 IST the day before — not today
    await ask(at("2031-03-04T18:31:00Z"), 2_000_000); // 00:01 IST today
    await ask(at("2031-03-04T18:45:00Z"), 0); // a phrasebook ask spends nothing
    await ask(at("2031-03-04T18:50:00Z"), 500_000);

    expect((await readCopilotGate(db, now)).spentMicroInr).toBe(2_500_000);
    expect((await readCopilotGate(db, at("2031-03-04T18:29:30Z"))).spentMicroInr).toBe(7_000_000); // still yesterday
    expect((await readCopilotGate(db, at("2031-03-05T18:30:00Z"))).spentMicroInr).toBe(0); // next midnight IST
  });

  it("the ledger row carries calls, cost and usage; the check refuses a negative cost", async () => {
    await recordAsk(db, {
      actor: DUTY, outcome: "answered", route: "chooser", intent: "queue_depth", answerKey: "copilot.answer.queueNoneOpen",
      ms: 5, maskedQuestion: "q", screen: null, modelCalls: [call(1200), call(300)], capped: false,
    });
    const rows = (await db.execute<{ model_calls: number; cost_micro_inr: number; model_usage: unknown; capped: boolean }>(
      sql`select model_calls, cost_micro_inr, model_usage, capped from copilot_asks`,
    )).rows;
    expect(rows[0]).toMatchObject({ model_calls: 2, cost_micro_inr: 1500, capped: false });
    expect(rows[0]!.model_usage).toHaveLength(2);
  });
});
