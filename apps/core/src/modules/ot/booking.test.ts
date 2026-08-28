import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  CRITERIA_BODY, OT_PACKAGE_CODES, mkOtPatient, publishOtDefinition, seedOtBase,
} from "../../../test/helpers/ot";
import { withTx } from "../../kernel/db/client";
import { approveRequest } from "../../kernel/approvals/decisions";
import { daycareEncounters, otCaseGates, otCases } from "../../kernel/db/schema";
import {
  activateVersion, createDraftVersion, setTariffItem, submitVersion,
} from "../tariff";
import { bookCase, cancelCase, caseState, changePayerClass, postponeCase } from "./booking";
import { OtError } from "./errors";
import type { OtBaseFixture } from "../../../test/helpers/ot";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 15 T3 — booking: three refusals, one soft block, and a quote that does not move.
 */
const LIST_DATE = "2026-09-02";

describe("bookCase (Plan 15 T3)", () => {
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

  const dnc = () => ({
    patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc",
    surgeonId: f.surgeon.id, listDate: LIST_DATE, payerClass: "self_pay" as const,
  });

  it("books a case: the encounter is numbered `D…`, the case is `booked`, the quote is the package", async () => {
    const result = await bookCase(db, f.coordinator, dnc());
    expect(result.encounterNo).toMatch(/^D\d{6}\d{4}$/);
    expect(result.quotePaise).toBe(6_000_000);
    // `self_pay` at 100 % with no implant estimate.
    expect(result.requiredDepositPaise).toBe(6_000_000);
    expect(await caseState(db, result.caseId)).toBe("booked");
  });

  // ═══════════════════════════════ A2 (at the booking seam) ═══════════════════════════════

  it("A2 — a class outside the ACTIVE whitelist is REFUSED `criteria_refused`", async () => {
    await expect(bookCase(db, f.coordinator, { ...dnc(), procedureClass: "gynae_colposcopy" }))
      .rejects.toThrow(OtError);
    await expect(bookCase(db, f.coordinator, { ...dnc(), procedureClass: "gynae_colposcopy" }))
      .rejects.toThrow(/not in the ACTIVE day-care criteria whitelist/);
    // Nothing was written — a refused booking leaves no encounter behind.
    expect(await db.select().from(daycareEncounters)).toHaveLength(0);
  });

  // ═══════════════════════════════ A3 ═══════════════════════════════

  /**
   * ═══ A3 — PRIVILEGING IS PER CLASS, NOT PER SURGEON ═══
   *
   * The discriminating input is **a surgeon privileged for `ortho_ganglion_excision` booking
   * `gynae_dnc`**. The mutant treats "has ANY privilege" as privileged, which is the shape a hurried
   * implementation takes — and it credentials every surgeon for every procedure the moment they are
   * credentialed for one. A surgeon with NO entry at all does NOT discriminate: both
   * implementations refuse.
   */
  it("A3 — a surgeon privileged for another class is REFUSED for this one", async () => {
    await publishOtDefinition(db, {
      kind: "privileges",
      body: { surgeons: [{ surgeonId: f.surgeon.id, procedureClasses: ["ortho_ganglion_excision"] }] },
      drafter: f.drafter, ms: f.ms,
    });
    await expect(bookCase(db, f.coordinator, dnc())).rejects.toThrow(/not privileged for "gynae_dnc"/);
    // The control: the class they ARE privileged for books.
    await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
  });

  it("A3 — a surgeon with NO privilege entry at all is refused (the non-discriminating leg)", async () => {
    await expect(bookCase(db, f.coordinator, { ...dnc(), surgeonId: "somebody-else" }))
      .rejects.toThrow(/not privileged/);
  });

  // ═══════════════════════════════ A4 ═══════════════════════════════

  /**
   * ═══ A4 — EXACTLY THE GATES THE CLASS NAMES, AND NOT ONE MORE ═══
   *
   * The mutant creates every kind for every case, and the harm is not noise: a non-lateral D&C with
   * a `site_marking` gate can NEVER reach `ready`, because there is no laterality for the triple
   * equality to compare. A case blocked for ever by a gate that should not exist is, from the
   * coordinator's chair, indistinguishable from a system that is simply broken.
   */
  it("A4 — a non-lateral, non-trauma D&C gets NEITHER `site_marking` NOR `mlc`", async () => {
    const { caseId } = await bookCase(db, f.coordinator, dnc());
    const gates = (await db.select().from(otCaseGates).where(eq(otCaseGates.caseId, caseId))).map((g) => g.kind).sort();
    expect(gates).toEqual([
      "anaesthesia_review", "consent_anaesthesia", "consent_procedure", "deposit", "escort", "npo", "privilege",
    ]);
    expect(gates).not.toContain("site_marking");
    expect(gates).not.toContain("mlc");
  });

  it("A4 — a LATERAL TRAUMA class gets both, and a local-anaesthesia class gets NO `npo` gate", async () => {
    const radius = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_distal_radius_fixation", procedureCode: "ORT-RAD-01", laterality: "right",
    });
    const radiusGates = (await db.select().from(otCaseGates).where(eq(otCaseGates.caseId, radius.caseId))).map((g) => g.kind).sort();
    expect(radiusGates).toContain("site_marking");
    expect(radiusGates).toContain("mlc");
    expect(radiusGates).toHaveLength(9);

    // H9 / N1 / F25 — a class with `npoRequired: false` gets NO NPO gate at all, rather than one
    // that has to be waived. A gate that exists to be waived teaches a unit to waive gates.
    const ganglion = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    const ganglionGates = (await db.select().from(otCaseGates).where(eq(otCaseGates.caseId, ganglion.caseId))).map((g) => g.kind).sort();
    expect(ganglionGates).not.toContain("npo");
    expect(ganglionGates).toEqual(["consent_procedure", "deposit", "escort", "privilege", "site_marking"]);
  });

  it("A4 — the criteria's `waivableGates` are snapshotted onto the gate rows, per class", async () => {
    const ganglion = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    const radius = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_distal_radius_fixation", procedureCode: "ORT-RAD-01", laterality: "right",
    });
    const waivable = async (caseId: string): Promise<string[]> =>
      (await db.select().from(otCaseGates).where(eq(otCaseGates.caseId, caseId)))
        .filter((g) => g.waivable).map((g) => g.kind);
    // `site_marking` is waivable on the ganglion and NOT on the radius — the same kind, two answers,
    // which is what stops `waivable` being read as a property of the KIND.
    expect(await waivable(ganglion.caseId)).toEqual(["site_marking"]);
    expect(await waivable(radius.caseId)).toEqual([]);
  });

  // ═══════════════════════════════ A5 ═══════════════════════════════

  /**
   * ═══ A5 — THE QUOTE IS PINNED AT BOOKING (B10) ═══
   *
   * Book, then publish a tariff revision that RAISES the package, then read the case back. The
   * mutant re-prices at read — which is the simpler implementation, and which moves a number the
   * patient was quoted and a deposit that was computed from it.
   */
  it("A5 — a tariff revision after booking does not move `quote_paise` or the pinned version", async () => {
    const booked = await bookCase(db, f.coordinator, dnc());
    const before = (await db.select().from(otCases).where(eq(otCases.id, booked.caseId)))[0]!;
    expect({ quote: before.quotePaise, version: before.tariffVersionId })
      .toEqual({ quote: 6_000_000, version: f.tariffVersionId });

    // A revision that raises the package by 50 %, activated the way the tariff module requires.
    const draft = await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, f.drafter, { copyFromVersionId: f.tariffVersionId });
      await setTariffItem(tx, f.drafter, d.versionId, f.packageServiceIds.gynaeDnc, 9_000_000);
      return d;
    });
    const submitted = await withTx(db, (tx) => submitVersion(tx, f.drafter, draft.versionId));
    await approveRequest(db, f.owner, { approvalId: submitted.approvalId, note: "raise" });
    await activateVersion(db, f.activator, draft.versionId, new Date("2026-01-03T00:00:00Z"));

    const after = (await db.select().from(otCases).where(eq(otCases.id, booked.caseId)))[0]!;
    expect({ quote: after.quotePaise, version: after.tariffVersionId })
      .toEqual({ quote: 6_000_000, version: f.tariffVersionId });

    // …and the NEXT booking gets the new price, so the pin is a PIN and not a frozen tariff. A
    // different list date, because the same one would hit A9's duplicate block rather than the
    // property under test.
    const next = await bookCase(db, f.coordinator, { ...dnc(), listDate: "2026-09-03" }, new Date("2026-01-04T00:00:00Z"));
    expect(next.quotePaise).toBe(9_000_000);
    expect(next.requiredDepositPaise).toBe(9_000_000);
  });

  // ═══════════════════════════════ A9 ═══════════════════════════════

  it("A9 — a second live case for the same patient, date and class is a SOFT block an in-charge can force", async () => {
    await bookCase(db, f.coordinator, dnc());
    await expect(bookCase(db, f.coordinator, dnc())).rejects.toThrow(/already has a live/);
    // FORCED, by anybody the route lets through — the permission is the control, not this function.
    const forced = await bookCase(db, f.incharge, { ...dnc(), force: true });
    expect(await caseState(db, forced.caseId)).toBe("booked");
  });

  it("A9 — a DIFFERENT date, a different class, or a cancelled first case do not block", async () => {
    const first = await bookCase(db, f.coordinator, dnc());
    await bookCase(db, f.coordinator, { ...dnc(), listDate: "2026-09-03" });
    await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    // A CANCELLED case is not live — its instance is `completed`, so the same slot is bookable again.
    await cancelCase(db, f.coordinator, { caseId: first.caseId, reason: "patient withdrew", attribution: "patient" });
    await bookCase(db, f.coordinator, dnc());
  });

  // ═══════════════════════════ N8, N13 and the encounter ═══════════════════════════

  /**
   * N8 — a bilateral case is TWO `ot_cases` on ONE `daycare_encounter`, which is what makes
   * `consumptionsFor(encounterId)` span them and what stops the patient paying two deposits.
   */
  it("N8 — a second case may join an existing encounter, keeping one encounter number", async () => {
    const first = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-L", laterality: "left",
    });
    const second = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-R", laterality: "right",
      encounterId: first.encounterId, force: true,
    });
    expect(second.encounterId).toBe(first.encounterId);
    expect(second.encounterNo).toBe(first.encounterNo);
    expect(await db.select().from(daycareEncounters)).toHaveLength(1);
    expect(await db.select().from(otCases)).toHaveLength(2);
  });

  it("refuses to attach a case to an encounter belonging to a different patient", async () => {
    const first = await bookCase(db, f.coordinator, dnc());
    const other = await mkOtPatient(db, f.coordinator, "Ram Kumar", { sex: "male" });
    await expect(bookCase(db, f.coordinator, {
      ...dnc(), patientId: other, encounterId: first.encounterId,
    })).rejects.toThrow(/belongs to a different patient/);
  });

  it("sequences cases on the list, and a second case takes the next seq", async () => {
    const a = await bookCase(db, f.coordinator, dnc());
    const b = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-01", laterality: "left",
    });
    const rows = await db.select().from(otCases);
    const seqs = new Map(rows.map((r) => [r.id, r.seq]));
    expect({ a: seqs.get(a.caseId), b: seqs.get(b.caseId) }).toEqual({ a: 1, b: 2 });
  });

  // ═══════════════════════════ cancel, postpone, payer class ═══════════════════════════

  it("R-3.12 — a cancellation records its reason AND its attribution class", async () => {
    const booked = await bookCase(db, f.coordinator, dnc());
    await cancelCase(db, f.coordinator, { caseId: booked.caseId, reason: "TPA denied at 07:00", attribution: "payer" });
    const row = (await db.select().from(otCases).where(eq(otCases.id, booked.caseId)))[0]!;
    expect({ reason: row.cancellationReason, attribution: row.cancellationAttribution })
      .toEqual({ reason: "TPA denied at 07:00", attribution: "payer" });
    expect(await caseState(db, booked.caseId)).toBe("cancelled");
  });

  /** §3A / D5 — a postponed case comes BACK with a new date, and the deposit is NOT released. */
  it("a postponement re-lists the case at a new date and returns it to `booked`", async () => {
    const booked = await bookCase(db, f.coordinator, dnc());
    await postponeCase(db, f.coordinator, {
      caseId: booked.caseId, reason: "no_sterile_set", newListDate: "2026-09-09",
    });
    expect(await caseState(db, booked.caseId)).toBe("booked");
    const row = (await db.select().from(otCases).where(eq(otCases.id, booked.caseId)))[0]!;
    expect(row.listDate).toBe("2026-09-09");
  });

  /** DD12's last row — the class changes, the deposit recomputes, and BOTH classes are evidenced. */
  it("a payer-class change recomputes the required deposit against the new class", async () => {
    const booked = await bookCase(db, f.coordinator, dnc());
    const changed = await changePayerClass(db, f.incharge, {
      encounterId: booked.encounterId, to: "insured_tpa", reason: "TPA card produced at check-in",
      sanctionedPaise: 6_000_000,
    });
    // The co-pay floor, not zero — A1's rule reached through the booking seam.
    expect(changed).toEqual({ from: "self_pay", to: "insured_tpa", requiredDepositPaise: 1_200_000 });
    const row = (await db.select().from(daycareEncounters).where(eq(daycareEncounters.id, booked.encounterId)))[0]!;
    expect(row.payerClass).toBe("insured_tpa");
  });

  /** N8's money half: `required` is the SUM of the encounter's quotes, not one case's. */
  it("a payer-class change on a two-case encounter recomputes against BOTH quotes (N8)", async () => {
    const first = await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-L", laterality: "left",
    });
    await bookCase(db, f.coordinator, {
      ...dnc(), procedureClass: "ortho_ganglion_excision", procedureCode: "ORT-GANG-R", laterality: "right",
      encounterId: first.encounterId, force: true,
    });
    const changed = await changePayerClass(db, f.incharge, {
      encounterId: first.encounterId, to: "self_pay", reason: "insurance withdrawn",
    });
    expect(changed.requiredDepositPaise).toBe(12_000_000);
  });

  it("refuses a booking when the criteria name a package service the tariff does not carry (F8)", async () => {
    await publishOtDefinition(db, {
      kind: "criteria",
      body: { entries: [{ ...CRITERIA_BODY.entries[0]!, packageServiceCode: "DC-NO-SUCH-SERVICE" }] },
      drafter: f.drafter, ms: f.ms,
    });
    await expect(bookCase(db, f.coordinator, dnc()))
      .rejects.toThrow(/which the tariff does not carry/);
  });

  it("refuses a list date that is not an IST calendar date", async () => {
    await expect(bookCase(db, f.coordinator, { ...dnc(), listDate: "02-09-2026" }))
      .rejects.toThrow(/IST calendar date/);
  });

  it("the package service code is written from the CRITERIA, never from the caller", async () => {
    const booked = await bookCase(db, f.coordinator, dnc());
    const row = (await db.select().from(otCases).where(eq(otCases.id, booked.caseId)))[0]!;
    expect(row.packageServiceCode).toBe(OT_PACKAGE_CODES.gynaeDnc);
  });
});
