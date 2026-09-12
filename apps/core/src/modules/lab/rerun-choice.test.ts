import { asc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  deskAndLabel, grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  events, labAnalytes, labOrderableAnalytes, labOrderables, labResults,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import { LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument } from "./instruments";
import { chooseReportedResult, enterResult } from "./results";
import { verifyResult } from "./verify";
import { labWorklist } from "./worklist";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ 17-E T7 — A MACHINE NEVER SUPERSEDES; A HUMAN ALWAYS DOES ═══
 *
 * The phase doc's §8.7 measured the defect this file guards, with a throwaway probe rather than by
 * reading: two transmissions from one analyser carrying the same analyte for the same tube produced
 *
 *     rows: 2   [ {v: 5.0000, supersedes: null,    rerunOf: null},
 *                 {v: 9.9000, supersedes: <first>, rerunOf: <first>} ]
 *
 * Both rows live — D9's first half already held. **The second value AUTO-SUPERSEDED the first, with
 * no human choice and no reason**, which is what D9 forbids and what ROADMAP v2 Q5 settled: *a
 * machine never supersedes; a human always does.*
 *
 * ═══ AND IT IS A CONTRADICTION BETWEEN TWO CORRECT RULES, NOT A BUG ═══
 *
 * Close review M3 put `?? priorForAnalyte?.id` there ON PURPOSE, to close a real hole: the chain was
 * NULL for every re-keyed value, so an NABL auditor following `supersedes_result_id` back to the
 * number that was wrong found nothing. **A human re-keying at the bench IS a supersession.** An
 * analyser re-running the same tube is NOT — both values are legitimate measurements, and
 * auto-choosing the later one is how a bad second run silently overwrites a good first one.
 *
 * So `M3 — a human re-key still supersedes` below is not a nice-to-have: it is the assertion that
 * stops a successor resolving this contradiction by deleting M3's line, which would re-open the
 * audit hole M3 closed. **Both halves must be green at once or the fix is wrong.**
 *
 * ═══ THE DISCRIMINATOR IS READ FROM THE ROW, NEVER PASSED BY THE CALLER ═══
 *
 * `entry_mode` already says whether a machine produced the value, and D6 makes it route-bounded:
 * the bench controller's enum is `["manual","manual_from_printout"]`, so a human cannot label a
 * keystroke machine-produced. A boolean parameter meaning "I am a machine" would be the same fact
 * asserted by the caller instead of held by the row — and that is how the machine path eventually
 * claims to be a human.
 */
const DAY = new Date("2026-08-30T06:00:00Z");

/**
 * Every lab state a worklist row can be in before a signature. A13 passes all three rather than the
 * bench's two: whether a rerun's item sits at `in_analysis` or has already reached `resulted`
 * depends on how many of the orderable's analytes the machine reported, and the assertion is about
 * the ASSEMBLY both seats share, not about which of them happens to be looking.
 */
/** The repeat run, ten minutes after the first — see `transmit`. */
const RERUN_AT = new Date("2026-08-30T06:10:00Z");

const LIVE_LAB_STATES = ["accessioned", "in_analysis", "resulted"] as const;

describe("17-E T7 — a rerun keeps both values and a human chooses", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let bridge: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    await ensureRole(db, "lab_bridge");
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_INSTRUMENTS_READ);
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_RESULTS_INTERFACE);
    bridge = await mkUser(db, "lab.bridge", ["lab_bridge"]);
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "ANL-CHEM-1", name: "Chemistry analyser", sampleIdMode: "barcode",
    }));
  });
  afterEach(() => { fx.unregister(); });

  /* ─────────────────────────────── the shared fixtures ─────────────────────────────── */

  async function analytesOf(code: string): Promise<{ id: string; code: string }[]> {
    return await db
      .select({ id: labAnalytes.id, code: labAnalytes.code })
      .from(labOrderables)
      .innerJoin(labOrderableAnalytes, eq(labOrderableAnalytes.serviceId, labOrderables.serviceId))
      .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
      .where(eq(labOrderables.serviceId, serviceIdForLabCode(code)));
  }

  /** A received tube, plus the mapped instrument code, ready for a machine to measure. */
  async function tubeWithMappedCode(
    code = "CBC",
  ): Promise<{ specimenNo: string; analyteId: string; orderItemId: string }> {
    const analytes = await analytesOf(code);
    const analyte = analytes[0]!;
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analyte.id,
    });
    const { specimens } = await deskAndLabel(db, fx, [code]);
    const specimenNo = specimens[0]!.specimenNo;
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    const [item] = await db
      .select({ id: labResults.orderItemId })
      .from(labResults)
      .limit(1);
    return { specimenNo, analyteId: analyte.id, orderItemId: item?.id ?? "" };
  }

  /**
   * One machine transmission of one analyte for one tube.
   *
   * `at` defaults to `DAY` for the assertions that do not care. **A13 passes two distinct times on
   * purpose:** two rows sharing `entered_at` to the microsecond make "oldest first" a tie, and a tie
   * is resolved by whatever physical order Postgres happens to return — which A13b's own `UPDATE`
   * was observed to change mid-test. A rerun happens *after* the run it repeats, so the fixture that
   * says so is both deterministic and truer.
   */
  async function transmit(specimenNo: string, value: string, ref: string, at: Date = DAY): Promise<void> {
    await ingestResults(db, bridge.actor, {
      instrumentId,
      transmissionRef: ref,
      rows: [{ position: 1, sampleId: specimenNo, code: "HGB", value }],
    }, at);
  }

  async function rowsForAnalyte(analyteId: string) {
    return await db
      .select().from(labResults)
      .where(eq(labResults.analyteId, analyteId))
      .orderBy(asc(labResults.enteredAt));
  }

  /* ─────────────────────────── A1 — the machine never supersedes ─────────────────────────── */

  /**
   * **THE KILL.** Against the code this task guards, the second row's `supersedes_result_id` is the
   * first row's id. That is the whole defect, live in merged code and in the deployed base since
   * 2026-09-06, on every machine path T3, T4 and T5 ship.
   */
  it("A1: a second transmission for the same analyte on the same tube does NOT supersede the first", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");

    const rows = await rowsForAnalyte(analyteId);
    expect(rows).toHaveLength(2);
    /** Both values live. Neither is superseded — nothing chose, so nothing was replaced. */
    expect(rows.map((r) => r.supersedesResultId)).toEqual([null, null]);
    /** And the pair is LINKED, so the bench can see that these two are one tube measured twice. */
    expect(rows[1]!.rerunOf).toBe(rows[0]!.id);
    expect(rows[0]!.rerunOf).toBeNull();
  });

  /**
   * The override door stays open for the human amendment path (`requestRerun`'s caller) and shut
   * for the bridge. Without this, D9 is enforced by a `??` that any caller can step around, and the
   * rule would hold only for callers that did not think to pass the field.
   */
  it("A2: an interface-mode write may not CARRY a supersession, even if its caller asks", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    const [first] = await rowsForAnalyte(analyteId);

    await expect(enterResult(db, bridge.actor, {
      orderItemId: first!.orderItemId,
      analyteId,
      value: "9.9",
      entryMode: "interface",
      analyzerId: instrumentId,
      supersedesResultId: first!.id,
    }, DAY)).rejects.toMatchObject({ code: "machine_cannot_supersede" });
  });

  /**
   * ═══ THE HALF THAT MUST NOT BREAK ═══
   *
   * M3's own assertion lives in `results.test.ts`; this one is here because the two rules are
   * resolved in the same expression and a successor reading only this file must meet both.
   */
  it("M3: a human re-key still supersedes, and the chain an auditor follows is unbroken", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    const [machine] = await rowsForAnalyte(analyteId);

    await enterResult(db, fx.bench.actor, {
      orderItemId: machine!.orderItemId, analyteId, value: "13.1", entryMode: "manual",
    }, DAY);

    const rows = await rowsForAnalyte(analyteId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.supersedesResultId).toBe(machine!.id);
  });

  /* ────────────────────────── A3 — nothing reaches a report unchosen ────────────────────────── */

  /**
   * ═══ WHY THE GUARD IS AT VERIFY AND NOT AT THE REPORT ═══
   *
   * `reports.ts` picks the LAST VERIFIED ROW per analyte. Removing the auto-supersession alone
   * would have moved the silent overwrite one layer up: two live rows, both verifiable, and the
   * report carries whichever was signed second. Verification is where a number becomes reportable,
   * so it is the door — and `reports.ts` needs no change at all, which is what keeps a shared
   * reader from being widened (22c-A C1).
   */
  it("A3: neither value of an unresolved rerun may be verified", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const rows = await rowsForAnalyte(analyteId);

    for (const row of rows) {
      await expect(verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: row.id }, DAY))
        .rejects.toMatchObject({ code: "rerun_unchosen" });
    }
  });

  it("A4: the chosen value verifies, and the one not chosen still cannot", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const [first, second] = await rowsForAnalyte(analyteId);

    await chooseReportedResult(db, fx.bench.actor, {
      resultId: second!.id, reason: "first run clotted; repeat on a fresh aliquot",
    }, DAY);

    const verified = await verifyResult(
      db, fx.pathologist.actor, fx.decls, { resultId: second!.id }, DAY,
    );
    expect(verified).toBeTruthy();

    /**
     * **AND THE UNCHOSEN ROW IS STILL REFUSED AFTER THE CHOSEN ONE IS SIGNED.** "Live" therefore
     * cannot mean "unverified": if it did, signing the chosen value would release its twin, and the
     * report's last-verified-row rule would then carry the number the bench rejected.
     */
    await expect(verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: first!.id }, DAY))
      .rejects.toMatchObject({ code: "rerun_unchosen" });
  });

  /* ──────────────────────────── A5 — the choice, and its reason ──────────────────────────── */

  it("A5: a choice without a reason is refused — the reason is the record, not a courtesy", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const rows = await rowsForAnalyte(analyteId);

    for (const reason of ["", "   ", "\n\t "]) {
      await expect(chooseReportedResult(db, fx.bench.actor, { resultId: rows[1]!.id, reason }, DAY))
        .rejects.toMatchObject({ code: "rerun_choice_reason_required" });
    }
  });

  it("A6: choosing where there is nothing to choose between is refused", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    const [only] = await rowsForAnalyte(analyteId);

    await expect(chooseReportedResult(db, fx.bench.actor, {
      resultId: only!.id, reason: "looks right",
    }, DAY)).rejects.toMatchObject({ code: "no_rerun_to_choose" });
  });

  it("A7: the choice is stored on the row — who, when, and why — and is auditable", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const [, second] = await rowsForAnalyte(analyteId);

    await chooseReportedResult(db, fx.bench.actor, {
      resultId: second!.id, reason: "repeat after dilution",
    }, DAY);

    const [row] = await db.select().from(labResults).where(eq(labResults.id, second!.id));
    expect(row!.reportedChoiceBy).toBe(fx.bench.id);
    expect(row!.reportedChoiceReason).toBe("repeat after dilution");
    expect(row!.reportedChoiceAt).not.toBeNull();

    const rows = await db.select().from(events);
    expect(rows.some((e) => e.name === "lab.result_chosen")).toBe(true);
  });

  it("A8: the choice can MOVE while both values are unsigned, and the move is audited", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const [first, second] = await rowsForAnalyte(analyteId);

    await chooseReportedResult(db, fx.bench.actor, { resultId: second!.id, reason: "repeat" }, DAY);
    await chooseReportedResult(db, fx.bench.actor, {
      resultId: first!.id, reason: "the repeat ran on a clotted aliquot; the first run stands",
    }, DAY);

    const rows = await rowsForAnalyte(analyteId);
    /** Exactly one row carries the choice — a set with two chosen values is a report with two answers. */
    expect(rows.filter((r) => r.reportedChoiceAt !== null).map((r) => r.id)).toEqual([first!.id]);
    expect(await db.select().from(events)
      .then((es) => es.filter((e) => e.name === "lab.result_chosen"))).toHaveLength(2);
  });

  it("A9: once the chosen value is SIGNED the set is closed — the choice cannot move", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const [first, second] = await rowsForAnalyte(analyteId);

    await chooseReportedResult(db, fx.bench.actor, { resultId: second!.id, reason: "repeat" }, DAY);
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: second!.id }, DAY);

    await expect(chooseReportedResult(db, fx.bench.actor, {
      resultId: first!.id, reason: "changed my mind",
    }, DAY)).rejects.toMatchObject({ code: "rerun_choice_final" });
  });

  /* ─────────────────── A10 — the report carries the chosen value and only it ─────────────────── */

  /**
   * The end of the lifecycle, not the end of the thing the task changed (#136). A rule enforced at
   * verify is worth what the REPORT prints, and nothing else asserts that the two agree.
   */
  it("A10: the report carries the chosen value, not the last one the machine sent", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    await transmit(specimenNo, "9.9", "run-2");
    const [first] = await rowsForAnalyte(analyteId);

    await chooseReportedResult(db, fx.bench.actor, {
      resultId: first!.id, reason: "the repeat was run on the wrong dilution",
    }, DAY);
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: first!.id }, DAY);

    const verified = await db.select().from(labResults)
      .where(eq(labResults.verificationStatus, "verified"));
    expect(verified).toHaveLength(1);
    expect(verified[0]!.valueNumeric).toBe("12.5000");
  });

  /* ──────────────── A11 — a superseded row was always unreportable; now it is refused ──────────── */

  /**
   * FOUND AT T7, not planned. The guard above asks whether a row has a LIVE sibling; a superseded
   * row always has one, so it would have been refused with `rerun_unchosen` — a sentence about a
   * rerun, to somebody signing a value a re-key replaced. The refusal is right and the wording was
   * not, so the superseded case gets its own code. Nothing else in the module refused it: a
   * superseded row signed after its replacement would be the last verified row for the analyte and
   * `reports.ts` would print it.
   */
  it("A11: a row a re-key superseded may not be verified", async () => {
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "12.5", "run-1");
    const [machine] = await rowsForAnalyte(analyteId);
    await enterResult(db, fx.bench.actor, {
      orderItemId: machine!.orderItemId, analyteId, value: "13.1", entryMode: "manual",
    }, DAY);

    await expect(verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: machine!.id }, DAY))
      .rejects.toMatchObject({ code: "result_superseded" });
  });

  /* ─────────── A12 — an unresolved rerun does not silently feed a computed analyte ─────────── */

  /**
   * ═══ CLOSE REVIEW C3, ONE LAYER OUT ═══
   *
   * C3 measured what a derived value computed from a stale input costs: cholesterol keyed 500 (a
   * transposed 150), LDL written 426, the cholesterol corrected and the LDL left standing — *a
   * signed report reading cholesterol 150, LDL 426, an arithmetically impossible pair a
   * cardiologist would act on.* Its fix reads "the newest row is the current value", which was true
   * while every path superseded.
   *
   * **After A1 it is false**: a lipid panel on a chemistry analyser is the canonical rerun, and the
   * newest cholesterol row is now one of two nobody has chosen between. So an unresolved set has NO
   * current value, and a formula over it is not computed until the bench says which. Writing one
   * would be C3's own defect with a machine holding the pen.
   */
  /** The lipid panel, measured by the analyser: LDL = TC − HDL − TG/5, computed by us. */
  async function lipidOnTheMachine(): Promise<{
    specimenNo: string; ids: Record<string, string>; orderItemId: string;
  }> {
    const analytes = await analytesOf("LIPID");
    const ids = Object.fromEntries(analytes.map((a) => [a.code, a.id]));
    for (const [machineCode, code] of [["CHOL", "TC"], ["HDLC", "HDL"], ["TRIG", "TG"]] as const) {
      await mapInstrumentCode(db, fx.pathologist.actor, {
        instrumentId, instrumentCode: machineCode, analyteId: ids[code]!,
      });
    }
    const { specimens } = await deskAndLabel(db, fx, ["LIPID"]);
    const specimenNo = specimens[0]!.specimenNo;
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    await ingestResults(db, bridge.actor, {
      instrumentId,
      transmissionRef: "lipid-1",
      rows: [
        { position: 1, sampleId: specimenNo, code: "CHOL", value: "500" },
        { position: 2, sampleId: specimenNo, code: "HDLC", value: "50" },
        { position: 3, sampleId: specimenNo, code: "TRIG", value: "120" },
      ],
    }, DAY);
    const [ldlRow] = await db.select().from(labResults).where(eq(labResults.analyteId, ids.LDL!));
    return { specimenNo, ids: ids as Record<string, string>, orderItemId: ldlRow!.orderItemId };
  }

  /** The analyser re-runs the cholesterol alone. Two live TC values, and nobody has chosen. */
  async function rerunTheCholesterol(specimenNo: string): Promise<void> {
    await ingestResults(db, bridge.actor, {
      instrumentId,
      transmissionRef: "lipid-2",
      rows: [{ position: 1, sampleId: specimenNo, code: "CHOL", value: "150" }],
    }, DAY);
  }

  it("A12: a formula whose INPUT is an unresolved rerun may not be verified — and its neighbour still may", async () => {
    const { specimenNo, ids } = await lipidOnTheMachine();
    const before = await rowsForAnalyte(ids.LDL!);
    /** The transposition C3 measured: 500 − 50 − 24 = 426. */
    expect(Number(before.at(-1)!.valueNumeric)).toBe(426);

    await rerunTheCholesterol(specimenNo);

    /**
     * **THE KILL, AND IT IS C3's OWN DEFECT WITH A MACHINE HOLDING THE PEN.** The LDL row still
     * reads 426, computed from a cholesterol the laboratory now doubts. Signing it — the TC rows
     * being refused by A3 — would publish a report carrying an LDL and no cholesterol, derived from
     * a number that never reached the page.
     */
    await expect(verifyResult(
      db, fx.pathologist.actor, fx.decls, { resultId: before.at(-1)!.id }, DAY,
    )).rejects.toMatchObject({ code: "rerun_unchosen" });

    /**
     * ═══ THE DISCRIMINATOR, AND THE MUTANT IT KILLS ═══
     *
     * VLDL is `TG / 5`. Its only input is resolved, so it is signable and this panel is not held
     * hostage by an unrelated rerun. A guard written per PANEL rather than per INPUT would refuse
     * it, and every lipid profile in the laboratory would stop on any one repeated analyte.
     */
    const vldl = await rowsForAnalyte(ids.VLDL!);
    expect(Number(vldl.at(-1)!.valueNumeric)).toBe(24);
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: vldl.at(-1)!.id }, DAY);
  });

  it("A13: choosing the input recomputes every formula over it, as superseding rows", async () => {
    const { specimenNo, ids } = await lipidOnTheMachine();
    await rerunTheCholesterol(specimenNo);
    const tcRows = await rowsForAnalyte(ids.TC!);
    expect(tcRows).toHaveLength(2);

    await chooseReportedResult(db, fx.bench.actor, {
      resultId: tcRows[1]!.id, reason: "the 500 was a transposition; the repeat confirms 150",
    }, DAY);

    /**
     * A CHOICE THAT DID NOT RECOMPUTE WOULD LEAVE THE LDL AT 426 FOR EVER — DD13 makes the row
     * unrewritable, so the only correct answer is a superseding row, which is exactly what C3's fix
     * does when an input moves. **The choice IS that move**, and it moves THREE derived analytes,
     * not one: a recomputation that walked only the formula the author had in mind is #130's shape.
     */
    for (const [code, expected] of [["LDL", 76], ["NONHDL", 100], ["TCHDL", 3]] as const) {
      const rows = await rowsForAnalyte(ids[code]!);
      expect([code, rows.length]).toEqual([code, 2]);
      expect([code, Number(rows.at(-1)!.valueNumeric)]).toEqual([code, expected]);
      expect([code, rows.at(-1)!.supersedesResultId]).toEqual([code, rows[0]!.id]);
    }
    /** And VLDL, whose input never moved, is NOT rewritten. */
    expect(await rowsForAnalyte(ids.VLDL!)).toHaveLength(1);

    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: tcRows[1]!.id }, DAY);
    const ldl = await rowsForAnalyte(ids.LDL!);
    await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: ldl.at(-1)!.id }, DAY);
    const verified = await db.select().from(labResults)
      .where(eq(labResults.verificationStatus, "verified"));
    expect(verified.map((r) => r.analyteId).sort()).toEqual([ids.LDL!, ids.TC!].sort());
  });

  /* ─────────── A13 — the seat that must choose can SEE the pair, in its own worklist ─────────── */

  /**
   * **THE SCREEN'S HALF OF D18, AND THE HALF THAT WAS MISSING.** A3 proves nothing unchosen reaches
   * a report; A5 proves the choice carries a reason. Both are the SERVER's half, and both were
   * already green while the seat that has to make the choice could not see that one was owed.
   *
   * `labWorklist` is what the bench and the pathologist both read. Against the code this assertion
   * guards it answers, for an analyte carrying two live runs:
   *
   *     analytes: [ { value: "9.9000", resultId: <the SECOND row>, rerunChoice: undefined } ]
   *
   * — the later run, silently, with nothing saying a judgement is owed. **`.at(-1)` is the
   * auto-supersession D9 forbids, performed by the VIEW instead of by the writer.** The bench sees
   * one number, believes it, and `assertReportable` then refuses `rerun_unchosen` two seats later at
   * the pathologist's signature — for a state the bench could neither see nor resolve.
   *
   * So the view must say what `currentValue` says, which is the reason that helper returns three
   * different answers: **no reportable value here, and these are the two candidates.**
   *
   * ═══ WHY THIS ASSERTION IS HERE AND NOT IN `worklist.test.ts` ═══
   *
   * The pair is what makes it a test, and building one takes a registered analyser, a mapped code
   * and two transmissions — this file's `beforeEach` and its `tubeWithMappedCode`/`transmit`. A copy
   * of that fixture in the worklist's own file would be a second place for the rerun's semantics to
   * drift from `liveRowsFor`. The worklist's three existing cases cover the single-value shape.
   */
  it("A13 — two live runs: the worklist reports NO value and offers the pair, oldest first", async () => {
    await grantPermissionToRole(db, fx.registry, "lab_technician", "lab.worklist.read");
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "5.0", "run-1");
    await transmit(specimenNo, "9.9", "run-2", RERUN_AT);

    const rows = await rowsForAnalyte(analyteId);
    expect(rows).toHaveLength(2);

    const worklist = await labWorklist(db, fx.bench.actor, LIVE_LAB_STATES);
    const analyte = worklist.flatMap((r) => r.analytes).find((a) => a.analyteId === analyteId);

    /**
     * NULL, not "9.9000". The analyte HAS no reportable value while the choice is owed, and a view
     * that printed one would be printing the answer to a question nobody answered.
     */
    expect(analyte).toBeDefined();
    expect({ value: analyte!.value, resultId: analyte!.resultId }).toEqual({
      value: null,
      resultId: null,
    });

    /** The pair, oldest first, each run with what the bench needs to judge it. */
    expect(analyte!.rerunChoice.map((c) => [c.value, c.resultId, c.isRerun])).toEqual([
      ["5.0000", rows[0]!.id, false],
      ["9.9000", rows[1]!.id, true],
    ]);
    /** Machine-produced, which is WHY a choice is owed: a human re-key would have superseded. */
    expect(analyte!.rerunChoice.map((c) => c.entryMode)).toEqual(["interface", "interface"]);
  });

  /**
   * THE OTHER SIDE OF THE SAME SWITCH. Once the bench has chosen, the worklist carries the CHOSEN
   * value — not the latest — and stops asking. A view that kept offering a resolved pair would send
   * the technologist back to a decision they had already recorded a reason for.
   */
  it("A13b — after the choice the worklist carries the CHOSEN run and offers nothing", async () => {
    await grantPermissionToRole(db, fx.registry, "lab_technician", "lab.worklist.read");
    const { specimenNo, analyteId } = await tubeWithMappedCode();
    await transmit(specimenNo, "5.0", "run-1");
    await transmit(specimenNo, "9.9", "run-2", RERUN_AT);
    const rows = await rowsForAnalyte(analyteId);

    /** The FIRST run, which is not the one `.at(-1)` would have shown — that is the discriminator. */
    await chooseReportedResult(db, fx.bench.actor, {
      resultId: rows[0]!.id,
      reason: "second run's QC failed on the same plate",
    });

    const worklist = await labWorklist(db, fx.bench.actor, LIVE_LAB_STATES);
    const analyte = worklist.flatMap((r) => r.analytes).find((a) => a.analyteId === analyteId);
    expect({ value: analyte!.value, resultId: analyte!.resultId, owed: analyte!.rerunChoice }).toEqual({
      value: "5.0000",
      resultId: rows[0]!.id,
      owed: [],
    });
  });
});
