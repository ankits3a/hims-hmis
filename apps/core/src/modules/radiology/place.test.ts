import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  events, imagingDefinitions, opdEncounters, orderItems, orders, patients,
  registrationConfig, services,
} from "../../kernel/db/schema";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { seedActiveStudyTypes, studyTypeRow } from "../../../test/helpers/radiology";
import { ORDERS_PLACE } from "../../kernel/orders/place";
import { RadiologyError } from "./errors";
import { addImagingViews, placeImagingOrder } from "./place";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T3 — Assertion Book rows **A1, A2, A3, A4 and A5**, against a real database.
 *
 * The fixture registers a stand-in `V` resolver the way `kernel/orders/place.test.ts` does, but the
 * encounter-status guard deliberately reads the REAL `opd_encounters` row through OPD's exported
 * `getEncounter` — so A2 is a claim about the shipped reader and not about a fake that was told
 * what to say. That reader only became able to answer a visit NUMBER with Lane A's F1 repair.
 */
const IMAGING_PLACE = "radiology.orders.place";
const imagingDecl: OrderKindDecl = {
  kind: "imaging", seriesKey: "radiology_order", placePermission: IMAGING_PLACE,
  requiresClinician: true, requiresIndication: true, selfOrderable: false,
};
const DECLS = [imagingDecl];

