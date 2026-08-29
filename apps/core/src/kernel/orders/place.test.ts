import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import * as permissionsModule from "../auth/permissions";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { events, orderItems, orders, patients, registrationConfig, services } from "../db/schema";
import { withTx } from "../db/client";
import { registerEncounterResolver, registeredEncounterPrefixes } from "../episodes/encounter-resolvers";
import { OrderError } from "./errors";
import { ORDERS_PLACE, placeOrder } from "./place";
import type { PlaceOrderInput } from "./place";
import type { OrderKindDecl } from "./kinds";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 17 PHASE 0 T3 — `placeOrder`, the DD6 actor rules, and the encounter registry now in the
 * kernel.
 *
 * The kind declarations are passed as a PARAMETER rather than collected from `ALL_MANIFESTS`, which
 * is what `createResource`'s header argues for at length and is also what makes this suite possible:
 * no manifest claims a kind today, so a test that read the real registry could place nothing at all.
 */
const LAB_PLACE = "lab.orders.place";
const IMAGING_PLACE = "radiology.orders.place";

const labDecl: OrderKindDecl = {
  kind: "lab", seriesKey: "lab_order", placePermission: LAB_PLACE,
  requiresClinician: true, requiresIndication: false, selfOrderable: false,
};
const imagingDecl: OrderKindDecl = {
  kind: "imaging", seriesKey: "radiology_order", placePermission: IMAGING_PLACE,
  requiresClinician: false, requiresIndication: true, selfOrderable: false,
};
const packageDecl: OrderKindDecl = {
  kind: "package", seriesKey: "lab_order", placePermission: LAB_PLACE,
  requiresClinician: false, requiresIndication: false, selfOrderable: true,
};
const DECLS = [labDecl, imagingDecl, packageDecl];

