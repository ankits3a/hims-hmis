import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { labOrderables, outsideTests } from "../../kernel/db/schema";
import { activeStudyTypes, RadiologyError } from "../radiology";
import type { Db, Tx } from "../../kernel/db/client";
import type { StudyType } from "../radiology";

/**
 * ═══ WHICH DEPARTMENT DOES A TEST (owner 2026-10-10, decision 0065) ═══
 *
 * One answer for every ordering screen — OPD today, IPD and Emergency when they come. A test is
 * routed by its `serviceId`, never by its name: the lab owns the services its catalogue names
 * (`lab_orderables`), imaging owns the services the active study-type book names, and the outside
 * catalogue (`outside_tests`) owns ECG, echo and the like. Anything else is `unknown` — a tariff
 * line no department claims, which the caller shows rather than drops.
 */
export type TestDepartment = "lab" | "imaging" | "outside" | "in_hospital";

export type RoutedTests = {
  lab: string[];
  imaging: string[];
  /** Done outside the hospital: printed on the slip, never ordered or billed here. */
  outside: string[];
  /** An outside-catalogue test the hospital now does itself, with the department that does it. */
  inHospital: { serviceId: string; department: string }[];
  unknown: string[];
};

/** The active imaging book by service, or an empty one where radiology has no active definition yet. */
export async function imagingBook(exec: Db | Tx): Promise<Map<string, StudyType>> {
  try {
    return new Map((await activeStudyTypes(exec)).map((t) => [t.service_id, t] as const));
  } catch (e) {
    if (e instanceof RadiologyError) return new Map();
    throw e;
  }
}

export async function routeTests(exec: Db | Tx, serviceIds: readonly string[]): Promise<RoutedTests> {
  const ids = [...new Set(serviceIds)];
  const out: RoutedTests = { lab: [], imaging: [], outside: [], inHospital: [], unknown: [] };
  if (ids.length === 0) return out;
  const lab = new Set((await (exec as Db).select({ id: labOrderables.serviceId }).from(labOrderables)
    .where(and(inArray(labOrderables.serviceId, ids), eq(labOrderables.active, true)))).map((r) => r.id));
  const book = await imagingBook(exec);
  const outside = new Map((await (exec as Db).select().from(outsideTests)
    .where(and(inArray(outsideTests.serviceId, ids), eq(outsideTests.active, true)))).map((r) => [r.serviceId, r] as const));
  for (const id of ids) {
    if (lab.has(id)) out.lab.push(id);
    else if (book.has(id)) out.imaging.push(id);
    else if (outside.get(id)?.site === "outside") out.outside.push(id);
    else if (outside.get(id)?.site === "in_hospital") out.inHospital.push({ serviceId: id, department: outside.get(id)!.department! });
    else out.unknown.push(id);
  }
  return out;
}

export type OrderableTest = { serviceId: string; code: string; name: string; department: TestDepartment; departmentName: string | null };

/**
 * THE TEST PICKER'S LIST — every active test any department claims, searched by code or name, each
 * tagged with its department. For the IPD and Emergency screens; the OPD consult keeps its price-list
 * search (owner 2026-10-10: it need not say which department does a test).
 */
export async function searchOrderableTests(exec: Db | Tx, q: string, limit = 30): Promise<OrderableTest[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  const lower = term.toLowerCase();
  const lab = (await (exec as Db).select({ serviceId: labOrderables.serviceId, code: labOrderables.code, name: labOrderables.nameEn })
    .from(labOrderables)
    .where(and(eq(labOrderables.active, true), or(ilike(labOrderables.code, like), ilike(labOrderables.nameEn, like))))
    .limit(limit)).map((r) => ({ ...r, department: "lab" as const, departmentName: null }));
  const imaging = [...(await imagingBook(exec)).values()]
    .filter((t) => t.code.toLowerCase().includes(lower) || t.name.toLowerCase().includes(lower))
    .slice(0, limit)
    .map((t) => ({ serviceId: t.service_id, code: t.code, name: t.name, department: "imaging" as const, departmentName: null }));
  const outside = (await (exec as Db).select().from(outsideTests)
    .where(and(eq(outsideTests.active, true), or(ilike(outsideTests.code, like), ilike(outsideTests.nameEn, like))))
    .limit(limit)).map((r) => ({
    serviceId: r.serviceId, code: r.code, name: r.nameEn,
    department: r.site === "outside" ? ("outside" as const) : ("in_hospital" as const), departmentName: r.department,
  }));
  return [...lab, ...imaging, ...outside]
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
