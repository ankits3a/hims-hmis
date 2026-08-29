import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { collectOrderKinds } from "../../kernel/orders/kinds";
import { ordersManifest } from "../../kernel/orders/manifest";
import { advanceOrderItem } from "../../kernel/orders/advance";
import { ORDERS_PLACE, placeOrder } from "../../kernel/orders/place";
import { seedLabCatalogue, serviceIdForLabCode } from "../../../scripts/seed-lab-catalogue";
import { duplicateWarnings, overlappingAnalytes } from "./duplicates";
import { labManifest } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 17a T3 — THE DUPLICATE DETECTOR. Assertion Book rows **A5 and A6**.
 *
 * Both close a gap phase 0 wrote into its own CONTRACT (§6A.3, §6A.4), so both are asserted against
 * the REAL `findRecentItems` and real placed orders rather than against a stub — a detector that
 * only works against a fake kernel reader closes nothing.
 */
const PATIENT_A = "01PATIENT000000000000000A";
const PATIENT_B = "01PATIENT000000000000000B";
const VISIT_A = "V2608290001";
const VISIT_B = "V2608290002";
const DAY = "2026-08-29";

describe("the duplicate detector (17a T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let doctor: Actor;
  let decls: ReturnType<typeof collectOrderKinds>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values([
      { id: PATIENT_A, uhid: "HMS-00000001-5", name: "Ram Kumar", sex: "male",
        administrativeGender: "male", createdBy: "t", updatedBy: "t" },
      { id: PATIENT_B, uhid: "HMS-00000002-3", name: "Ram Kumar", sex: "male",
        administrativeGender: "male", createdBy: "t", updatedBy: "t" },
    ]);
    unregister = registerEncounterResolver("V", async (_d, no) =>
      no === VISIT_A ? { patientId: PATIENT_A, intendedPayer: "self" }
        : no === VISIT_B ? { patientId: PATIENT_B, intendedPayer: "self" } : null);

    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    registry.install(labManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "pathologist");
    for (const p of [ORDERS_PLACE, "orders.read", "lab.orders.place", "lab.catalogue.manage"]) {
      await grantPermissionToRole(db, registry, "pathologist", p);
    }
    ({ actor: doctor } = await mkUser(db, "dr.mehra", ["pathologist"]));
    decls = collectOrderKinds(registry);
    await seedLabCatalogue(db, doctor);
  });

  afterEach(() => { unregister(); });

  /** Places one lab order, backdated, so the window has something real to find. */
  async function place(patientId: string, encounterNo: string, codes: string[], hoursAgo: number): Promise<string[]> {
    const placedAt = new Date(Date.now() - hoursAgo * 3_600_000);
    const { itemIds } = await withTx(db, (tx) => placeOrder(tx, doctor, decls, {
      kind: "lab", patientId, encounterNo, serviceDate: DAY, orderingClinicianId: doctor.id, placedAt,
      items: codes.map((c) => ({ serviceId: serviceIdForLabCode(c) })),
    }));
    return itemIds;
  }

  it("overlappingAnalytes: a profile and its constituent share analytes, and unrelated tests do not", async () => {
    const map = await overlappingAnalytes(db, [serviceIdForLabCode("CBC")]);
    const siblings = map.get(serviceIdForLabCode("CBC")) ?? [];
    // FEVER, PREOP, ANAEMIA and the two health checks all contain the CBC analytes.
    expect(siblings).toContain(serviceIdForLabCode("FEVER"));
    expect(siblings).toContain(serviceIdForLabCode("ANAEMIA"));
    // A urine routine shares nothing with a CBC.
    expect(siblings).not.toContain(serviceIdForLabCode("URINE"));
    // It always contains ITSELF, so a caller never has to special-case the exact match.
    expect(siblings).toContain(serviceIdForLabCode("CBC"));
  });

  /**
   * ═══ A5 — THE CBC INSIDE THE FEVER PROFILE ═══
   *
   * `findRecentItems` alone sees nothing here: "Fever profile" and "CBC" are two different
   * `service_id` values, which is phase 0 §6A.3 in one sentence. The mutant compares `service_id`
   * only and returns no warning — so the patient is bled twice and billed twice, twenty hours apart,
   * for the same sixteen analytes.
   */
  it("A5: a standalone CBC today is warned about the Fever profile ordered 20 h ago", async () => {
    await place(PATIENT_A, VISIT_A, ["FEVER"], 20);
    const warnings = await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.matchedServiceId).toBe(serviceIdForLabCode("FEVER"));
    expect(warnings[0]!.reason).toContain("inside Fever profile");
    // The reason NAMES the order it duplicates, because a counter has to be able to go and look.
    expect(warnings[0]!.duplicateOfOrderNo).toMatch(/^L\d{10}$/);
  });

  it("A5b: outside the window there is no warning — the rule is a WINDOW, not a history", async () => {
    await place(PATIENT_A, VISIT_A, ["FEVER"], 30);
    expect(await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")])).toEqual([]);
  });

  /**
   * ═══ A6 — THE MERGE CHAIN, RESOLVED BEFORE THE WINDOW IS QUERIED ═══
   *
   * §6A.4: `findRecentItems` reads a patient ROW, not a person. Two registrations of one Ram Kumar,
   * merged an hour ago, and the order sits under the LOSER's id. The mutant looks up only the id it
   * was handed and finds nothing — which is the case a duplicate check exists for, because two
   * records that look unrelated are exactly where a double charge goes unnoticed.
   */
  it("A6: an order placed under a MERGED-AWAY registration is still found", async () => {
    await place(PATIENT_B, VISIT_B, ["CBC"], 2);
    /**
     * B is merged INTO A. **The chain lives on the PATIENT ROW** — `status = 'merged'` plus
     * `merged_into_patient_id` — which is what `followMergeChain` walks and what
     * `listMergedLoserIds` reads back the other way. The first draft of this fixture wrote a
     * `patient_merge_requests` row instead, which is the REQUEST and not the outcome; it typechecked
     * against neither and would have asserted nothing if it had.
     */
    await db.update(patients)
      .set({ status: "merged", mergedIntoPatientId: PATIENT_A, updatedBy: "t" })
      .where(eq(patients.id, PATIENT_B));
    const warnings = await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.matchedServiceId).toBe(serviceIdForLabCode("CBC"));
  });

  it("warns once per (requested orderable, existing item), however many analytes they share", async () => {
    // A single Fever profile shares SIXTEEN analytes with a CBC. One warning, not sixteen: a
    // counter shown the same duplicate sixteen times stops reading warnings altogether.
    await place(PATIENT_A, VISIT_A, ["FEVER"], 1);
    const warnings = await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")]);
    expect(warnings).toHaveLength(1);
  });

  it("returns nothing for a patient with no recent orders, and nothing for an empty basket", async () => {
    expect(await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")])).toEqual([]);
    expect(await duplicateWarnings(db, doctor, PATIENT_A, [])).toEqual([]);
  });

  /**
   * THE TROPONIN WINDOW (02 D11) — the one clinical exception, and the reason the window is
   * per-orderable rather than a constant. A troponin is repeated deliberately at 3 and 6 hours to
   * read the CURVE; warning about the previous one would train a ward to click through the warning
   * that matters. See `duplicates.ts`'s finding F1: the value lives in code because T1 shipped no
   * column for it.
   */
  it("at 8 h a troponin is outside its window and a CBC is still inside its own", async () => {
    /**
     * THE ASSERTION IS THE DIFFERENCE BETWEEN THE TWO WINDOWS, AT ONE INSTANT. Eight hours is
     * outside troponin's 6 h and inside the CBC's 24 h, so one warns and the other does not on the
     * same fixture — which is what makes this a test of a PER-ORDERABLE window rather than of a
     * constant.
     *
     * **The first draft asserted a 4 h repeat was not flagged, and that was the TEST being wrong.**
     * Four hours is inside a six-hour window; 02 D11's rule is that troponin's window is SHORTER
     * than the default, not that a serial troponin never warns. The detector warns and never
     * refuses — a second doctor ordering a troponin four hours after the first should be told the
     * first exists, and then proceed if the curve is the point. (The same run found a real defect
     * beside it: the window map was keyed by ANALYTE code where `windowFor` reads the ORDERABLE's,
     * so every troponin was silently on the 24 h default. That one was the code.)
     */
    await place(PATIENT_A, VISIT_A, ["TROPI", "CBC"], 8);
    expect(await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("TROPI")])).toEqual([]);
    const cbc = await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")]);
    expect(cbc.length).toBeGreaterThan(0);

    // And INSIDE its own window the troponin does warn — so the empty result above is the window
    // doing its job, not the detector failing to see a troponin at all.
    await place(PATIENT_A, VISIT_A, ["TROPI"], 2);
    expect((await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("TROPI")])).length)
      .toBeGreaterThan(0);
  });

  /** A CANCELLED item does not block a clinically-required repeat — the kernel's own A3 rule. */
  it("a cancelled prior item is not a duplicate", async () => {
    const [itemId] = await place(PATIENT_A, VISIT_A, ["CBC"], 2);
    await withTx(db, (tx) => advanceOrderItem(tx, doctor, decls, itemId!, "cancelled", { reason: "wrong patient" }));
    expect(await duplicateWarnings(db, doctor, PATIENT_A, [serviceIdForLabCode("CBC")])).toEqual([]);
  });
});