describe("placeOrder (Plan 17 phase 0 T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let doctor: Actor;
  let pharmacist: Actor;

  const PATIENT = "01PATIENT0000000000000001";
  const OTHER_PATIENT = "01PATIENT0000000000000002";
  const SERVICE = "01SERVICE0000000000000001";
  const VISIT = "V2608290001";
  const OTHER_VISIT = "V2608290002";
  const DAY = "2026-08-29";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    for (const [id, uhid] of [[PATIENT, "HMS-00000001-5"], [OTHER_PATIENT, "HMS-00000002-3"]] as const) {
      await db.insert(patients).values({
        id, uhid, name: `P ${id.slice(-1)}`, sex: "female", administrativeGender: "female",
        createdBy: "t", updatedBy: "t",
      });
    }
    await db.insert(services).values({
      id: SERVICE, code: "CBC", name: "Complete blood count", category: "investigation",
      createdBy: "t", updatedBy: "t",
    });

    /**
     * A stand-in for `opd.module.ts`'s registration. It resolves `V…` to whichever patient the
     * number names, which is what lets A9's mismatch leg be a REAL disagreement between two rows
     * rather than a resolver that was told to lie.
     */
    unregister = registerEncounterResolver("V", async (_db, encounterNo) =>
      encounterNo === VISIT ? { patientId: PATIENT, intendedPayer: "self" }
        : encounterNo === OTHER_VISIT ? { patientId: OTHER_PATIENT, intendedPayer: "self" }
          : null);

    // The permission catalog: both the kernel permission and the two kinds' own.
    const registry = new ModuleRegistry();
    registry.install({ key: "orders", title: "Orders", menu: [], permissions: [ORDERS_PLACE], subscriptions: [] });
    registry.install({ key: "lab", title: "Lab", menu: [], permissions: [LAB_PLACE], subscriptions: [] });
    registry.install({ key: "rad", title: "Rad", menu: [], permissions: [IMAGING_PLACE], subscriptions: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "doctor");
    await ensureRole(db, "pharmacist");
    await grantPermissionToRole(db, registry, "doctor", ORDERS_PLACE);
    await grantPermissionToRole(db, registry, "doctor", LAB_PLACE);
    await grantPermissionToRole(db, registry, "doctor", IMAGING_PLACE);
    // A5's subject: holds the KERNEL permission and NOT the kind's.
    await grantPermissionToRole(db, registry, "pharmacist", ORDERS_PLACE);
    ({ actor: doctor } = await mkUser(db, "dr.mehra", ["doctor"]));
    ({ actor: pharmacist } = await mkUser(db, "ph.rao", ["pharmacist"]));
  });

  afterEach(() => { unregister(); });

  const input = (over: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
    kind: "lab",
    patientId: PATIENT,
    encounterNo: VISIT,
    serviceDate: DAY,
    orderingClinicianId: "dr-consultant",
    items: [{ serviceId: SERVICE }],
    ...over,
  } as PlaceOrderInput);

  const place = (actor: Actor, over: Partial<PlaceOrderInput> = {}) =>
    withTx(db, (tx) => placeOrder(tx, actor, DECLS, input(over)));

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try { await promise; } catch (error) {
      expect(error).toBeInstanceOf(OrderError);
      return (error as OrderError).code;
    }
    throw new Error("expected placeOrder to refuse, and it did not");
  }

  it("places an order, mints its number from the kind's series, and writes its items", async () => {
    const { orderId, orderNo, itemIds } = await place(doctor);
    expect(orderNo).toBe("L2608290001");
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.kind).toBe("lab");
    expect(row!.status).toBe("open");
    expect(row!.authority).toBe("clinician");
    expect([row!.orderedByType, row!.orderedById]).toEqual(["user", doctor.id]);
    // DD2 — an order that names no group is its own group, so a single-kind act still joins.
    expect(row!.orderGroupId).toBe(orderId);
    expect(itemIds).toHaveLength(1);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect([item!.status, item!.origin, item!.restricted]).toEqual(["placed", "direct", false]);
  });

  it("appends order.placed inside the same transaction, carrying the item ids", async () => {
    const { orderId, itemIds } = await place(doctor);
    const rows = (await db.select().from(events)).filter((e) => e.name === "order.placed");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ orderId, kind: "lab", itemIds });
    expect(rows[0]!.patientId).toBe(PATIENT);
  });

  it("refuses a kind no installed manifest claims (unknown_kind)", async () => {
    expect(await codeOf(place(doctor, { kind: "blood" }))).toBe("unknown_kind");
  });

  it("refuses an order with no items", async () => {
    expect(await codeOf(place(doctor, { items: [] }))).toBe("no_items");
  });

  // ───────────────────────────── the DD6 actor legs, A1–A5 ─────────────────────────────

  it("A1 — an agent actor is refused, always. The LLM narrates and never originates", async () => {
    expect(await codeOf(place({ type: "agent", id: "drafter-1" }))).toBe("agent_cannot_order");
  });

  it("A1 — an agent is refused even on a kind that is selfOrderable and needs no clinician", async () => {
    // The refusal must not depend on the KIND: `agent` is refused before any declaration is read.
    expect(await codeOf(place({ type: "agent", id: "drafter-1" }, { kind: "package" })))
      .toBe("agent_cannot_order");
  });

  /**
   * A2 — a patient actor on a kind that is not `selfOrderable`, and **the spy is the assertion**.
   * `hasPermission` must never be called with a patient credential id: it takes a `users.id`,
   * returns false for anything else, and that false ALIASES with "this user lacks the permission".
   * A refusal that is right for the wrong reason is one refactor away from being wrong.
   */
  it("A2 — a patient is refused on a non-self-orderable kind, and NO permission lookup is made", async () => {
    const spy = jest.spyOn(permissionsModule, "hasPermission");
    try {
      expect(await codeOf(place({ type: "patient", id: "patient-credential-1" })))
        .toBe("self_order_not_permitted");
      /**
       * Asserted on the ARGUMENTS rather than on the spy, and that is not a style choice: a failing
       * `expect(spy).not.toHaveBeenCalled()` makes jest pretty-print the received calls, whose
       * FIRST argument is the whole drizzle transaction — measured at a 4 GB heap exhaustion that
       * kills the runner before it can report. A test whose job is to fail loudly must be able to.
       * The id list is also the sharper claim: what matters is that no lookup was made WITH THE
       * PATIENT'S CREDENTIAL ID.
       */
      expect(spy.mock.calls.map((call) => call[1])).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("A2 — a patient MAY place a selfOrderable kind, and the authority is 'self'", async () => {
    const { orderId } = await withTx(db, (tx) =>
      placeOrder(tx, { type: "patient", id: "patient-credential-1" }, DECLS, input({ kind: "package" })));
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect([row!.authority, row!.orderedByType]).toEqual(["self", "patient"]);
  });

  it("A3 — a system actor with no protocol_ref is refused; with one it places under 'protocol'", async () => {
    expect(await codeOf(place({ type: "system", id: "reflex" }))).toBe("protocol_ref_required");
    const { orderId } = await place({ type: "system", id: "reflex" }, { protocolRef: "reflex-rule-7" });
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect([row!.authority, row!.protocolRef]).toEqual(["protocol", "reflex-rule-7"]);
  });

  it("A4 — requiresClinician with no ordering clinician is refused", async () => {
    expect(await codeOf(place(doctor, { orderingClinicianId: null }))).toBe("clinician_required");
  });

  it("A4b — requiresIndication with no indication is refused (18a's radiation justification)", async () => {
    expect(await codeOf(place(doctor, { kind: "imaging", indication: null })))
      .toBe("indication_required");
  });

  /**
   * A5 — the whole point of TWO permissions. `pharmacist` holds `orders.place` and not
   * `radiology.orders.place`, which is exactly the shape of "a pharmacist places imaging".
   */
  it("A5 — holding orders.place but not the kind's own permission is refused", async () => {
    const code = await codeOf(withTx(db, (tx) =>
      placeOrder(tx, pharmacist, DECLS, input({ kind: "imaging", indication: "SOB" }))));
    expect(code).toBe("permission_denied");
  });

  /**
   * THE ORDER OF THE TWO REFUSALS IS ITSELF AN ASSERTION, and it was measured rather than assumed:
   * the actor/permission leg runs BEFORE the clinician and indication checks, so a caller who may
   * not place at all is told that, not that they forgot a field. Discovered by A4b failing with
   * `permission_denied` when its fixture had not granted the imaging permission.
   */
  it("answers permission_denied, not indication_required, when the caller may not place at all", async () => {
    const code = await codeOf(withTx(db, (tx) =>
      placeOrder(tx, pharmacist, DECLS, input({ kind: "imaging", indication: null }))));
    expect(code).toBe("permission_denied");
  });

  it("A5b — holding the kind's permission but not orders.place is refused too", async () => {
    const registry = new ModuleRegistry();
    registry.install({ key: "lab", title: "Lab", menu: [], permissions: [LAB_PLACE], subscriptions: [] });
    await ensureRole(db, "phlebotomist");
    await grantPermissionToRole(db, registry, "phlebotomist", LAB_PLACE);
    const { actor } = await mkUser(db, "ph.bose", ["phlebotomist"]);
    expect(await codeOf(place(actor))).toBe("permission_denied");
  });

  // ───────────────────────────── A6, A7, A9 — number, race, patient ─────────────────────────────

  it("A6 — the number carries the KIND's letter and the CALLER's service date", async () => {
    const lab = await place(doctor, { serviceDate: "2026-08-29" });
    expect(lab.orderNo).toBe("L2608290001");
    const later = await place(doctor, { serviceDate: "2026-09-01" });
    // A different day is a different counter, and the letter follows the KIND, never the visit.
    expect(later.orderNo).toBe("L2609010001");
  });

  it("A6b — an imaging order is numbered R…, from the same call with a different kind", async () => {
    const { orderNo } = await place(doctor, { kind: "imaging", indication: "chest pain" });
    expect(orderNo).toBe("R2608290001");
  });

  /**
   * A7 — two concurrent placements of one kind on one day. `nextEpisodeNo`'s single-winner
   * `UPDATE … RETURNING` is what makes them distinct; a read-then-write would give both the same
   * number and the second commit would die on `orders_order_no_unique`.
   */
  it("A7 — concurrent placements get DISTINCT numbers", async () => {
    const results = await Promise.all([place(doctor), place(doctor), place(doctor)]);
    const numbers = results.map((r) => r.orderNo).sort();
    expect(new Set(numbers).size).toBe(3);
    expect(numbers).toEqual(["L2608290001", "L2608290002", "L2608290003"]);
  });

  it("A9 — an encounter belonging to a different patient is refused", async () => {
    const code = await codeOf(place(doctor, { encounterNo: OTHER_VISIT }));
    expect(code).toBe("patient_encounter_mismatch");
  });

  it("refuses an encounter number no registered prefix resolves", async () => {
    expect(await codeOf(place(doctor, { encounterNo: "Z2608290001" }))).toBe("unknown_encounter");
  });

  it("refuses an encounter whose OWNING module says there is no such encounter", async () => {
    // The prefix MATCHES and the resolver returns null — there is nothing to fall back to, unlike
    // billing's wrapper, because the module that owns `V` has answered.
    expect(await codeOf(place(doctor, { encounterNo: "V2608299999" }))).toBe("unknown_encounter");
  });

  it("rolls the whole placement back — no order, no items, no event — when a later step throws", async () => {
    // A service that is not in the tariff fails the item FK, AFTER the header and the counter.
    await expect(place(doctor, { items: [{ serviceId: "no-such-service" }] })).rejects.toThrow();
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(await db.select().from(orderItems)).toHaveLength(0);
    expect((await db.select().from(events)).filter((e) => e.name === "order.placed")).toHaveLength(0);
  });

  it("E1/DD2 — two kinds in one act share the group id the surface minted", async () => {
    const groupId = newId();
    const lab = await place(doctor, { orderGroupId: groupId });
    const rad = await place(doctor, { kind: "imaging", indication: "cough", orderGroupId: groupId });
    const rows = await db.select().from(orders);
    expect(rows.map((r) => r.orderGroupId)).toEqual([groupId, groupId]);
    expect([lab.orderNo[0], rad.orderNo[0]]).toEqual(["L", "R"]);
  });

  /**
   * A8 — THE PARITY LEG FOR THE REGISTRY MOVE. `registeredEncounterPrefixes` is the function
   * `billing`'s own test pins, and it must answer identically from the kernel path. The suite
   * registers `V` in its `beforeEach`; `D` arrives only when `ot.module.ts` initialises, which is
   * why this asserts CONTAINMENT rather than an exact list — the exact list is billing's own test's
   * assertion and it still passes from the new path.
   */
  it("A8 — the moved registry answers registeredEncounterPrefixes from the kernel", () => {
    expect(registeredEncounterPrefixes()).toContain("V");
  });
});
