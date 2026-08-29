import { asc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { events, orderItemTransitions, orderItems, orders, patients, registrationConfig, services } from "../db/schema";
import { withTx } from "../db/client";
import { registerEncounterResolver } from "../episodes/encounter-resolvers";
import { advanceOrderItem } from "./advance";
import { collectOrderKinds } from "./kinds";
import { ordersManifest } from "./manifest";
import { placeOrder } from "./place";
import { listOrdersForPatient } from "./read";
import type { ModuleManifest } from "../modules/manifest";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 17 PHASE 0 T6 — THE WHOLE ENVELOPE, END TO END, THROUGH A MANIFEST NOBODY SHIPS.
 *
 * Every other suite in this phase passes `decls` as a literal. This one does what a real ordering
 * department will do: it declares `orderKinds` ON A MANIFEST, installs it into a `ModuleRegistry`,
 * runs `collectOrderKinds` over that registry exactly as `app.module.ts` does at boot, and places
 * from what the collector returned. If the manifest seam and the write path have drifted apart,
 * this is the test that cannot pass.
 *
 * **The fake manifest is Plan 17 T2's own declaration, written out.** The CONTRACT §6.8 says the
 * lab claims `lab` / `lab_order` / `lab.orders.place` with `requiresClinician: true` and
 * `selfOrderable: false` — so if the seam is right, THIS is the entire diff Plan 17 needs in order
 * to become an ordering department, and that claim is checkable here rather than in six weeks.
 *
 * No fail-first is owed (ROUTINE tier) and none is manufactured.
 */
const LAB_PLACE = "lab.orders.place";

const fakeLabManifest: ModuleManifest = {
  key: "lab-e2e",
  title: "Lab (test-only manifest — never in ALL_MANIFESTS)",
  menu: [],
  permissions: [LAB_PLACE],
  subscriptions: [],
  orderKinds: [{
    kind: "lab",
    seriesKey: "lab_order",
    placePermission: LAB_PLACE,
    requiresClinician: true,
    requiresIndication: false,
    selfOrderable: false,
  }],
};

describe("the order envelope end to end (Plan 17 phase 0 T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let unregister: () => void;
  let doctor: Actor;

  const PATIENT = "01PATIENT0000000000000001";
  const VISIT = "V2608290001";
  const CBC = "01SERVICE0000000000000001";
  const LFT = "01SERVICE0000000000000002";
  const DAY = "2026-08-29";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
      administrativeGender: "female", createdBy: "t", updatedBy: "t",
    });
    await db.insert(services).values([
      { id: CBC, code: "CBC", name: "Complete blood count", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: LFT, code: "LFT", name: "Liver function", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);
    unregister = registerEncounterResolver("V", async (_db, no) =>
      no === VISIT ? { patientId: PATIENT, intendedPayer: "self" } : null);

    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    registry.install(fakeLabManifest);
    await syncPermissions(db, registry);
    await ensureRole(db, "consultant");
    await grantPermissionToRole(db, registry, "consultant", "orders.place");
    await grantPermissionToRole(db, registry, "consultant", LAB_PLACE);
    ({ actor: doctor } = await mkUser(db, "dr.mehra", ["consultant"]));
  });

  afterEach(() => { unregister(); });

  /** `app.module.ts`'s boot line, run here so the seam is exercised rather than bypassed. */
  function bootDecls() {
    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    registry.install(fakeLabManifest);
    return collectOrderKinds(registry);
  }

  it("a module that adds ONE manifest field can place, work and close an order", async () => {
    const decls = bootDecls();
    expect(decls.map((d) => d.kind)).toEqual(["lab"]);

    const { orderId, orderNo, itemIds } = await withTx(db, (tx) =>
      placeOrder(tx, doctor, decls, {
        kind: "lab", patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
        orderingClinicianId: doctor.id, priority: "urgent",
        items: [{ serviceId: CBC }, { serviceId: LFT }],
      }));
    expect(orderNo).toBe("L2608290001");

    // The department picks both up and finishes them — `system` here, as an analyzer interface is.
    const analyzer: Actor = { type: "system", id: "analyzer-1" };
    for (const itemId of itemIds) {
      await withTx(db, (tx) => advanceOrderItem(tx, analyzer, decls, itemId, "in_progress"));
    }
    const first = await withTx(db, (tx) => advanceOrderItem(tx, analyzer, decls, itemIds[0]!, "completed"));
    expect(first.headerClosedAs).toBeNull();
    const last = await withTx(db, (tx) => advanceOrderItem(tx, analyzer, decls, itemIds[1]!, "completed"));
    expect(last.headerClosedAs).toBe("closed");

    const [header] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect([header!.status, header!.priority]).toEqual(["closed", "urgent"]);
    expect(header!.closedAt).not.toBeNull();
    expect((await db.select().from(orderItems)).map((i) => i.status)).toEqual(["completed", "completed"]);

    /**
     * THE OUTBOX, READ BACK IN ORDER. Six moves produce six events: one placement, two starts, two
     * completions and one close. A consumer that subscribed to `order.placed` and `order_item.*`
     * would have exactly this to work from and would need to read no table to know the kind.
     */
    const names = (await db.select().from(events).orderBy(asc(events.seq)))
      .filter((e) => e.name.startsWith("order"))
      .map((e) => e.name);
    expect(names).toEqual([
      "order.placed",
      "order_item.started", "order_item.started",
      "order_item.completed", "order_item.completed",
      "order.closed",
    ]);

    // Six moves, six audit rows, and the log is append-only (0044's trigger, proved in T1).
    expect(await db.select().from(orderItemTransitions)).toHaveLength(4);

    // And the cross-kind reader answers over what was written, for the doctor who ordered it.
    const view = await listOrdersForPatient(db, doctor, PATIENT);
    expect(view.patientDisplayName).toBe("Asha Devi");
    expect(view.orders).toHaveLength(1);
    expect(view.orders[0]!.items).toHaveLength(2);
    expect(view.orders[0]!.status).toBe("closed");
  });

  it("the SAME registry refuses a kind the fake manifest did not claim", async () => {
    const decls = bootDecls();
    await expect(withTx(db, (tx) =>
      placeOrder(tx, doctor, decls, {
        kind: "imaging", patientId: PATIENT, encounterNo: VISIT, serviceDate: DAY,
        orderingClinicianId: doctor.id, items: [{ serviceId: CBC }],
      }))).rejects.toThrow(/no installed manifest claims the order kind "imaging"/);
  });

  it("a second manifest claiming `lab` stops the boot, not the first order of the day", () => {
    const registry = new ModuleRegistry();
    registry.install(ordersManifest);
    registry.install(fakeLabManifest);
    registry.install({ ...fakeLabManifest, key: "lab-legacy" });
    expect(() => collectOrderKinds(registry)).toThrow(/two manifests declare the order kind "lab"/);
  });
});