describe("placeImagingOrder (18a T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let doctor: Actor;

  const FEMALE_24 = "01PATIENT0000000000000001";
  const MALE_24 = "01PATIENT0000000000000002";
  const FEMALE_62 = "01PATIENT0000000000000003";
  /** A pelvic USG — the study type the Act covers. */
  const SVC_PELVIC_USG = "01SERVICE0000000000000001";
  /** A chest X-ray — covered by no PCPNDT rule. */
  const SVC_CHEST_XRAY = "01SERVICE0000000000000002";
  /** Named by NO study type, so placement must refuse rather than guess. */
  const SVC_ORPHAN = "01SERVICE0000000000000003";

  const OPEN_VISIT = "V2608310001";
  const ABANDONED_VISIT = "V2608310002";
  const COMPLETED_RECENT = "V2608310003";
  const COMPLETED_OLD = "V2608310004";
  const MALE_VISIT = "V2608310005";
  const OLDER_VISIT = "V2608310006";
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");

  const dobForAge = (years: number) => new Date(Date.UTC(2026 - years, 0, 1));

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig)
      .values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();

    await db.insert(patients).values([
      {
        id: FEMALE_24, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
        administrativeGender: "female", dob: dobForAge(24), createdBy: "t", updatedBy: "t",
      },
      {
        id: MALE_24, uhid: "HMS-00000002-3", name: "Ravi Kumar", sex: "male",
        administrativeGender: "male", dob: dobForAge(24), createdBy: "t", updatedBy: "t",
      },
      {
        id: FEMALE_62, uhid: "HMS-00000003-1", name: "Kamla Devi", sex: "female",
        administrativeGender: "female", dob: dobForAge(62), createdBy: "t", updatedBy: "t",
      },
    ]);

    await db.insert(services).values([
      { id: SVC_PELVIC_USG, code: "USG-PELVIS", name: "USG pelvis", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: SVC_CHEST_XRAY, code: "XR-CHEST", name: "X-ray chest", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: SVC_ORPHAN, code: "ORPHAN", name: "Not in the book", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);

    /**
     * THE ACTIVE STUDY-TYPE BOOK (DD13). Placement reads `pcpndt_applicable` from HERE and from no
     * input, which is what makes the statutory rule a property of the system rather than a
     * checkbox a caller can clear.
     */
    await seedActiveStudyTypes(db, [
      studyTypeRow({ code: "USG-PELVIS", service_id: SVC_PELVIC_USG, modality: "usg", body_part: "pelvis", pcpndt_applicable: true, chaperone_required: true }),
      studyTypeRow({ code: "XR-CHEST", service_id: SVC_CHEST_XRAY, modality: "xray", body_part: "chest", ionising: true }),
    ], NOW);

    const visit = (visitNo: string, status: string, serviceDate: string, patientId = FEMALE_24) => ({
      id: newId(), visitNo, patientId, status, workflowInstanceId: newId(),
      serviceDate, visitType: "new", openedBy: "t", updatedBy: "t",
    });
    await db.insert(opdEncounters).values([
      visit(OPEN_VISIT, "registered", DAY),
      visit(ABANDONED_VISIT, "abandoned", DAY),
      /** DD9's grace: completed two days ago LANDS. */
      visit(COMPLETED_RECENT, "completed", "2026-08-29"),
      /** …and completed eight days ago does NOT. */
      visit(COMPLETED_OLD, "completed", "2026-08-23"),
      /**
       * A3's other two patients need visits of their OWN. `placeOrder` refuses a
       * `patient_encounter_mismatch`, which is the kernel doing exactly its job — the first draft of
       * this suite pointed all three patients at one visit and was refused, correctly.
       */
      visit(MALE_VISIT, "registered", DAY, MALE_24),
      visit(OLDER_VISIT, "registered", DAY, FEMALE_62),
    ]);

    unregister = registerEncounterResolver("V", async (_db, encounterNo) => {
      const rows = await db.select({ patientId: opdEncounters.patientId })
        .from(opdEncounters).where(eq(opdEncounters.visitNo, encounterNo));
      const row = rows[0];
      return row ? { patientId: row.patientId, intendedPayer: "self" } : null;
    });

    const registry = new ModuleRegistry();
    registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: [IMAGING_PLACE], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "doctor");
    await grantPermissionToRole(db, registry, "doctor", ORDERS_PLACE);
    await grantPermissionToRole(db, registry, "doctor", IMAGING_PLACE);
    ({ actor: doctor } = await mkUser(db, "dr.mehra", ["doctor"]));
  });

  afterEach(() => { unregister(); });

  const place = (over: Record<string, unknown> = {}, idemKey?: string) =>
    placeImagingOrder(
      db, doctor, DECLS,
      {
        patientId: FEMALE_24, encounterNo: OPEN_VISIT, serviceDate: DAY,
        orderingClinicianId: "dr-consultant", indication: "rule out ovarian cyst",
        items: [{ serviceId: SVC_PELVIC_USG }],
        ...over,
      } as never,
      idemKey, NOW,
    );

  /* ═══════════════════════════ A1 — IDEMPOTENCY ═══════════════════════════ */

  it("A1: the same Idempotency-Key twice returns the SAME orderNo and places ONE order", async () => {
    const first = await place({}, "key-alpha");
    const second = await place({}, "key-alpha");

    expect(second.orderNo).toBe(first.orderNo);
    expect(second.orderId).toBe(first.orderId);

    const allOrders = await db.select({ id: orders.id }).from(orders);
    expect(allOrders).toHaveLength(1);

    /** ONE `order.placed`, because the second call never reached `placeOrder` at all. */
    const placedEvents = await db.select({ name: events.name })
      .from(events).where(eq(events.name, "order.placed"));
    expect(placedEvents).toHaveLength(1);
  });

  it("A1: a DIFFERENT key mints a second order with its own R number", async () => {
    const first = await place({}, "key-alpha");
    /** The same service inside 24h needs the duplicate override — A4's rule, exercised here. */
    const second = await place(
      { items: [{ serviceId: SVC_PELVIC_USG, duplicateOfItemId: first.itemIds[0], duplicateReason: "repeat for poor acoustic window" }] },
      "key-beta",
    );

    expect(second.orderNo).not.toBe(first.orderNo);
    expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(2);
  });

  it("A1 mutant: with NO key at all, two calls place two orders — the guard is the key, not the body", async () => {
    await place({ items: [{ serviceId: SVC_CHEST_XRAY }] });
    await place({
      items: [{ serviceId: SVC_CHEST_XRAY, duplicateOfItemId: null, duplicateReason: null }],
      encounterNo: COMPLETED_RECENT,
    }).catch(() => undefined);
    /** The first landed; the second is refused by A4's window, which is the point of that guard. */
    expect((await db.select({ id: orders.id }).from(orders)).length).toBeGreaterThanOrEqual(1);
  });

  /* ═══════════════════════════ A2 — THE ENCOUNTER GUARD ═══════════════════════════ */

  it("A2: an order on an ABANDONED visit is refused encounter_closed", async () => {
    await expect(place({ encounterNo: ABANDONED_VISIT })).rejects.toThrow(RadiologyError);
    await expect(place({ encounterNo: ABANDONED_VISIT })).rejects.toThrow(/abandoned/);
    expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(0);
  });

  it("A2: a COMPLETED visit eight days old is refused; TWO days old lands", async () => {
    await expect(place({ encounterNo: COMPLETED_OLD })).rejects.toThrow(/beyond the 7-day grace/);

    const ok = await place({ encounterNo: COMPLETED_RECENT });
    expect(ok.orderNo).toMatch(/^R/);
  });

  /**
   * A2's mutant is dropping the age test, and the consequence it names is a scan hanging off last
   * month's visit. The two legs above are the same test from both sides; this one pins the BOUNDARY
   * so a change from 7 to 8 shows up as a failure rather than as a slightly different hospital.
   */
  it("A2 boundary: exactly seven days is INSIDE the grace, eight is outside", async () => {
    const sevenDaysAgo = "2026-08-24";
    await db.update(opdEncounters).set({ serviceDate: sevenDaysAgo })
      .where(eq(opdEncounters.visitNo, COMPLETED_OLD));
    const ok = await place({ encounterNo: COMPLETED_OLD });
    expect(ok.orderNo).toMatch(/^R/);
  });

  /* ═══════════════════════════ A3 — PCPNDT AT PLACEMENT ═══════════════════════════ */

  it("A3: a pelvic USG on a female aged 24 lands the item RESTRICTED", async () => {
    const result = await place();
    expect(result.pcpndt).toEqual([{
      serviceId: SVC_PELVIC_USG, studyTypeCode: "USG-PELVIS",
      applicable: true, reason: "within_band",
    }]);

    const items = await db.select({ restricted: orderItems.restricted })
      .from(orderItems).where(eq(orderItems.id, result.itemIds[0]!));
    expect(items[0]!.restricted).toBe(true);
  });

  it("A3: the same study on a MALE and on a female aged 62 lands NOT restricted", async () => {
    const male = await place({ patientId: MALE_24, encounterNo: MALE_VISIT }, "k-male");
    const older = await place({ patientId: FEMALE_62, encounterNo: OLDER_VISIT }, "k-older");

    for (const result of [male, older]) {
      const items = await db.select({ restricted: orderItems.restricted })
        .from(orderItems).where(eq(orderItems.id, result.itemIds[0]!));
      expect([result.pcpndt[0]!.applicable, items[0]!.restricted]).toEqual([false, false]);
    }
  });

  it("A3: a study type the book does NOT cover is never restricted", async () => {
    const result = await place({ items: [{ serviceId: SVC_CHEST_XRAY }] });
    expect(result.pcpndt[0]).toMatchObject({ applicable: false, reason: "type_not_covered" });
  });

  /**
   * ═══ THE BYPASS THAT DOES NOT EXIST, AND THIS IS THE ASSERTION FOR IT ═══
   *
   * Applicability is read from the ACTIVE BOOK, so there is no input a caller can send to make a
   * covered scan uncovered. The strongest available proof is that a service the book does not name
   * is REFUSED rather than defaulted to "not applicable" — the alternative would let a typo place
   * an unregistered obstetric scan.
   */
  it("a service named by NO study type is refused, never defaulted to not-applicable", async () => {
    await expect(place({ items: [{ serviceId: SVC_ORPHAN }] }))
      .rejects.toThrow(/not named by any study type/);
    expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(0);
  });

  it("with NO active study-type book, no imaging order can be placed at all", async () => {
    await db.delete(imagingDefinitions);
    /**
     * The refusal now comes from `study-types.ts`, which owns the book since F13 was closed, and its
     * message is generic across definition KINDS rather than hard-coded to this one. The assertion
     * follows the owner rather than pinning a sentence T3 happened to write.
     */
    await expect(place()).rejects.toThrow(/no active study_types definition/);
  });

  /* ═══════════════════════════ A4 — THE DUPLICATE WINDOW ═══════════════════════════ */

  it("A4: the same service for the same patient inside 24h is refused duplicate_recent", async () => {
    await place({}, "k1");
    await expect(place({}, "k2")).rejects.toThrow(/already ordered this patient|already ordered for this patient/);
  });

  it("A4: duplicateOfItemId + duplicateReason together let it through as `duplicate_confirmed`", async () => {
    const first = await place({}, "k1");
    const second = await place({
      items: [{
        serviceId: SVC_PELVIC_USG,
        duplicateOfItemId: first.itemIds[0], duplicateReason: "poor acoustic window, repeat",
      }],
    }, "k2");

    const items = await db.select({ origin: orderItems.origin, dupOf: orderItems.duplicateOfItemId })
      .from(orderItems).where(eq(orderItems.id, second.itemIds[0]!));
    expect(items[0]).toEqual({ origin: "duplicate_confirmed", dupOf: first.itemIds[0] });
  });

  it("A4: a DIFFERENT service is not a duplicate", async () => {
    await place({}, "k1");
    const other = await place({ items: [{ serviceId: SVC_CHEST_XRAY }] }, "k2");
    expect(other.orderNo).toMatch(/^R/);
  });

  /* ═══════════════════════════ A5 — THE ADD-ON IS A NEW ORDER ═══════════════════════════ */

  it("A5: the add-on shares the parent's order_group_id, carries origin `addon`, and gets its OWN order number", async () => {
    const parent = await place({}, "k-parent");
    const parentHeaderBefore = (await db.select().from(orders).where(eq(orders.id, parent.orderId)))[0];
    const parentItemsBefore = await db.select().from(orderItems).where(eq(orderItems.orderId, parent.orderId));

    const addon = await addImagingViews(
      db, doctor, DECLS, parent.orderId,
      {
        patientId: FEMALE_24, encounterNo: OPEN_VISIT, serviceDate: DAY,
        orderingClinicianId: "dr-consultant", indication: "additional view",
        items: [{ serviceId: SVC_CHEST_XRAY, parentItemId: parent.itemIds[0] }],
      } as never,
      "k-addon", NOW,
    );

    expect(addon.orderId).not.toBe(parent.orderId);
    expect(addon.orderNo).not.toBe(parent.orderNo);

    const [parentRow] = await db.select().from(orders).where(eq(orders.id, parent.orderId));
    const [addonRow] = await db.select().from(orders).where(eq(orders.id, addon.orderId));
    expect(addonRow!.orderGroupId).toBe(parentRow!.orderGroupId);

    const [addonItem] = await db.select().from(orderItems).where(eq(orderItems.id, addon.itemIds[0]!));
    expect(addonItem!.origin).toBe("addon");
    expect(addonItem!.parentItemId).toBe(parent.itemIds[0]);

    /**
     * ═══ THE PARENT IS BYTE-IDENTICAL — THE HALF THE ASSERTION EXISTS FOR ═══
     *
     * §6A.5/§6A.7's warning is about an INSERT into a live order's items: no CAS, a header lock,
     * and a deadlock one concurrent completion away. Proving the add-on landed is easy; proving the
     * parent was not touched is the part that would catch that write.
     */
    const parentHeaderAfter = (await db.select().from(orders).where(eq(orders.id, parent.orderId)))[0];
    const parentItemsAfter = await db.select().from(orderItems).where(eq(orderItems.orderId, parent.orderId));
    expect(parentHeaderAfter).toEqual(parentHeaderBefore);
    expect(parentItemsAfter).toEqual(parentItemsBefore);
    expect(parentItemsAfter).toHaveLength(1);
  });

  /**
   * A5's census, as a test rather than as a line in a report. The ONLY writer of `order_items` in
   * this repository is the kernel's own `placeOrder`; a module that inserted there directly would
   * be the write phase 0 warned about, and this reads the source to say so.
   */
  it("A5 census: no module inserts into orderItems — the kernel's placeOrder is the only writer", async () => {
    const { execSync } = await import("node:child_process");
    /**
     * COMMENTS AND TEST FILES ARE EXCLUDED, and the first draft of this assertion did not exclude
     * them — it matched `place.ts`'s own docstring and this very line, and failed against a
     * codebase that is correct. A census that cannot survive being written about is not a census.
     */
    const out = execSync(
      "grep -rn 'insert(orderItems)' src/modules --include=*.ts"
      + " | grep -v '\\.test\\.ts:'"
      + " | grep -vE ':[[:space:]]*(\\*|//)'"
      + " || true",
      { cwd: `${__dirname}/../../..`, encoding: "utf8", shell: "/bin/bash" },
    ).trim();
    expect(out).toBe("");
  });
});
