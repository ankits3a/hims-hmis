import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { getPatientSummaries } from "../patients";
import { listPriceList } from "../tariff";
import {
  imagingStudies, labOrderables, opdDepartments, opdDoctors, opdEncounters, orderItems, orders,
  patients, services,
} from "../../kernel/db/schema";
import { RadiologyError } from "./errors";
import { activeStudyTypes } from "./study-types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { AdvisedTest } from "../opd";
import type { StudyType } from "./definitions";

/**
 * PLAN 18-S RS2 (absorbs 18a-iv T1) — **THE ORDERING DOOR'S ONE READ: a visit, its advised imaging
 * lines, the book they are drawn from, and what already stands on the visit.**
 *
 * The doctor's half has worked since Plan 07d: an imaging service advised in the consult lands in
 * `opd_encounters.advised_tests` and prints on the prescription. Until this file nothing read it for
 * radiology — `lab/desk.ts`'s `advisedLinesFor` was the rail's only consumer (18a-iv §2).
 *
 * ═══ COPIED FROM THE LAB'S READER, AND WHICH DECISIONS WERE NOT (18a-iv spike 1) ═══
 *
 * The SHAPE is the lab's — advised lines joined to a catalogue, `alreadyOrderedItemId` from the
 * visit's own orders of this kind, cancelled items not counting. Lifting it into a shared reader
 * with the catalogue and the kind as parameters was considered and refused: the two readers differ
 * in the one decision that matters, **which lines appear at all**.
 *
 *   · The lab shows EVERY advised line and greys the ones it does not run. That is right for the
 *     lab desk, which is where an unperformable test is first noticed.
 *   · Radiology must NOT show a lab line (18a-iv T1's negative): a CBC greyed at the imaging desk
 *     tells the receptionist that imaging dropped something it was never asked for. So a line
 *     appears here when the ACTIVE study-type book names it (orderable), or when it is an
 *     `investigation` the lab catalogue does not claim — which is D6's case, an imaging service the
 *     doctor advised off the whole price list that this department cannot perform, shown greyed with
 *     the reason rather than hidden. Consultations, procedures and lab tests never appear.
 *
 * ═══ THE 30-DAY LOOK-BACK IS ADVICE; THE 24-HOUR BAR IS STILL `place.ts`'s ═══
 *
 * `recent` lists this patient's imaging items for the same service in the last 30 days (the board's
 * "30-day duplicate"), so the seat can ask for a reason BEFORE sending. It carries NO restricted item:
 * a PCPNDT-restricted obstetric scan is not a line a reader of this route may see by service name. The
 * restricted case is still caught — `placeImagingOrder`'s 24-hour guard reads through
 * `findRecentItems`, which deliberately sees restricted items, and its refusal carries the item ids
 * the seat needs to send the override pair.
 */

/** The board's duplicate window — advice at the seat. The refusal window is `DUPLICATE_WINDOW_HOURS`. */
export const ADVISORY_DUPLICATE_DAYS = 30;

export type ImagingOrderable = {
  studyTypeCode: string;
  studyTypeName: string;
  modality: string;
  lateralityApplicable: boolean;
  contrast: StudyType["contrast_option"];
  ionising: boolean;
  pcpndtApplicable: boolean;
};

export type ImagingRecentItem = { itemId: string; orderNo: string; encounterNo: string; placedAt: string };

export type AdvisedImagingLine = {
  serviceId: string;
  code: string;
  name: string;
  pricePaise: number;
  /** Null when the active book does not name this service (D6): the seat greys it with `reason`. */
  orderable: ImagingOrderable | null;
  reason: string | null;
  /** An imaging item ALREADY placed for this service on this visit (D3) — shown, never re-ordered. */
  alreadyOrderedItemId: string | null;
  alreadyOrderedOrderNo: string | null;
};

export type ImagingBookEntry = ImagingOrderable & {
  serviceId: string;
  /** The active tariff's list price, or null when the tariff does not price this service. */
  pricePaise: number | null;
};

export type ImagingVisitOrder = {
  orderId: string;
  orderNo: string;
  priority: string;
  status: string;
  authority: string;
  indication: string | null;
  placedAt: string;
  items: {
    itemId: string;
    serviceId: string;
    serviceName: string;
    status: string;
    study: { studyId: string; accessionNo: string; status: string; scheduledAt: string | null } | null;
  }[];
};

