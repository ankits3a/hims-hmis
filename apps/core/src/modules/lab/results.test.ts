import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode, uhidOf,
} from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import {
  events, labAnalytes, labCriticalCalls, labReferenceRanges, labResults, orderItems, patients,
  workflowInstances,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { collect } from "./collection";
import { deskOrder } from "./desk";
import { duplicateWarnings } from "./duplicates";
import { enterResult, requestRerun } from "./results";
import { printLabels } from "./specimens";
import { verifyResult } from "./verify";
import { amendResult } from "./results";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 17b T6 — RESULT ENTRY. Assertion Book rows **A5, A6, A7, A8**, plus DD3's calculated
 * analytes (E38) and 17a §6.2's three-part resultable precondition.
 *
 * (A1, A3, A4, A4b and A9 are the SIGNATURE's rows and live in `verify.test.ts`; A2 is the
 * concurrency row and lives in `verify.concurrency.test.ts`.)
 *
 * ═══ EVERY FIXTURE GOES THROUGH 17a's REAL WRITERS ═══
 *
 * `seedLabDeskBase` → `deskOrder` → `printLabels` → `collect` → `receive`. Not one row of the chain
 * is hand-built, because the precondition under test IS what those writers leave behind (17a §6.2):
 * a hand-rolled `lab_items` row with an invented `tat_started_at` and no `lab_specimen_items` link
 * would make every assertion here about a state the system cannot actually reach.
 *
 * `resultable()` acknowledges the duplicate warnings rather than avoiding them, because the delta
 * row legitimately orders the SAME test three times for one patient inside the 24-hour window and
 * `deskOrder` refuses the whole order otherwise — which is the detector working, not the fixture
 * cheating.
 */
describe("lab results — entry (17b T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let bench2: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    /** A SECOND holder of `lab.results.enter` — 02 H1's override needs a different pair of hands. */
    bench2 = await mkUser(db, "lab.bench2", ["lab_technician"]);
    /**
     * A DATE OF BIRTH, so the age-banded ranges resolve on evidence rather than on the "no DOB"
     * fallback. `seedLabDeskBase` leaves it null — E7's UNK patient is 17a's case, not this one.
     */
    await db.update(patients).set({ dob: new Date("1990-05-10T00:00:00Z") })
      .where(eq(patients.id, fx.patientId));
  });
  afterEach(() => { fx.unregister(); });

  /* ─────────────────────────────── the shared helpers ─────────────────────────────── */

  type Resultable = { orderId: string; orderGroupId: string; itemIds: string[]; specimenNos: string[] };

  /** Order → label → draw → RECEIVE: the triple 17a §6.2 hands over, built by 17a's own writers. */
  async function resultable(
    codes: readonly string[],
    opts: { reflexConsent?: boolean; at?: Date; receiveTube?: boolean } = {},
  ): Promise<Resultable> {
    const now = opts.at ?? new Date();
    const serviceIds = codes.map((c) => serviceIdForLabCode(c));
    const warnings = await withTx(db, (tx) =>
      duplicateWarnings(tx, fx.desk.actor, fx.patientId, serviceIds, now));
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id,
      items: serviceIds.map((serviceId) => ({ serviceId })),
      credit: { reason: "counter order" },
      reflexConsent: opts.reflexConsent,
      acknowledgedDuplicates: warnings.map((w) => w.duplicateOfItemId),
      placedAt: now,
    }, now));
    const { specimens } = await printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: await uhidOf(db, fx.patientId),
    }, now);
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, {
        specimenId: s.specimenId, wristbandScanned: true,
      }, now));
    }
    if (opts.receiveTube !== false) {
      for (const s of specimens) {
        await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }, now));
      }
    }
    return {
      orderId: placed.orderId, orderGroupId: placed.orderGroupId, itemIds: placed.itemIds,
      specimenNos: specimens.map((s) => s.specimenNo),
    };
  }

  const analyteIdFor = async (code: string): Promise<string> =>
    (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, code)))[0]!.id;

  const eventsNamed = async (name: string) =>
    db.select().from(events).where(eq(events.name, name));

  const rowsFor = async (itemId: string) =>
    db.select().from(labResults).where(eq(labResults.orderItemId, itemId));

  /* ═══════════════════ the precondition — 17a §6.2, all three parts ═══════════════════ */

  it("refuses item_not_resultable on an item whose tube has not been received", async () => {
    const placed = await resultable(["TSH"], { receiveTube: false });
    const tsh = await analyteIdFor("TSH");
    await expect(withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: placed.itemIds[0]!, analyteId: tsh, value: "2.1", entryMode: "manual",
    }))).rejects.toMatchObject({ code: "item_not_resultable" });
    expect(await rowsFor(placed.itemIds[0]!)).toHaveLength(0);
  });

  it("refuses permission_denied — the F28 code, not a borrowed 404", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const stranger = await mkUser(db, "ward.clerk", ["nurse"]);
    const tsh = await analyteIdFor("TSH");
    await expect(withTx(db, (tx) => enterResult(tx, stranger.actor, {
      orderItemId: itemIds[0]!, analyteId: tsh, value: "2.1", entryMode: "manual",
    }))).rejects.toMatchObject({ code: "permission_denied" });
  });

  /* ═══════════════════════ A6 — THE RANGE IS SNAPSHOTTED AT ENTRY ═══════════════════════ */

  it("A6: a range-book edit AFTER entry changes neither the stored range nor the flag", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const tsh = await analyteIdFor("TSH");
    /** 5.5 against 0.35–4.94 is HIGH; TSH declares no critical band, so the flag is `H`, not `HH`. */
    const entered = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: tsh, value: "5.5", entryMode: "manual",
    }));
    expect(entered.flag).toBe("H");

    const before = (await rowsFor(itemIds[0]!))[0]!;
    expect([before.refLow, before.refHigh]).toEqual(["0.3500", "4.9400"]);
    expect(before.refRangeId).not.toBeNull();

    /** THE MUTANT'S WORLD: the curator widens the range the next morning. */
    await db.update(labReferenceRanges).set({ high: "99.0000" })
      .where(eq(labReferenceRanges.analyteId, tsh));

    const after = (await rowsFor(itemIds[0]!))[0]!;
    expect([after.refLow, after.refHigh, after.flag]).toEqual(["0.3500", "4.9400", "H"]);
  });

  /* ═════════ A7 — THE DELTA IS AGAINST THE PREVIOUS **VERIFIED** RESULT (02 H2) ═════════ */

  it("A7: delta flags against the prior VERIFIED 0.9, not the more recent UNVERIFIED 4.2", async () => {
    const crea = await analyteIdFor("CREA");
    /**
     * CREA rather than HB: it carries `delta_abs 0.5` over a 168-hour window and NO critical band,
     * so the assertion is about the delta alone and not about a call ladder opening beside it.
     *
     * The three instants are INJECTED, an hour apart, because the ordering is `entered_at DESC` and
     * three inserts in one millisecond would make which prior the mutant finds a matter of luck.
     */
    const t0 = new Date("2026-08-30T04:00:00Z");
    const t1 = new Date("2026-08-30T05:00:00Z");
    const t2 = new Date("2026-08-30T06:00:00Z");

    const first = await resultable(["RFT"], { at: t0 });
    const entered0 = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: first.itemIds[0]!, analyteId: crea, value: "0.9", entryMode: "manual",
    }, t0));
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered0.resultId }, t0);

    /** A SECOND, MORE RECENT prior — keyed, never signed. The mutant compares against this one. */
    const second = await resultable(["RFT"], { at: t1 });
    await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: second.itemIds[0]!, analyteId: crea, value: "4.2", entryMode: "manual",
    }, t1));

    /** TODAY: 4.1. Against 0.9 that is a move of 3.2 (flagged); against 4.2 it is 0.1 (not). */
    const today = await resultable(["RFT"], { at: t2 });
    const outcome = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: today.itemIds[0]!, analyteId: crea, value: "4.1", entryMode: "manual",
    }, t2));

    expect(outcome.deltaFlagged).toBe(true);
    const row = (await rowsFor(today.itemIds[0]!)).find((r) => r.analyteId === crea)!;
    expect(row.deltaPrevResultId).toBe(entered0.resultId);
    /**
     * TWO delta events exist and both are correct: the UNVERIFIED 4.2 also moved 3.3 against the
     * signed 0.9. The assertion is about THIS result's event — filtering by `resultId` rather than
     * counting, because "how many deltas fired today" is not the claim A7 makes.
     */
    const mine = (await eventsNamed("lab.result_delta_flagged"))
      .filter((e) => (e.payload as { resultId: string }).resultId === outcome.resultId);
    expect(mine.map((e) => (e.payload as { priorValue: string }).priorValue)).toEqual(["0.9000"]);
  });

  /* ══════════════ A8 — THE ABSURD ENVELOPE AND ITS SECOND PAIR OF HANDS ══════════════ */

  it("A8: an absurd glucose is refused; the enterer may not override; a second holder may", async () => {
    const { itemIds } = await resultable(["GLUF"]);
    const gluf = await analyteIdFor("GLUF");
    /**
     * THE VALUE IS 1600 AND NOT THE PLAN'S 1200 (§9.4's correction). The golden catalogue's GLUF
     * envelope is 5 … 1500 mg/dL, so 1200 is INSIDE it: the plan's own input would have asserted
     * nothing and passed against an implementation with no envelope check at all.
     */
    const enter = async (over?: { by: string }) => withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: gluf, value: "1600", entryMode: "manual",
      absurdOverride: over,
    }));

    await expect(enter()).rejects.toMatchObject({ code: "absurd_value" });
    expect(await rowsFor(itemIds[0]!)).toHaveLength(0);

    await expect(enter({ by: fx.bench.id })).rejects.toMatchObject({ code: "absurd_override_same_actor" });
    expect(await rowsFor(itemIds[0]!)).toHaveLength(0);

    /** A named second holder who does NOT hold `lab.results.enter` is refused too. */
    const outsider = await mkUser(db, "reception.desk", ["lab_reception"]);
    await expect(enter({ by: outsider.id })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await rowsFor(itemIds[0]!)).toHaveLength(0);

    const ok = await enter({ by: bench2.id });
    const row = (await rowsFor(itemIds[0]!))[0]!;
    /** `numeric(14,4)` reads back scaled — the column's own precision, not a formatting choice. */
    expect([row.valueNumeric, row.absurdOverriddenBy]).toEqual(["1600.0000", bench2.id]);
    expect(ok.flag).toBe("HH");
  });

  /* ═════════ A5's ENTRY HALF — THE CRITICAL CALL OPENS AT ENTRY, NOT AT VERIFY ═════════ */

  it("A5: K+ 6.8 opens exactly ONE call at ENTRY, before any verification", async () => {
    const { itemIds } = await resultable(["RFT"]);
    const k = await analyteIdFor("K");
    const entered = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: k, value: "6.8", entryMode: "manual",
    }));

    expect(entered.flag).toBe("HH");
    expect(entered.criticalCallId).not.toBeNull();

    const calls = await db.select().from(labCriticalCalls);
    expect(calls).toHaveLength(1);
    expect([calls[0]!.closedAt, calls[0]!.readbackText]).toEqual([null, null]);

    /** NOTHING has been verified — this is the whole of 02 F1 and E34. */
    const rows = await rowsFor(itemIds[0]!);
    expect(rows.find((r) => r.analyteId === k)!.verificationStatus).toBe("unverified");
    const flagged = await eventsNamed("lab.result_critical_flagged");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.payload).toMatchObject({ band: "high", value: "6.8" });
  });

  /* ══════════════════ DD3 / E38 — THE CALCULATED ANALYTES, AND THE GUARD ══════════════════ */

  it("writes no calculated row until every input exists, then reports the guard in words (E38)", async () => {
    const { itemIds } = await resultable(["LIPID"]);
    const item = itemIds[0]!;
    const [tc, tg, hdl, ldl] = await Promise.all(["TC", "TG", "HDL", "LDL"].map((c) => analyteIdFor(c)));

    /** TC alone: LDL's inputs are incomplete, so NO calculated row is written yet. */
    await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: item, analyteId: tc!, value: "200", entryMode: "manual",
    }));
    expect((await rowsFor(item)).map((r) => r.analyteId)).toEqual([tc]);

    await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: item, analyteId: hdl!, value: "50", entryMode: "manual",
    }));
    /** TG 450 — E38: every input is present and the GUARD refuses, so the answer is TEXT. */
    const last = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: item, analyteId: tg!, value: "450", entryMode: "manual",
    }));

    expect(last.computed.map((c) => c.analyteId)).toContain(ldl);
    const ldlRow = (await rowsFor(item)).find((r) => r.analyteId === ldl)!;
    expect(ldlRow.valueNumeric).toBeNull();
    expect(ldlRow.valueText).toMatch(/not calculable/);
  });

  it("computes LDL as a NUMBER when the guard holds", async () => {
    const { itemIds } = await resultable(["LIPID"]);
    const item = itemIds[0]!;
    const [tc, hdl, tg, ldl] = await Promise.all(["TC", "HDL", "TG", "LDL"].map((c) => analyteIdFor(c)));
    for (const [id, value] of [[tc, "200"], [hdl, "50"], [tg, "150"]] as const) {
      await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
        orderItemId: item, analyteId: id!, value, entryMode: "manual",
      }));
    }
    /** 200 − 50 − 150/5 = 120 */
    const ldlRow = (await rowsFor(item)).find((r) => r.analyteId === ldl)!;
    expect(Number(ldlRow.valueNumeric)).toBe(120);
  });

  /* ══════════════════════ the notifiable flag — 28a's only input ══════════════════════ */

  it("emits lab.notifiable_flagged for HBsAg and nothing for TSH", async () => {
    const tshOrder = await resultable(["TSH"]);
    const tsh = await analyteIdFor("TSH");
    await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: tshOrder.itemIds[0]!, analyteId: tsh, value: "2.0", entryMode: "manual",
    }));
    expect(await eventsNamed("lab.notifiable_flagged")).toHaveLength(0);

    /**
     * HBsAg is `notifiable: true` AND priced by the fixture's tariff. MP is notifiable too and is
     * NOT priced — `deskOrder` would die on `tariff_item_missing` before any result existed, which
     * is billing working correctly and not what this row measures.
     */
    const mpOrder = await resultable(["HBSAG"]);
    const mpAg = await analyteIdFor("HBSAG");
    await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: mpOrder.itemIds[0]!, analyteId: mpAg,
      value: "Reactive", entryMode: "manual",
    }));
    const flagged = await eventsNamed("lab.notifiable_flagged");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.payload).toMatchObject({ orderItemId: mpOrder.itemIds[0]! });
  });

  /* ══════════════════ THE CLOSE REVIEW'S FIXES, PINNED ══════════════════ */

  it("C3: a rerun that corrects an INPUT recomputes the derived value, as a superseding row", async () => {
    const { itemIds } = await resultable(["LIPID"]);
    const item = itemIds[0]!;
    const [tc, hdl, tg, ldl] = await Promise.all(["TC", "HDL", "TG", "LDL"].map((c) => analyteIdFor(c)));

    /** A transposition: 500 for 150. LDL computes to 500 − 50 − 24 = 426. */
    for (const [id, value] of [[tc, "500"], [hdl, "50"], [tg, "120"]] as const) {
      await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
        orderItemId: item, analyteId: id!, value, entryMode: "manual",
      }));
    }
    const before = (await rowsFor(item)).filter((r) => r.analyteId === ldl);
    expect(Number(before.at(-1)!.valueNumeric)).toBe(426);

    /** The bench re-keys the cholesterol. */
    await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: item, analyteId: tc!, value: "150", entryMode: "manual",
    }));

    /**
     * `done` counted ANY row for the analyte, so the LDL was SKIPPED and a signed report would have
     * read *cholesterol 150, LDL 426* — an arithmetically impossible pair a cardiologist acts on.
     */
    const after = (await rowsFor(item)).filter((r) => r.analyteId === ldl);
    expect(after).toHaveLength(2);
    expect(Number(after.at(-1)!.valueNumeric)).toBe(76);
    /** DD13 — a recomputation REPLACES and NAMES what it replaced. It never edits. */
    expect(after.at(-1)!.supersedesResultId).toBe(before.at(-1)!.id);
  });

  it("M3: a re-keyed value names the row it supersedes, without the caller remembering to", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const tsh = await analyteIdFor("TSH");
    const first = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: tsh, value: "2.0", entryMode: "manual",
    }));
    const second = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: tsh, value: "3.1", entryMode: "manual",
    }));

    /**
     * `EnterResultInput` declared these fields and the ROUTE's schema named neither, so zod stripped
     * them and every re-keyed value was written with a NULL chain — on the one path that exists to
     * answer "which number did this replace". They are DERIVED now.
     */
    const rows = await rowsFor(itemIds[0]!);
    const newer = rows.find((r) => r.id === second.resultId)!;
    expect([newer.supersedesResultId, newer.rerunOf]).toEqual([first.resultId, first.resultId]);
  });

  it("M9: a blank value is a 422 refusal, not a raw numeric error reaching the bench as a 500", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const tsh = await analyteIdFor("TSH");
    /** `Number("")` is 0 and finite, so this parsed, then died in Postgres on an empty numeric. */
    await expect(withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: tsh, value: "   ", entryMode: "manual",
    }))).rejects.toMatchObject({ code: "catalogue_invalid" });
    expect(await rowsFor(itemIds[0]!)).toHaveLength(0);
  });

  it("C2: an AMENDED critical value opens the call ladder, exactly as a keyed one does", async () => {
    const { itemIds } = await resultable(["RFT"]);
    const k = await analyteIdFor("K");
    /** Signed at 22:00 as a transposition of 6.9. */
    const entered = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: itemIds[0]!, analyteId: k, value: "4.2", entryMode: "manual",
    }));
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: entered.resultId });
    expect(await db.select().from(labCriticalCalls)).toHaveLength(0);

    const corrected = await withTx(db, (tx) => amendResult(tx, fx.pathologist.actor, {
      resultId: entered.resultId, value: "6.9",
    }));

    /**
     * `amendResult` computed the flag and threw it away: it returned `flag: null`, opened no call
     * and emitted no event. **The one path where the value is KNOWN to have been wrong was the one
     * path with no telephone call**, and the open-ladder handover list did not show it.
     */
    expect([corrected.flag, corrected.criticalCallId !== null]).toEqual(["HH", true]);
    const calls = await db.select().from(labCriticalCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resultId).toBe(corrected.resultId);
    const flagged = await eventsNamed("lab.result_critical_flagged");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.payload).toMatchObject({ value: "6.9", band: "high" });
  });

  /* ═══════════════════════ the item's own machine, and the rerun ═══════════════════════ */

  it("moves the LAB item accessioned → resulted and leaves the ENVELOPE at in_progress", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const item = itemIds[0]!;
    const tsh = await analyteIdFor("TSH");
    const outcome = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: item, analyteId: tsh, value: "2.0", entryMode: "manual",
    }));
    /** TSH reports ONE analyte, so a single entry takes the item all the way to `resulted`. */
    expect(outcome.itemState).toBe("resulted");
    const [envelope] = await db.select({ status: orderItems.status })
      .from(orderItems).where(eq(orderItems.id, item));
    expect(envelope!.status).toBe("in_progress");
  });

  it("a rerun sends a RESULTED item back to in_analysis, keeps the doubted row, and charges nothing", async () => {
    const { itemIds } = await resultable(["TSH"]);
    const item = itemIds[0]!;
    const tsh = await analyteIdFor("TSH");
    const entered = await withTx(db, (tx) => enterResult(tx, fx.bench.actor, {
      orderItemId: item, analyteId: tsh, value: "2.0", entryMode: "manual",
    }));
    const invoicesBefore = (await eventsNamed("invoice.issued")).length;

    const rerun = await withTx(db, (tx) => requestRerun(tx, fx.pathologist.actor, {
      resultId: entered.resultId, reason: "analyser drift",
    }));

    expect(rerun.state).toBe("in_analysis");
    /** The doubted row STAYS: `lab_results` is never edited and never deleted (DD13). */
    expect(await rowsFor(item)).toHaveLength(1);
    expect((await eventsNamed("invoice.issued")).length).toBe(invoicesBefore);
    const [instance] = await db.select({ state: workflowInstances.currentState })
      .from(workflowInstances).where(eq(workflowInstances.subjectId, item));
    expect(instance!.state).toBe("in_analysis");
  });
});
