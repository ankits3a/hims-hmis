import { desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { configValidationReports, events, operatingModeChanges } from "../db/schema";
import {
  ModeError, VALIDATION_FRESH_HOURS, changeOperatingMode, getOperatingMode,
} from "./mode";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { ModeChangeResult, OperatingMode } from "./mode";

const DUTY: Actor = { type: "user", id: "01HDUTYMANAGER000000000001" };

/** Every instant in this suite is derived from this pin — nothing reads the wall clock (§3.31). */
const NOW = new Date("2026-08-23T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

/**
 * The refusal, captured. Never `await expect(...).rejects` — it hangs forever against a mutant
 * that makes the promise resolve, and this whole file is about mutants that make it resolve.
 */
type Refusal = { code: string; detail: string | undefined } | { resolvedTo: string };
async function attempt(db: Db, input: { to: OperatingMode; note?: string | null }, now = NOW): Promise<Refusal> {
  try {
    const result = await withTx(db, (tx) => changeOperatingMode(tx, DUTY, input, now));
    return { resolvedTo: result.to };
  } catch (err) {
    if (err instanceof ModeError) return { code: err.code, detail: err.detail };
    throw err;
  }
}

describe("kernel ops — the operating-mode service (11c D1-D3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  /** A persisted validation report. `ok` and `at` are the only two things D3's guard reads. */
  const seedReport = async (ok: boolean, reportAt: Date): Promise<string> => {
    const id = newId();
    await db.insert(configValidationReports).values({
      id,
      ok,
      scopes: { tariff: { ok, caSigned: ok, errors: [] }, billing: { ok, errors: [] } },
      at: reportAt,
    });
    return id;
  };

  const change = (input: { to: OperatingMode; note?: string | null }, now = NOW): Promise<ModeChangeResult> =>
    withTx(db, (tx) => changeOperatingMode(tx, DUTY, input, now));

  // ───────────────────────────── V1 — zero rows is commissioning ─────────────────────────────

  it("V1: an empty table reads as `commissioning` — not a fallback, the actual state (D1)", async () => {
    // The fixture proof: the table really is empty, so the answer below is produced by the
    // zero-row branch and not by a row that happens to say `commissioning`.
    expect(await db.select().from(operatingModeChanges)).toEqual([]);

    expect(await getOperatingMode(db)).toBe("commissioning");
  });

  it("V1: and a freshly-migrated deployment stays commissioning until something changes it", async () => {
    // Rows in the OTHER ops table do not move the mode: a validation report is permission to
    // leave commissioning, never the act of leaving it.
    await seedReport(true, NOW);
    expect(await getOperatingMode(db)).toBe("commissioning");
  });

  // ───────────────────── V5 — ordering rides `seq`, never `id` and never `at` ─────────────────

  /**
   * V5 (Assertion Book **P**). `newId()` is a plain `ulid()` — 80 bits of fresh randomness, so two
   * ids minted in the same millisecond sort by coin flip — which is exactly why this fixture
   * refuses to rely on minted ids at all. THE IDS ARE EXPLICIT AND THEIR ORDER INVERTS THE SEQ
   * ORDER, and the `at` values are shuffled independently of both, so FIVE wrong orderings each
   * produce a different answer from the right one:
   *
   *   insertion / seq :  1 → id A, at +0h, "ramp"
   *                      2 → id Z, at +2h, "downtime"
   *                      3 → id M, at +1h, "degraded"   ← the true current mode
   *
   *   ORDER BY seq DESC (shipped) → degraded   ORDER BY seq ASC  → ramp
   *   ORDER BY id  DESC           → downtime   ORDER BY id  ASC  → ramp
   *   ORDER BY at  DESC           → downtime   ORDER BY at  ASC  → ramp
   *
   * A fixture that only inverted the ids would leave `ORDER BY id ASC` alive; one that only
   * shuffled `at` would leave both id orderings alive. This one kills all five.
   */
  const ID_A = "01HOPSMODE0000000000000AAA";
  const ID_M = "01HOPSMODE0000000000000MMM";
  const ID_Z = "01HOPSMODE0000000000000ZZZ";

  const seedInvertedHistory = async (): Promise<void> => {
    // Sequential inserts, so `seq` follows insertion order — that is the property under test.
    await db.insert(operatingModeChanges).values({
      id: ID_A, fromMode: "commissioning", toMode: "ramp", note: null, reportId: null,
      actorId: DUTY.id, at: at(0),
    });
    await db.insert(operatingModeChanges).values({
      id: ID_Z, fromMode: "ramp", toMode: "downtime", note: "generator test", reportId: null,
      actorId: DUTY.id, at: at(2 * HOUR),
    });
    await db.insert(operatingModeChanges).values({
      id: ID_M, fromMode: "downtime", toMode: "degraded", note: "billing back, labs still out",
      reportId: null, actorId: DUTY.id, at: at(1 * HOUR),
    });
  };

  it("V5: current mode is the highest `seq`, even when id-order and at-order both say otherwise", async () => {
    await seedInvertedHistory();

    // THE FIXTURE PROOF, and it is the whole row this assertion stands on. Without it, a green
    // result below could mean the fixture never inverted anything.
    const rows = await db
      .select({ id: operatingModeChanges.id, seq: operatingModeChanges.seq, toMode: operatingModeChanges.toMode })
      .from(operatingModeChanges)
      .orderBy(operatingModeChanges.seq);
    expect(rows.map((r) => r.id)).toEqual([ID_A, ID_Z, ID_M]);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    // Id order and seq order genuinely disagree, in BOTH directions.
    expect([...rows].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.toMode))
      .toEqual(["ramp", "degraded", "downtime"]);

    expect(await getOperatingMode(db)).toBe("degraded");
  });

  it("V5: two changes inside ONE millisecond still order — the ULID cannot, the bigserial can", async () => {
    // Both rows carry the SAME `at`, so nothing but `seq` can separate them. This is the case
    // audit A1 is about: `ORDER BY id` here is a coin flip, not a bug you would see in review.
    const SAME_INSTANT = at(0);
    await db.insert(operatingModeChanges).values({
      id: ID_Z, fromMode: "commissioning", toMode: "downtime", note: "power cut", reportId: null,
      actorId: DUTY.id, at: SAME_INSTANT,
    });
    await db.insert(operatingModeChanges).values({
      id: ID_A, fromMode: "downtime", toMode: "normal", note: null, reportId: null,
      actorId: DUTY.id, at: SAME_INSTANT,
    });

    const stamps = await db.select({ at: operatingModeChanges.at }).from(operatingModeChanges);
    expect(new Set(stamps.map((s) => s.at.toISOString())).size).toBe(1); // one instant, two rows

    expect(await getOperatingMode(db)).toBe("normal");
  });

  // ──────────────────────── V2 — the commissioning exit IS D-17's gate ────────────────────────

  it("V2: no report at all → golive_gate_unsatisfied / no_report", async () => {
    expect(await db.select().from(configValidationReports)).toEqual([]); // fixture proof
    expect(await attempt(db, { to: "normal" })).toEqual({
      code: "golive_gate_unsatisfied",
      detail: "no_report",
    });
    expect(await getOperatingMode(db)).toBe("commissioning"); // and nothing moved
  });

  it("V2: an ok report 25 h old → golive_gate_unsatisfied / stale_report", async () => {
    await seedReport(true, at(-25 * HOUR));
    expect(await attempt(db, { to: "normal" })).toEqual({
      code: "golive_gate_unsatisfied",
      detail: "stale_report",
    });
    expect(await getOperatingMode(db)).toBe("commissioning");
  });

  it("V2: the LATEST report is ok=false → golive_gate_unsatisfied / report_not_ok, even with an older green one", async () => {
    // THE V8 SHAPE, asserted from this side too: an older ok=true row exists and is fresh. A
    // guard that accepted "any ok report" — or one that cached the first verdict it saw — would
    // let this deployment go live on a configuration that has since gone red.
    const olderGreen = await seedReport(true, at(-1 * HOUR));
    const latestRed = await seedReport(false, at(-1 * 60 * 1000));
    const bySeq = await db
      .select({ id: configValidationReports.id, ok: configValidationReports.ok })
      .from(configValidationReports)
      .orderBy(desc(configValidationReports.seq));
    expect(bySeq.map((r) => r.id)).toEqual([latestRed, olderGreen]); // fixture proof: red is latest
    expect(bySeq[0]!.ok).toBe(false);

    expect(await attempt(db, { to: "normal" })).toEqual({
      code: "golive_gate_unsatisfied",
      detail: "report_not_ok",
    });
    expect(await getOperatingMode(db)).toBe("commissioning");
  });

  it("V2 CONTROL: a fresh ok report opens the exit, and the change records WHICH report it rode", async () => {
    const reportId = await seedReport(true, at(-1 * HOUR));

    const result = await change({ to: "normal" });
    expect(result.from).toBe("commissioning");
    expect(result.to).toBe("normal");
    // `reportId` is not an argument — it is what the guard itself read, so the row cannot claim
    // an authorisation that never happened.
    expect(result.reportId).toBe(reportId);
    expect(await getOperatingMode(db)).toBe("normal");

    const rows = await db.select().from(operatingModeChanges);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromMode: "commissioning", toMode: "normal", note: null, reportId, actorId: DUTY.id,
    });
    expect(rows[0]!.at.toISOString()).toBe(NOW.toISOString()); // the injected clock, GC8
  });

  it("V2: the window is exactly VALIDATION_FRESH_HOURS — the boundary is admitted, a minute past it is not", async () => {
    await seedReport(true, at(-VALIDATION_FRESH_HOURS * HOUR));
    expect(await attempt(db, { to: "ramp" })).toEqual({ resolvedTo: "ramp" });

    await truncateAll(db);
    await seedReport(true, at(-VALIDATION_FRESH_HOURS * HOUR - 60_000));
    expect(await attempt(db, { to: "ramp" })).toEqual({
      code: "golive_gate_unsatisfied",
      detail: "stale_report",
    });
  });

  it("V2: the gate applies to EVERY exit from commissioning, so downtime is not a way around D-17", async () => {
    // commissioning → downtime → normal would otherwise reach `normal` with no validated
    // configuration at all, which is the one thing D3 exists to prevent.
    expect(await attempt(db, { to: "downtime", note: "flood in records room" })).toEqual({
      code: "golive_gate_unsatisfied",
      detail: "no_report",
    });
    expect(await getOperatingMode(db)).toBe("commissioning");
  });

  it("V2: once out of commissioning the gate is silent — a stale report does not block a downtime call", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "normal" });
    // The report is now ancient. Declaring downtime must still work: the gate guards go-live,
    // never the ability to say the hospital is in trouble.
    const result = await change({ to: "downtime", note: "mains failure" }, at(72 * HOUR));
    expect(result).toMatchObject({ from: "normal", to: "downtime", reportId: null });
    expect(await getOperatingMode(db)).toBe("downtime");
  });

  // ─────────────────── V3 — commissioning is initial-only, never a target ────────────────────

  it("V3: `commissioning` can never be a transition target", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "normal" });
    expect(await getOperatingMode(db)).toBe("normal"); // fixture proof: we are genuinely elsewhere

    expect(await attempt(db, { to: "commissioning" })).toEqual({
      code: "mode_commissioning_is_initial_only",
      detail: undefined,
    });
    expect(await getOperatingMode(db)).toBe("normal");
    expect(await db.select().from(operatingModeChanges)).toHaveLength(1); // nothing appended
  });

  it("V3: and not even from commissioning itself — the categorical rule outranks `mode_unchanged`", async () => {
    expect(await attempt(db, { to: "commissioning" })).toEqual({
      code: "mode_commissioning_is_initial_only",
      detail: undefined,
    });
  });

  // ──────────────────── V4 — a note is mandatory entering downtime/degraded ──────────────────

  it("V4: entering `downtime` with no note is refused", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "normal" });

    expect(await attempt(db, { to: "downtime" })).toEqual({
      code: "mode_note_required",
      detail: undefined,
    });
    expect(await getOperatingMode(db)).toBe("normal");
  });

  it("V4: entering `degraded` with no note is refused, and whitespace is not a note", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "normal" });

    expect(await attempt(db, { to: "degraded", note: null })).toEqual({
      code: "mode_note_required", detail: undefined,
    });
    expect(await attempt(db, { to: "degraded", note: "   " })).toEqual({
      code: "mode_note_required", detail: undefined,
    });
    expect(await getOperatingMode(db)).toBe("normal");
  });

  it("V4 CONTROL: `ramp` and `normal` need no note, and a supplied note is trimmed and kept", async () => {
    await seedReport(true, at(-1 * HOUR));
    expect(await attempt(db, { to: "ramp" })).toEqual({ resolvedTo: "ramp" });
    expect(await attempt(db, { to: "normal" })).toEqual({ resolvedTo: "normal" });

    const declared = await change({ to: "degraded", note: "  labs offline  " });
    expect(declared.note).toBe("labs offline");
    const rows = await db
      .select({ note: operatingModeChanges.note })
      .from(operatingModeChanges)
      .orderBy(desc(operatingModeChanges.seq))
      .limit(1);
    expect(rows[0]!.note).toBe("labs offline");
  });

  // ──────────────────────────── mode_unchanged — the fourth refusal ──────────────────────────

  it("refuses a no-op transition so the history never carries a change that changed nothing", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "normal" });

    expect(await attempt(db, { to: "normal" })).toEqual({ code: "mode_unchanged", detail: undefined });
    expect(await db.select().from(operatingModeChanges)).toHaveLength(1);
  });

  it("refuses `downtime → downtime` even WITH a note — re-declaring must not re-alert every owner", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "normal" });
    await change({ to: "downtime", note: "power cut" });

    expect(await attempt(db, { to: "downtime", note: "still out" })).toEqual({
      code: "mode_unchanged", detail: undefined,
    });
    const appended = await db.select().from(events).where(eq(events.name, "ops.mode_changed"));
    expect(appended).toHaveLength(2); // the two real changes, and not a third
  });

  // ───────────────────────────── the append, and what it carries ─────────────────────────────

  it("appends exactly one `ops.mode_changed` per change, carrying from/to/note/reportId and no patient", async () => {
    const reportId = await seedReport(true, at(-1 * HOUR));
    const first = await change({ to: "normal" });
    const second = await change({ to: "downtime", note: "UPS failure" }, at(30 * 60 * 1000));

    const rows = await db
      .select({
        eventId: events.eventId, payload: events.payload, patientId: events.patientId,
        actorId: events.actorId, module: events.module, occurredAt: events.occurredAt,
      })
      .from(events)
      .where(eq(events.name, "ops.mode_changed"))
      .orderBy(events.seq);
    expect(rows.map((r) => r.eventId)).toEqual([first.eventId, second.eventId]);
    expect(rows[0]!.payload).toEqual({ from: "commissioning", to: "normal", note: null, reportId });
    expect(rows[1]!.payload).toEqual({ from: "normal", to: "downtime", note: "UPS failure", reportId: null });
    // GC6: a mode change is a hospital-wide fact and this event is fanned to browsers.
    expect(rows.map((r) => r.patientId)).toEqual([null, null]);
    expect(rows.map((r) => r.module)).toEqual(["ops", "ops"]);
    expect(rows.map((r) => r.actorId)).toEqual([DUTY.id, DUTY.id]);
    // The injected clock reaches the envelope too — no wall-clock read anywhere in the path.
    expect(rows[1]!.occurredAt.toISOString()).toBe(at(30 * 60 * 1000).toISOString());
  });

  it("a refused change appends NOTHING — the refusal is not a half-written transition", async () => {
    expect(await attempt(db, { to: "normal" })).toMatchObject({ code: "golive_gate_unsatisfied" });
    expect(await db.select().from(events).where(eq(events.name, "ops.mode_changed"))).toEqual([]);
    expect(await db.select().from(operatingModeChanges)).toEqual([]);
  });

  it("history is append-only and readable in order — every change survives the next one", async () => {
    await seedReport(true, at(-1 * HOUR));
    await change({ to: "ramp" });
    await change({ to: "normal" }, at(HOUR));
    await change({ to: "degraded", note: "labs offline" }, at(2 * HOUR));
    await change({ to: "normal" }, at(3 * HOUR));

    const rows = await db
      .select({ fromMode: operatingModeChanges.fromMode, toMode: operatingModeChanges.toMode })
      .from(operatingModeChanges)
      .orderBy(operatingModeChanges.seq);
    expect(rows).toEqual([
      { fromMode: "commissioning", toMode: "ramp" },
      { fromMode: "ramp", toMode: "normal" },
      { fromMode: "normal", toMode: "degraded" },
      { fromMode: "degraded", toMode: "normal" },
    ]);
    expect(await getOperatingMode(db)).toBe("normal");
  });
});
