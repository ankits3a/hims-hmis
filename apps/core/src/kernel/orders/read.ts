import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { hasPermission } from "../auth/permissions";
import { orderItems, orders, patients } from "../db/schema";
import { displayName } from "../../modules/patients/display-name";
import { OrderError } from "./errors";
import { ORDERS_PERMISSIONS } from "./manifest";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../db/client";
import type { OrderItemStatus } from "../db/schema/orders";

/**
 * PLAN 17 PHASE 0 T5 — THE CROSS-KIND READERS, WHICH ARE THE WHOLE ARGUMENT FOR A KERNEL ENVELOPE.
 *
 * §1.2: an Indian corporate hospital reads investigations from ONE list — the ward's pending
 * investigations per bed, the TPA desk's bundle, the patient app's "my tests". Every one of those
 * is a cross-kind read, and with module-private tables each becomes a UNION across N modules
 * rewritten every time a kind is added. These three functions are what a module gets INSTEAD of
 * that union, and the CONTRACT says so: *a module never UNIONs another module's tables to answer
 * "what is pending for this patient".*
 *
 * ═══ THIS FILE IS THE ONE PLACE THE KERNEL IMPORTS A MODULE, AND IT IS DELIBERATE ═══
 *
 * `displayName` lives in `modules/patients`. The precedent is `kernel/worker/jobs.ts`, which
 * imports `modules/patients/guardians` by deep path for the same reason: the rule about a
 * confidential patient's name has exactly one owner (`display-name.ts`'s header says so in
 * capitals), and a kernel copy of it would be §2.54 with a VIP's legal name as the fact that
 * drifts. The deep path rather than the module index keeps the import to one file.
 *
 * **The plan document said this reader aliases "exactly as `DeskProviderCtx` does" and that is not
 * what the desk does (finding F5).** `kernel/desk/types.ts` pushes aliasing DOWN to each provider —
 * *"the kernel cannot do it for them: it does not know which field of which row is a name"* — which
 * is right for the desk, whose rows are arbitrary. It is wrong here: these readers are
 * patient-SCOPED, so there is exactly one name per call and the kernel knows precisely which field
 * it is. The alias decision is therefore made here, once, rather than by every future caller.
 */

export type OrderItemView = {
  id: string;
  serviceId: string;
  status: OrderItemStatus;
  origin: string;
  restricted: boolean;
  cancelledFrom: string | null;
  cancelReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
};

export type OrderView = {
  id: string;
  orderNo: string;
  orderGroupId: string;
  kind: string;
  patientId: string;
  encounterNo: string;
  serviceDate: string;
  priority: string;
  authority: string;
  status: string;
  orderingClinicianId: string | null;
  indication: string | null;
  placedAt: Date;
  closedAt: Date | null;
  items: OrderItemView[];
};

export type PatientOrdersView = {
  /**
   * ALIASED FOR A CALLER WITHOUT `patients.confidential.read` (E17). A sealed patient's legal name
   * never leaves this function for such a caller, and the fallback for a confidential row with no
   * alias is a dash, never the name — `display-name.ts`'s rule, applied rather than re-decided.
   */
  patientDisplayName: string;
  orders: OrderView[];
};

/** Everything the readers need to decide what this caller may see. Computed once per call. */
type Clearance = { canSeeRestricted: boolean; canSeeConfidential: boolean; userId: string | null };

/**
 * ═══ NO PERMISSION LOOKUP IS EVER PERFORMED ON A NON-USER ACTOR ═══
 *
 * `hasPermission` takes a `users.id`. Handed a patient credential id it returns false — and false
 * ALIASES: "this patient may not" and "this user does not hold it" become the same answer, so a
 * later change to either path could silently make the wrong one right (22c-A review D11). Every
 * non-user actor is therefore given the FLOOR clearance without asking, which is the same
 * conclusion `displayNameFor` reaches for a `system` actor: a background job has no business
 * rendering a VIP's legal name.
 */
async function clearanceOf(exec: Db | Tx, actor: Actor): Promise<Clearance> {
  if (actor.type !== "user") {
    return { canSeeRestricted: false, canSeeConfidential: false, userId: null };
  }
  const db = exec as Db;
  const [canSeeRestricted, canSeeConfidential] = await Promise.all([
    hasPermission(db, actor.id, ORDERS_PERMISSIONS.readRestricted, "hospital"),
    hasPermission(db, actor.id, "patients.confidential.read", "hospital"),
  ]);
  return { canSeeRestricted, canSeeConfidential, userId: actor.id };
}