export type ImagingDoorView = {
  visit: {
    encounterId: string;
    encounterNo: string;
    serviceDate: string;
    status: string;
    doctorName: string | null;
    /** The `users.id` behind the visit's doctor — what `orderingClinicianId` wants. */
    doctorUserId: string | null;
    departmentName: string | null;
    patient: {
      id: string; uhid: string;
      /** Through the alias rule — a sealed patient's legal name never leaves this reader. */
      display: string;
      administrativeGender: string; dob: string | null; restricted: boolean;
    };
  };
  /** False when no study-type book is published: nothing is orderable, and every line says why. */
  bookActive: boolean;
  lines: AdvisedImagingLine[];
  book: ImagingBookEntry[];
  /** Per service id: this patient's non-restricted imaging items in the last 30 days. */
  recent: Record<string, ImagingRecentItem[]>;
  orders: ImagingVisitOrder[];
};

const NO_BOOK_REASON = "No study-type book is published — radiology cannot take any order until one is.";
const NOT_IN_BOOK_REASON = "Not in the imaging study-type book — radiology does not perform this. Call the doctor.";

function orderableOf(t: StudyType): ImagingOrderable {
  return {
    studyTypeCode: t.code, studyTypeName: t.name, modality: t.modality,
    lateralityApplicable: t.laterality_applicable, contrast: t.contrast_option,
    ionising: t.ionising, pcpndtApplicable: t.pcpndt_applicable,
  };
}

async function activeBookOrNull(db: Db): Promise<StudyType[] | null> {
  try {
    return await activeStudyTypes(db);
  } catch (e) {
    if (e instanceof RadiologyError && e.code === "definition_not_active") return null;
    throw e;
  }
}

/**
 * The advised lines only, against a book already in hand. Exported for the test that pins the
 * inclusion rule without a visit around it.
 */
export async function advisedImagingLines(
  db: Db,
  encounterNo: string,
  advised: readonly AdvisedTest[],
  book: StudyType[] | null,
): Promise<AdvisedImagingLine[]> {
  if (advised.length === 0) return [];
  const serviceIds = [...new Set(advised.map((a) => a.serviceId))];
  const byService = new Map((book ?? []).map((t) => [t.service_id, t]));

  /** Lines the book does not name: an investigation the lab does not claim is D6's greyed line. */
  const unbooked = serviceIds.filter((id) => !byService.has(id));
  const labClaimed = new Set<string>();
  const investigation = new Set<string>();
  if (unbooked.length > 0) {
    for (const r of await db.select({ serviceId: labOrderables.serviceId }).from(labOrderables)
      .where(inArray(labOrderables.serviceId, unbooked))) labClaimed.add(r.serviceId);
    for (const r of await db.select({ id: services.id }).from(services)
      .where(and(inArray(services.id, unbooked), eq(services.category, "investigation")))) investigation.add(r.id);
  }

  const placed = await db
    .select({ id: orderItems.id, serviceId: orderItems.serviceId, status: orderItems.status, orderNo: orders.orderNo })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.encounterNo, encounterNo), eq(orders.kind, "imaging"), inArray(orderItems.serviceId, serviceIds)));
  const placedFor = new Map<string, { id: string; orderNo: string }>();
  for (const p of placed) {
    if (p.status !== "cancelled" && !placedFor.has(p.serviceId)) placedFor.set(p.serviceId, { id: p.id, orderNo: p.orderNo });
  }

  const lines: AdvisedImagingLine[] = [];
  for (const a of advised) {
    const t = byService.get(a.serviceId);
    if (!t && (labClaimed.has(a.serviceId) || !investigation.has(a.serviceId))) continue;
    const already = placedFor.get(a.serviceId) ?? null;
    lines.push({
      serviceId: a.serviceId, code: a.code, name: a.name, pricePaise: a.pricePaise,
      orderable: t ? orderableOf(t) : null,
      reason: t ? null : book === null ? NO_BOOK_REASON : NOT_IN_BOOK_REASON,
      alreadyOrderedItemId: already?.id ?? null,
      alreadyOrderedOrderNo: already?.orderNo ?? null,
    });
  }
  return lines;
}

