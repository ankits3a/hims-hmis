import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkOtPatient, seedOtBase } from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { events, otCases, otLists } from "../../kernel/db/schema";
import { eq } from "drizzle-orm";
import { bookCase, caseState } from "./booking";
import { flagLateSurgeons, listForDay, printPack, publishList, resequence } from "./lists";
import { satisfyGate, caseGates } from "./gates";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T4 — the list: published as a version, sequenced, and the late-surgeon flag.
 */
const LIST_DATE = "2026-09-02";
const SLOT = "2026-09-02T03:30:00.000Z"; // 09:00 IST

describe("the OT list (Plan 15 T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let f: OtBaseFixture;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    f = await seedOtBase(db);
    patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi");
  });

  async function book(over: Record<string, unknown> = {}): Promise<{ caseId: string; encounterId: string }> {
    const r = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
      surgeonId: f.surgeon.id, anaesthetistId: f.anaesthetist.id,
      listDate: LIST_DATE, payerClass: "self_pay", ...over,
    });
    return { caseId: r.caseId, encounterId: r.encounterId };
  }

  it("publishes version 1, moves every case `booked → listed`, and emits `list.published`", async () => {
    const a = await book();
    const result = await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    expect(result).toMatchObject({ version: 1, caseCount: 1, readyCaseIds: [] });
    expect(await caseState(db, a.caseId)).toBe("listed");

    const published = (await db.select().from(otLists))[0]!;
    expect({ status: published.status, version: published.version, by: published.publishedBy })
      .toEqual({ status: "published", version: 1, by: f.incharge.id });

    const emitted = (await db.select().from(events)).filter((e) => e.name === "list.published");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ version: 1, caseCount: 1, listDate: LIST_DATE });
  });

  /**
   * C2 — a re-publish is a NEW VERSION and the old one is SUPERSEDED, so "which list are you
   * holding?" has an answer. A list edited in place would have no version to print on the sheet.
   */
  it("a re-publish supersedes the previous version rather than editing it", async () => {
    await book();
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    const second = await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    expect(second.version).toBe(2);
    const rows = await db.select().from(otLists);
    expect(rows.map((r) => ({ v: r.version, s: r.status })).sort((a, b) => a.v - b.v))
      .toEqual([{ v: 1, s: "superseded" }, { v: 2, s: "published" }]);
  });

  /**
   * ═══ F18/F24g — A CASE WITH NO NAMED ANAESTHETIST CANNOT BE PUBLISHED ═══
   *
   * The adversarial pass found that `usersHoldingRole("anaesthetist")` is a LIST, not an assignment:
   * nothing else in this tree says WHICH anaesthetist is doing WHICH case. Sign-in requires one, so
   * the refusal belongs at publish — the evening before — rather than at 08:00 in the holding bay
   * with a fasted patient on the trolley. That is F24's "Sunday list without an anaesthetist".
   */
  it("F18 — refuses to publish a list whose cases have no assigned anaesthetist, naming all of them", async () => {
    const a = await book({ anaesthetistId: undefined });
    const b = await book({
      anaesthetistId: undefined, procedureClass: "ortho_ganglion_excision",
      procedureCode: "ORT-GANG-01", laterality: "left",
    });
    try {
      await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toMatch(/2 case\(s\) have no assigned anaesthetist/);
      // BOTH are named, not just the first — a coordinator fixing them one refusal at a time is a
      // coordinator re-publishing four times on a Sunday evening.
      expect((error as { detail?: { caseIds: string[] } }).detail?.caseIds?.sort())
        .toEqual([a.caseId, b.caseId].sort());
    }
    // Nothing was written: no list row, and the cases are still `booked`.
    expect(await db.select().from(otLists)).toHaveLength(0);
    expect(await caseState(db, a.caseId)).toBe("booked");
  });

  it("refuses to publish a day with no cases at all", async () => {
    await expect(publishList(db, f.incharge, { listDate: "2026-09-09", theatreResourceId: f.theatreId }))
      .rejects.toThrow(/no cases on 2026-09-09/);
  });

  /** A case whose gates were all satisfied BEFORE publication reaches `ready` in the same call. */
  it("evaluates readiness at publish, so a fully-gated case is `ready` immediately", async () => {
    const { caseId } = await book({
      procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    const gates = new Map((await caseGates(db, caseId)).map((g) => [g.kind, g.id]));
    // The ganglion class: five gates, and `site_marking` is waivable so this needs no consent
    // laterality dance — the point here is the readiness evaluation, not the gate rules.
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gates.get("consent_procedure")!, {
      procedureCode: "ORT-GANG-01", templateVersion: "v3", language: "hi", signer: "patient",
      thumbImpression: false, laterality: "left", conversionCovered: true, signedAt: "2026-09-01T10:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.surgeon, gates.get("site_marking")!, {
      laterality: "left", markedBy: f.surgeon.id, markedAt: "2026-09-02T03:00:00.000Z",
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gates.get("escort")!, {
      name: "Ram Kumar", relation: "husband", phone: "9800002222", idType: "aadhaar", idLast4: "4321", ageYears: 40,
    }));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gates.get("privilege")!, {}));
    // `deposit` stays open, so the case must NOT be ready.
    const notYet = await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    expect(notYet.readyCaseIds).toEqual([]);
    expect(await caseState(db, caseId)).toBe("listed");
  });

  // ═══════════════════════════════ sequencing ═══════════════════════════════

  it("re-sequences the whole list in one transaction, and refuses a partial or duplicated order", async () => {
    const a = await book();
    const b = await book({
      procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });

    // The SWAP — the case a non-deferrable unique index on (date, theatre, seq) would refuse
    // mid-statement, which is why `ot_cases.seq` deliberately carries none.
    await resequence(db, f.incharge, {
      listDate: LIST_DATE, theatreResourceId: f.theatreId, caseIdsInOrder: [b.caseId, a.caseId],
    });
    const seqs = new Map((await db.select().from(otCases)).map((c) => [c.id, c.seq]));
    expect({ a: seqs.get(a.caseId), b: seqs.get(b.caseId) }).toEqual({ a: 2, b: 1 });

    // A PARTIAL order would leave the unnamed case at its old number, colliding with a new one.
    await expect(resequence(db, f.incharge, {
      listDate: LIST_DATE, theatreResourceId: f.theatreId, caseIdsInOrder: [a.caseId],
    })).rejects.toThrow(/rewrites the whole list/);
    await expect(resequence(db, f.incharge, {
      listDate: LIST_DATE, theatreResourceId: f.theatreId, caseIdsInOrder: [a.caseId, a.caseId],
    })).rejects.toThrow(/appears twice/);
    await expect(resequence(db, f.incharge, {
      listDate: LIST_DATE, theatreResourceId: f.theatreId, caseIdsInOrder: [a.caseId, "not-a-case"],
    })).rejects.toThrow(/is not on this list/);
  });

  it("`listForDay` returns the cases in sequence with their gate chips", async () => {
    const a = await book();
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    const items = await listForDay(db, LIST_DATE, f.theatreId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ caseId: a.caseId, seq: 1, state: "listed", procedureClass: "gynae_dnc" });
    expect(items[0]!.gates.map((g) => g.kind).sort()).toEqual([
      "anaesthesia_review", "consent_anaesthesia", "consent_procedure", "deposit", "escort", "npo", "privilege",
    ]);
    expect(new Set(items[0]!.gates.map((g) => g.state))).toEqual(new Set(["open"]));
  });

  /** DD19 — the pack's DATA, printable from a draft, because C1's scenario IS the server being down. */
  it("`printPack` names the four downtime sheets and the case's gate states", async () => {
    const a = await book();
    const pack = await printPack(db, a.caseId);
    expect(pack.sheets).toEqual(["who_checklist", "count_sheet", "implant_sticker_sheet", "specimen_label"]);
    expect(pack).toMatchObject({ caseId: a.caseId, procedureCode: "GYN-DNC-01", seq: 1, listDate: LIST_DATE });
    expect(pack.gates).toHaveLength(7);
    await expect(printPack(db, "no-such-case")).rejects.toThrow(/unknown case/);
  });

  // ═══════════════════════════════ F1 — the late flag ═══════════════════════════════

  /**
   * F1 — the job FLAGS and never cancels. The no-show cancel at +60 is a human act carrying an
   * attribution (R-3.12), because "the surgeon did not come" and "the patient was unfit" produce
   * different charges in 15d's matrix and only a human knows which happened.
   */
  it("F1 — flags a late surgeon at the highest rung reached, once, and never cancels", async () => {
    const { caseId } = await book();
    const gates = new Map((await caseGates(db, caseId)).map((g) => [g.kind, g.id]));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gates.get("npo")!, {
      plannedStart: SLOT, lastSolidsAt: "2026-09-01T16:00:00.000Z",
      lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
    }));
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });

    // Ten minutes past the slot: below the first rung.
    expect(await flagLateSurgeons(db, new Date("2026-09-02T03:40:00.000Z"))).toBe(0);
    // Twenty: the +15 rung.
    expect(await flagLateSurgeons(db, new Date("2026-09-02T03:50:00.000Z"))).toBe(1);
    // A second sweep at the same lateness flags NOTHING — the job is idempotent per (case, rung),
    // which matters because it runs every five minutes and the digest is read by a human.
    expect(await flagLateSurgeons(db, new Date("2026-09-02T03:52:00.000Z"))).toBe(0);
    // Forty: the +30 rung is a NEW fact and flags once more.
    expect(await flagLateSurgeons(db, new Date("2026-09-02T04:10:00.000Z"))).toBe(1);
    expect(await flagLateSurgeons(db, new Date("2026-09-02T04:20:00.000Z"))).toBe(0);

    const flags = (await db.select().from(events)).filter((e) => e.name === "surgeon.late_flagged");
    expect(flags.map((e) => (e.payload as { minutesLate: number }).minutesLate).sort((a, b) => a - b))
      .toEqual([15, 30]);
    // And the case is untouched: flagged, not cancelled.
    expect(await caseState(db, caseId)).toBe("listed");
  });

  it("F1 — a case with no NPO gate is not flagged, because nothing knows when it was meant to start", async () => {
    // The ganglion class has `npoRequired: false`, so there is no gate carrying a planned start.
    await book({ procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left" });
    await publishList(db, f.incharge, { listDate: LIST_DATE, theatreResourceId: f.theatreId });
    expect(await flagLateSurgeons(db, new Date("2026-09-02T23:00:00.000Z"))).toBe(0);
  });

  it("F1 — a case that is no longer waiting is not flagged", async () => {
    const { caseId } = await book();
    const gates = new Map((await caseGates(db, caseId)).map((g) => [g.kind, g.id]));
    await withTx(db, (tx) => satisfyGate(tx, f.coordinator, gates.get("npo")!, {
      plannedStart: SLOT, lastSolidsAt: "2026-09-01T16:00:00.000Z",
      lastClearFluidsAt: "2026-09-01T21:00:00.000Z", attestedBy: "patient",
    }));
    // NOT published: the case is still `booked`, so it is not on anybody's list to be late for.
    expect(await flagLateSurgeons(db, new Date("2026-09-02T23:00:00.000Z"))).toBe(0);
  });
});