/**
 * DD11 — WHO MAY SEE A RESTRICTED ITEM: the ordering clinician, or a holder of
 * `orders.read.restricted`. Nobody else, whatever else they hold.
 *
 * The ordering-clinician leg is not a courtesy. A2's mutant is "require the permission for
 * everyone", and its consequence is the doctor who ordered an HIV test being unable to see it —
 * at which point the clinic routes around the restricted flag and stops using it, which loses the
 * protection for every patient rather than one.
 *
 * ═══ THE OMISSION IS SILENT, AND THAT IS A DECISION (F6) ═══
 *
 * An earlier draft returned `hasHiddenItems: true` so a clinician could tell there was more to ask
 * about. It was removed. **For the tests this flag exists to protect, the EXISTENCE of the test is
 * the sensitive fact** — an HIV order, an exposure-protocol source test, a PCPNDT-class USG — and a
 * boolean saying "this patient has a restricted investigation" discloses precisely that to the one
 * caller DD11 excludes. DD11's word is "omits", and omission means the reader cannot tell.
 *
 * The safety case the flag was meant to serve is already covered elsewhere and better:
 * `findRecentItems` applies NO restricted filter, so a clinician about to order the same test is
 * warned about the prior one whether or not they may read it.
 */
function visibleItems(
  order: { orderingClinicianId: string | null },
  items: OrderItemView[],
  clearance: Clearance,
): OrderItemView[] {
  const isOrderingClinician =
    clearance.userId !== null && order.orderingClinicianId === clearance.userId;
  if (clearance.canSeeRestricted || isOrderingClinician) return items;
  return items.filter((i) => !i.restricted);
}

function toItemView(row: typeof orderItems.$inferSelect): OrderItemView {
  return {
    id: row.id, serviceId: row.serviceId, status: row.status as OrderItemStatus, origin: row.origin,
    restricted: row.restricted, cancelledFrom: row.cancelledFrom, cancelReason: row.cancelReason,
    startedAt: row.startedAt, completedAt: row.completedAt, cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
  };
}

async function assemble(
  exec: Db | Tx,
  headers: (typeof orders.$inferSelect)[],
  clearance: Clearance,
): Promise<OrderView[]> {
  if (headers.length === 0) return [];
  const items = await (exec as Db)
    .select().from(orderItems)
    .where(inArray(orderItems.orderId, headers.map((h) => h.id)))
    .orderBy(orderItems.createdAt);

  /**
   * ═══ THE HEADER IS PART OF THE DISCLOSURE, NOT A WRAPPER AROUND IT (CLOSE REVIEW C2) ═══
   *
   * Filtering the ITEMS and returning the header regardless was the whole of DD11 undone by one
   * level of nesting. An order whose every item is restricted came back as a real header with
   * `items: []` — and that header carries `orderNo`, `placedAt`, `orderingClinicianId`,
   * `encounterNo` and, worst, **`indication`, which is free clinical text**. A ward clerk holding
   * `orders.read` and nothing else could read:
   *
   *     L2608290007 · lab · open · Dr D · "post-exposure prophylaxis, needle-stick,
   *                                        source patient unknown" · items: []
   *
   * That is more than the `hasHiddenItems` boolean F6 removed for being too revealing — it is that
   * boolean plus five fields plus the reason. Two rules close it:
   *
   *   1. **An order with items, none of them visible, is not returned at all.** `placeOrder` refuses
   *      an empty order (`no_items`), so an empty visible list can only mean everything was filtered.
   *   2. **`indication` is withheld whenever ANY item was filtered.** One order is one kind and one
   *      act, so the justification is written for the whole of it — "why was this ordered" about a
   *      partially-restricted order is a statement about the restricted part.
   */
  return headers.flatMap((h) => {
    const mine = items.filter((i) => i.orderId === h.id).map(toItemView);
    const visible = visibleItems(h, mine, clearance);
    if (mine.length > 0 && visible.length === 0) return [];
    const withheld = visible.length !== mine.length;
    return [{
      id: h.id, orderNo: h.orderNo, orderGroupId: h.orderGroupId, kind: h.kind,
      patientId: h.patientId, encounterNo: h.encounterNo, serviceDate: h.serviceDate,
      priority: h.priority, authority: h.authority, status: h.status,
      orderingClinicianId: h.orderingClinicianId,
      indication: withheld ? null : h.indication,
      placedAt: h.placedAt, closedAt: h.closedAt, items: visible,
    }];
  });
}

/**
 * "WHAT HAS BEEN ORDERED FOR THIS PERSON" — the ward's pending list, the patient app's my-tests,
 * the TPA desk's bundle. Newest first, which is the index `orders_patient_placed_idx` exists for.
 */