export async function imagingDoorFor(
  db: Db,
  actor: Actor,
  encounterNo: string,
  now: Date = new Date(),
): Promise<ImagingDoorView> {
  const [encounter] = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, encounterNo.trim().toUpperCase()));
  if (!encounter) {
    throw new RadiologyError("unknown_study", `no visit ${encounterNo} — check the number on the slip`, { encounterNo });
  }
  const [summary] = await getPatientSummaries(db, actor, [encounter.patientId]);
  if (!summary) {
    throw new RadiologyError("unknown_patient", `visit ${encounterNo} names a patient this reader may not see`, { encounterNo });
  }
  const [sealedRow] = await db.select({ sealed: patients.isConfidential }).from(patients).where(eq(patients.id, summary.id));
  const [doctor] = encounter.doctorId === null ? [undefined]
    : await db.select({ displayName: opdDoctors.displayName, userId: opdDoctors.userId }).from(opdDoctors).where(eq(opdDoctors.id, encounter.doctorId));
  const [dept] = encounter.departmentId === null ? [undefined]
    : await db.select({ name: opdDepartments.name }).from(opdDepartments).where(eq(opdDepartments.id, encounter.departmentId));

  const bookTypes = await activeBookOrNull(db);
  const lines = await advisedImagingLines(db, encounter.visitNo, (encounter.advisedTests ?? []) as AdvisedTest[], bookTypes);

  const prices = new Map((await listPriceList(db, now)).map((p) => [p.serviceId, p.pricePaise]));
  const book: ImagingBookEntry[] = (bookTypes ?? [])
    .map((t) => ({ ...orderableOf(t), serviceId: t.service_id, pricePaise: prices.get(t.service_id) ?? null }))
    .sort((a, b) => a.studyTypeName.localeCompare(b.studyTypeName));

  const since = new Date(now.getTime() - ADVISORY_DUPLICATE_DAYS * 86_400_000);
  const recentRows = await db
    .select({
      itemId: orderItems.id, serviceId: orderItems.serviceId, orderNo: orders.orderNo,
      encounterNo: orders.encounterNo, placedAt: orders.placedAt,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orders.patientId, encounter.patientId), eq(orders.kind, "imaging"), gte(orders.placedAt, since),
      ne(orderItems.status, "cancelled"), eq(orderItems.restricted, false),
    ))
    .orderBy(desc(orders.placedAt));
  const recent: Record<string, ImagingRecentItem[]> = {};
  for (const r of recentRows) {
    (recent[r.serviceId] ??= []).push({
      itemId: r.itemId, orderNo: r.orderNo, encounterNo: r.encounterNo, placedAt: r.placedAt.toISOString(),
    });
  }

  const visitRows = await db
    .select({
      orderId: orders.id, orderNo: orders.orderNo, priority: orders.priority, status: orders.status,
      authority: orders.authority, indication: orders.indication, placedAt: orders.placedAt,
      itemId: orderItems.id, serviceId: orderItems.serviceId, serviceName: services.name, itemStatus: orderItems.status,
      studyId: imagingStudies.id, accessionNo: imagingStudies.accessionNo, studyStatus: imagingStudies.status,
      scheduledAt: imagingStudies.scheduledAt,
    })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .innerJoin(services, eq(services.id, orderItems.serviceId))
    .leftJoin(imagingStudies, eq(imagingStudies.orderItemId, orderItems.id))
    .where(and(eq(orders.encounterNo, encounter.visitNo), eq(orders.kind, "imaging")))
    .orderBy(orders.placedAt, orders.orderNo);
  const byOrder = new Map<string, ImagingVisitOrder>();
  for (const r of visitRows) {
    let o = byOrder.get(r.orderId);
    if (!o) {
      o = {
        orderId: r.orderId, orderNo: r.orderNo, priority: r.priority, status: r.status, authority: r.authority,
        indication: r.indication, placedAt: r.placedAt.toISOString(), items: [],
      };
      byOrder.set(r.orderId, o);
    }
    o.items.push({
      itemId: r.itemId, serviceId: r.serviceId, serviceName: r.serviceName, status: r.itemStatus,
      study: r.studyId === null || r.accessionNo === null || r.studyStatus === null ? null
        : { studyId: r.studyId, accessionNo: r.accessionNo, status: r.studyStatus, scheduledAt: r.scheduledAt?.toISOString() ?? null },
    });
  }

  /**
   * The advised lines and the visit's orders are clinical content read off the visit, so the read
   * is logged the way `getVisit` and the lab desk log theirs (`opd.visit`), once per visit returned.
   * The seat asks on Enter and after a placement, never per keystroke.
   */
  await recordPhiAccess(db, {
    actor, patientId: summary.id, surface: "opd.visit", encounterId: encounter.id,
    sealed: sealedRow?.sealed ?? false, reason: null, now,
  });

  return {
    visit: {
      encounterId: encounter.id, encounterNo: encounter.visitNo, serviceDate: encounter.serviceDate,
      status: encounter.status, doctorName: doctor?.displayName ?? null, doctorUserId: doctor?.userId ?? null,
      departmentName: dept?.name ?? null,
      patient: {
        id: summary.id, uhid: summary.uhid,
        display: summary.restricted ? (summary.alias ?? "—") : (summary.name ?? "—"),
        administrativeGender: summary.administrativeGender,
        dob: summary.dob ? summary.dob.toISOString().slice(0, 10) : null,
        restricted: summary.restricted,
      },
    },
    bookActive: bookTypes !== null,
    lines,
    book,
    recent,
    orders: [...byOrder.values()],
  };
}
