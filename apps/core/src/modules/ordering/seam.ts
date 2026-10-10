import { and, eq, inArray } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { labOrderables } from "../../kernel/db/schema";
import { OrderError } from "../../kernel/orders/errors";
import { LabError, placeLabOrder } from "../lab";
import { placeImagingOrder, RadiologyError } from "../radiology";
import { routeTests } from "./route";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { DeskOrderResult } from "../lab";
import type { PlaceImagingOrderResult } from "../radiology";
import type { RoutedTests } from "./route";

/**
 * ═══ THE ORDERING SEAM (owner 2026-10-10, decision 0065) ═══
 *
 * *"Build the functionality so that when the screens are built then it will be easy to get started."*
 * One call takes an episode number, the tests and the ordering doctor, and sends each test to the
 * department that does it: lab tests become one lab order (placed and billed in one atom, the desk's
 * own `placeLabOrder`), imaging studies one imaging order, outside tests come back to be printed.
 *
 * Any episode series the kernel can resolve works — `V` (OPD) and `D` (day-care) today; an IPD or
 * Emergency module registers its letter with `registerEncounterResolver` and calls this, and nothing
 * here changes. Who may order is the kernel's rule (`placeOrder`): a doctor holds `orders.place` and
 * each department's place permission; the free-test automatic order is a `system` actor naming its
 * protocol.
 *
 * Each department is its OWN transaction and its own answer. A refused lab order (a consent test, an
 * unacknowledged duplicate) does not take the X-ray down with it: the refusal comes back under
 * `skipped` with the department's own words, for the screen to show and the desk to finish.
 */
export type OrderTestsInput = {
  patientId: string;
  /** The episode NUMBER (`V…`, `D…`, and later the IPD / Emergency series). */
  encounterNo: string;
  /** The IST calendar day of the episode, resolved by the caller. */
  serviceDate: string;
  orderingClinicianId: string;
  serviceIds: readonly string[];
  /** Why — required by imaging (`requiresIndication`); also kept on the lab order's events. */
  indication: string;
  priority?: "routine" | "urgent" | "stat";
  /** A `system` actor's rule. Required for a system actor, ignored for a person. */
  protocolRef?: string;
  /** Limit the departments ordered (the free-test order orders only what is free). Default: both. */
  departments?: { lab: boolean; imaging: boolean };
};

export type SkippedDepartment = { department: "lab" | "imaging"; serviceIds: string[]; code: string; message: string };

export type OrderTestsResult = {
  routed: RoutedTests;
  lab: DeskOrderResult | null;
  imaging: PlaceImagingOrderResult | null;
  skipped: SkippedDepartment[];
};

/** A department's refusal that the desk can finish by hand. Anything else (a bug, the database) is thrown. */
function refusal(e: unknown): { code: string; message: string } | null {
  if (e instanceof LabError || e instanceof RadiologyError || e instanceof OrderError) {
    return { code: (e as { code: string }).code, message: e.message };
  }
  return null;
}

export async function orderTests(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: OrderTestsInput,
  now: Date = new Date(),
): Promise<OrderTestsResult> {
  const routed = await routeTests(db, input.serviceIds);
  const want = input.departments ?? { lab: true, imaging: true };
  const result: OrderTestsResult = { routed, lab: null, imaging: null, skipped: [] };
  const protocol = actor.type === "system" ? { protocolRef: input.protocolRef } : {};

  /**
   * A test that needs the patient's written consent (HIV and the like) is never ordered by the system:
   * consent is taken by a person at the desk. It comes back under `skipped`, and the rest still go.
   */
  let labIds = routed.lab;
  if (actor.type === "system" && labIds.length > 0) {
    const consent = new Set((await db.select({ id: labOrderables.serviceId }).from(labOrderables)
      .where(and(inArray(labOrderables.serviceId, labIds), eq(labOrderables.consentRequired, true)))).map((r) => r.id));
    if (consent.size > 0) {
      result.skipped.push({
        department: "lab", serviceIds: [...consent], code: "consent_required",
        message: "needs the patient's written consent — the lab desk orders it after taking consent",
      });
      labIds = labIds.filter((id) => !consent.has(id));
    }
  }

  if (want.lab && labIds.length > 0) {
    try {
      result.lab = await withTx(db, (tx) => placeLabOrder(tx, actor, decls, {
        patientId: input.patientId, encounterNo: input.encounterNo, serviceDate: input.serviceDate,
        orderingClinicianId: input.orderingClinicianId, priority: input.priority,
        items: labIds.map((serviceId) => ({ serviceId })),
        ...protocol,
      }, now));
    } catch (e) {
      const r = refusal(e);
      if (r === null) throw e;
      result.skipped.push({ department: "lab", serviceIds: labIds, ...r });
    }
  }

  if (want.imaging && routed.imaging.length > 0) {
    try {
      result.imaging = await placeImagingOrder(db, actor, decls, {
        patientId: input.patientId, encounterNo: input.encounterNo, serviceDate: input.serviceDate,
        orderingClinicianId: input.orderingClinicianId, priority: input.priority, indication: input.indication,
        items: routed.imaging.map((serviceId) => ({ serviceId })),
        ...protocol,
      }, undefined, now);
    } catch (e) {
      const r = refusal(e);
      if (r === null) throw e;
      result.skipped.push({ department: "imaging", serviceIds: routed.imaging, ...r });
    }
  }
  return result;
}