export async function listOrdersForPatient(
  exec: Db | Tx,
  actor: Actor,
  patientId: string,
  opts: { statuses?: readonly string[]; limit?: number } = {},
): Promise<PatientOrdersView> {
  const clearance = await clearanceOf(exec, actor);
  const db = exec as Db;

  const [patient] = await db
    .select({ name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients)
    .where(eq(patients.id, patientId));

  const where = opts.statuses
    ? and(eq(orders.patientId, patientId), inArray(orders.status, [...opts.statuses]))
    : eq(orders.patientId, patientId);
  const headers = await db
    .select().from(orders).where(where)
    .orderBy(desc(orders.placedAt))
    .limit(opts.limit ?? 200);

  return {
    patientDisplayName: patient ? displayName(patient, clearance.canSeeConfidential) : "—",
    orders: await assemble(exec, headers, clearance),
  };
}

/** "WHAT WAS ORDERED ON THIS VISIT" — by episode number, the shape billing already dispatches on. */
export async function listOrdersForEncounter(
  exec: Db | Tx,
  actor: Actor,
  encounterNo: string,
): Promise<OrderView[]> {
  const clearance = await clearanceOf(exec, actor);
  const headers = await (exec as Db)
    .select().from(orders)
    .where(eq(orders.encounterNo, encounterNo))
    .orderBy(desc(orders.placedAt));
  return assemble(exec, headers, clearance);
}

/**
 * ═══ 02 D11's DUPLICATE WINDOW, AND IT IS CROSS-KIND BY CONSTRUCTION ═══
 *
 * "This troponin was ordered ninety minutes ago"; "two consultants have both asked for the CT". The
 * per-test WINDOW is the claiming module's config — a repeat troponin at three hours is clinically
 * normal and a repeat CT the same day is not — and the QUERY is the kernel's, because the two
 * doctors may be in different departments and neither module can see the other's table.
 *
 * **CANCELLED ITEMS ARE EXCLUDED** (A3), and the direction matters: including them would let a
 * cancelled duplicate block a clinically-required repeat, which is a warning that trains people to
 * click through warnings. A `completed` item DOES count — that is the case the window is for.
 *
 * It returns items rather than a boolean because the caller shows the clinician WHAT it found, and
 * it applies no restricted filter: this is a safety check on the patient's own record made by
 * whoever is about to order, and hiding a prior HIV test from the duplicate check would mean
 * ordering it twice. The caller renders a warning, never the row.
 */
export async function findRecentItems(
  exec: Db | Tx,
  actor: Actor,
  patientId: string,
  serviceId: string,
  windowHours: number,
  now: Date = new Date(),
): Promise<{ itemId: string; orderId: string; orderNo: string; kind: string; status: OrderItemStatus; placedAt: Date }[]> {
  /**
   * ═══ IT TAKES AN ACTOR, AND IT REFUSES ONE (CLOSE REVIEW M5) ═══
   *
   * This function deliberately applies NO restricted filter — that is what makes it safe to warn a
   * clinician about a prior HIV test they may not read, and F6 leans on it. But with no actor
   * parameter it was an unauthenticated oracle: anything holding a `Db` could ask
   * `findRecentItems(db, sealedPatientId, hivServiceId, 720)` and get a positive answer that a
   * specific restricted test exists, then iterate `serviceId` over the tariff to reconstruct the
   * whole restricted history `listOrdersForPatient` exists to hide. Nothing to gate on, nothing to
   * log, and no way for a reviewer of a downstream route to SEE that a clearance had been skipped.
   *
   * So the actor is required and only STAFF and the application's own automated callers may ask.
   * A `patient` actor is refused outright: a duplicate check is clinical decision support made by
   * the person about to order, and there is no version of it a patient app needs. An `agent` is
   * refused for the reason it is refused everywhere else in this envelope.
   */
  if (actor.type !== "user" && actor.type !== "system") {
    throw new OrderError(
      "actor_cannot_advance",
      `a ${actor.type} actor may not run a duplicate-window check — it is clinical decision ` +
        "support for whoever is about to order, and it deliberately sees restricted items",
    );
  }

  /**
   * THE WINDOW IS MEASURED ON `placed_at`, THE CLINICAL INSTANT — never on `created_at` (M9).
   * E13 rules that a paper order backfilled at 14:00 carries `placed_at` = the paper time, so a
   * window measured on the row's insert instant would call a six-hour-old troponin one hour old and
   * warn about it — which is the "trains people to click through warnings" failure this function's
   * own header names, produced by the check itself.
   */
  const since = new Date(now.getTime() - windowHours * 3600_000);
  const rows = await (exec as Db)
    .select({
      itemId: orderItems.id, orderId: orders.id, orderNo: orders.orderNo, kind: orders.kind,
      status: orderItems.status, placedAt: orders.placedAt,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orders.patientId, patientId),
      eq(orderItems.serviceId, serviceId),
      gte(orders.placedAt, since),
      ne(orderItems.status, "cancelled"),
    ))
    .orderBy(desc(orders.placedAt));
  return rows.map((r) => ({ ...r, status: r.status as OrderItemStatus }));
}
