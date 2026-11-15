import { and, asc, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { imagingStudies } from "../../kernel/db/schema/radiology";
import { invoiceLines, invoices } from "../../kernel/db/schema/billing";
import { services } from "../../kernel/db/schema/tariff";
import { opdDepartments, opdDoctors } from "../../kernel/db/schema/opd";
import { withTx } from "../../kernel/db/client";
import { hasPermission } from "../../kernel/auth/permissions";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { WorkflowError } from "../../kernel/workflow/instances";
import { istDayString } from "../../kernel/approvals/cumulative";
import { BillingError, issueInvoice, previewInvoice, withIdempotency } from "../billing";
import { IMAGING_VISIT_TYPE, RAD_DEPARTMENT_CODE, listVisits, openImagingWalkinInTx } from "../opd";
import { listMergedLoserIds, resolvePatientId } from "../patients";
import { imagingBookWithPrices } from "./advised";
import { checkIn } from "./checkin";
import { CD_SERVICE_CODE, FILM_SERVICE_CODE } from "./counter";
import { RadiologyError } from "./errors";
import { authorisationOf, encounterPayer, imagingFreeAt, linkInvoiceLine } from "./money";
import { istDayWindow } from "./mwl";
import { autoSlotWalkIn, proposeFreeSlot } from "./schedule";
import { requireStudyType } from "./study-types";
import { placeImagingOrder } from "./place";
import type { ImagingBookEntry } from "./advised";
import type { ExternalReferrerInput, PlaceImagingOrderResult } from "./place";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { SlotProposal } from "./schedule";
import type { DerivedGateSet } from "./checkin";
import type { ImagingGateKind } from "../../kernel/db/schema/radiology";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * #1078 (IM2) — **THE IMAGING DESK'S ACTS, ON THE SERVER.** Spec docs/specs/1078-imaging-desk-counter.md.
 *
 * The counter used to drive three sequences from the browser: a check-in per study in a loop when a
 * patient was opened, a walk-in followed by a separate check-in, and — the one that cost money — issue
 * the invoice, fetch its lines, link each line to its study, with a "relink" button left behind when the
 * link failed after the money had landed. Each is one act here, and each checks its own permissions,
 * so a copilot or a second screen calling it meets the same rule as the desk.
 *
 *   · `arriveAtDesk` — opening a patient on the day IS the arrival: every study of the visit booked for
 *     today (IST) is checked in, each in its own transaction, so one refusal is reported and does not
 *     stop the others.
 *   · `collectAtDesk` — the house invoice through billing's own `issueInvoice`, then the links.
 *   · `walkInNow` — the first free machine and the check-in, in ONE transaction.
 *   · `proposeSlot` — the first free quarter hour (`schedule.ts`'s `proposeFreeSlot`); it books nothing.
 *   · `deskVisitsToday` — the desk door's second read, after the patient search: this patient's visits
 *     of today, so the clerk can open the visit without the slip in hand.
 *   · #1079 (IM2b) `placeWalkInOrder` — a patient with NO visit today and an outside doctor's slip: the
 *     imaging walk-in visit (OPD's `openImagingWalkinInTx`, under the radiologist of record) and the order
 *     on it, under `external_prescription`, in ONE transaction. `deskWalkInView` is its door's read.
 *
 * ═══ COLLECT IS RETRY-SAFE, NOT ONE TRANSACTION (spec, DECIDED) ═══
 *
 * `issueInvoice` opens and commits its own transaction and billing's signatures do not change. So the
 * issue runs under billing's `withIdempotency` with the desk's key, and the links follow in a
 * transaction of their own. A failure between the two leaves the invoice issued and the studies
 * unlinked; the same call with the same key REPLAYS the issue (nothing new is charged) and completes the
 * links. `linkInvoiceLine`'s three checks — the line is this patient's, for this study's service, and
 * pays for no other study — run on every link, retry or not.
 *
 * ═══ AN EARLIER BILL ALREADY CHARGES THE STUDY (the old "relink" path, moved here) ═══
 *
 * A patient who paid at the main billing counter arrives with the money taken and the study unlinked.
 * Billing refuses a second charge (`duplicate_invoice_refused`, FD-27) and names the standing invoice.
 * When that invoice carries a line for EVERY study asked about, and no film or CD was asked for, the
 * desk links those lines instead and takes nothing (`adopted: true`). Anything short of that is
 * billing's refusal, unchanged: the clerk is sent to billing rather than half-linked.
 *
 * No discount and no credit at this counter (decision 0015): the tender must cover the bill exactly,
 * and the amount the screen showed is checked against billing's own price before anything is issued.
 */

const SCHEDULE = "radiology.schedule";
const ORDERS_PLACE = "radiology.orders.place";
const CHECKIN = "radiology.checkin";
const BILL_DECISIONS = "radiology.bill_decisions.manage";
const INVOICE_ISSUE = "billing.invoice.issue";
const RECEIPT_RECORD = "billing.receipt.record";

/** The idempotency scope's route: a constant, so no other route's key can replay this one. */
export const DESK_COLLECT_ROUTE = "POST /radiology/desk/collect";
/** #1079 — the walk-in's scope: a retried click replays the visit and the order rather than placing twice. */
export const DESK_WALK_IN_ROUTE = "POST /radiology/desk/walk-in-order";

/** The states a study can be paid for at the desk: not yet on the machine, and not closed. */
const COLLECTABLE_STATUSES = ["scheduled", "checked_in", "ready"];

async function requirePermissions(db: Db, actor: Actor, required: readonly string[]): Promise<void> {
  for (const permission of required) {
    if (actor.type !== "user" || !(await hasPermission(db, actor.id, permission, "hospital"))) {
      throw new RadiologyError("forbidden", `this desk act needs ${permission}`, { permission });
    }
  }
}

/** A study's own refusal (the checker's or the workflow's), as the desk shows it. Anything else is a fault. */
function refusalOf(e: unknown): { code: string; message: string } | null {
  if (e instanceof RadiologyError || e instanceof WorkflowError) return { code: e.code, message: e.message };
  return null;
}

/* ═══════════════════════════════ arrival ═══════════════════════════════ */

export type DeskArrival = {
  encounterNo: string;
  checkedIn: {
    studyId: string; accessionNo: string; gates: ImagingGateKind[];
    pregnancyReason: DerivedGateSet["pregnancyReason"];
  }[];
  refused: { studyId: string; accessionNo: string; code: string; message: string }[];
};

export async function arriveAtDesk(
  db: Db, actor: Actor, input: { encounterNo: string; now?: Date },
): Promise<DeskArrival> {
  const now = input.now ?? new Date();
  await requirePermissions(db, actor, [CHECKIN]);
  const { start, end } = istDayWindow(istDayString(now));
  const today = await db
    .select({ id: imagingStudies.id, accessionNo: imagingStudies.accessionNo })
    .from(imagingStudies)
    .where(and(
      eq(imagingStudies.encounterNo, input.encounterNo),
      eq(imagingStudies.status, "scheduled"),
      gte(imagingStudies.scheduledAt, start),
      lt(imagingStudies.scheduledAt, end),
    ))
    .orderBy(asc(imagingStudies.scheduledAt), asc(imagingStudies.accessionNo));

  const arrival: DeskArrival = { encounterNo: input.encounterNo, checkedIn: [], refused: [] };
  for (const study of today) {
    try {
      const done = await withTx(db, (tx) => checkIn(tx, actor, { studyId: study.id, now }));
      arrival.checkedIn.push({
        studyId: study.id, accessionNo: study.accessionNo, gates: done.gates, pregnancyReason: done.pregnancyReason,
      });
    } catch (e) {
      const refusal = refusalOf(e);
      if (refusal === null) throw e;
      arrival.refused.push({ studyId: study.id, accessionNo: study.accessionNo, ...refusal });
    }
  }
  return arrival;
}

/* ═══════════════════════════════ walk-in ═══════════════════════════════ */

export type DeskWalkIn = {
  studyId: string; accessionNo: string; deviceResourceId: string; scheduledAt: Date;
  gates: ImagingGateKind[]; pregnancyReason: DerivedGateSet["pregnancyReason"];
};

/** Booked now on the first free machine AND checked in — the patient is standing at the counter. */
export async function walkInNow(
  db: Db, actor: Actor, input: { studyId: string; now?: Date },
): Promise<DeskWalkIn> {
  const now = input.now ?? new Date();
  await requirePermissions(db, actor, [SCHEDULE, CHECKIN]);
  return await withTx(db, async (tx) => {
    const booked = await autoSlotWalkIn(tx, actor, { studyId: input.studyId, now });
    const arrived = await checkIn(tx, actor, { studyId: input.studyId, now });
    return {
      studyId: booked.studyId, accessionNo: booked.accessionNo, deviceResourceId: booked.deviceResourceId,
      scheduledAt: booked.scheduledAt, gates: arrived.gates, pregnancyReason: arrived.pregnancyReason,
    };
  });
}

/* ═══════════════════════════════ the slot ═══════════════════════════════ */

/** The Slot step's prefill. A proposal books nothing; Enter books it through `scheduleStudy`. */
export async function proposeSlot(
  db: Db, actor: Actor, input: { studyId: string; now?: Date },
): Promise<SlotProposal | null> {
  await requirePermissions(db, actor, [SCHEDULE]);
  return await proposeFreeSlot(db, { studyId: input.studyId, from: input.now ?? new Date() });
}

/* ═══════════════════════════════ the door ═══════════════════════════════ */

export type DeskVisit = { encounterNo: string; serviceDate: string; status: string; visitType: string; openedAt: Date };

/**
 * The patient's visits of today (IST) the desk can order on, oldest first — the door then reads each
 * visit's advised imaging. OPD visits, and (#1079) the patient's imaging walk-in, which `listVisits`
 * leaves out by default because it is not an OPD consultation; never a lab or pharmacy visit.
 */
export async function deskVisitsToday(
  db: Db, actor: Actor, input: { patientId: string; now?: Date },
): Promise<DeskVisit[]> {
  const now = input.now ?? new Date();
  await requirePermissions(db, actor, [SCHEDULE]);
  const rows = (await listVisits(db, { patientId: input.patientId, serviceDate: istDayString(now), type: "any" }, 20))
    .filter((r) => r.type === "opd" || r.type === IMAGING_VISIT_TYPE);
  if (rows.length > 0) {
    await recordPhiAccess(db, {
      actor, patientId: input.patientId, surface: "imaging.worklist", reason: "imaging desk: today's visits", now,
    });
  }
  return rows.map((r) => ({
    encounterNo: r.visitNo, serviceDate: r.serviceDate, status: r.status, visitType: r.visitType, openedAt: r.openedAt,
  }));
}

/* ═══════════════════════════ the outside referral (#1079) ═══════════════════════════ */

/**
 * #1079 (IM2b) — **A PATIENT WITH NO VISIT TODAY AND AN OUTSIDE DOCTOR'S SLIP.** Spec
 * docs/specs/1079-imaging-walk-in-visit.md.
 *
 * An imaging order hangs off a `V…` or `D…` encounter (`place.ts`) and names a doctor here who stays
 * answerable (the kernel requires one on every imaging order). So, as the lab walk-in does
 * (`lab/desk.ts` `deskWalkinOrder`), the desk opens the visit through the module that owns visits —
 * OPD's `openImagingWalkinInTx`: a `V` visit of type `imaging` in `RAD`, under the radiologist of
 * record, joining no OPD queue and on no OPD list — and places the order on it, in ONE transaction: a
 * refused order (no referrer, an unknown study, a duplicate inside 24 hours) leaves no visit behind.
 *
 *   · **The radiologist of record is the ordering clinician**: the visit's doctor, as the desk door's
 *     visit leg uses the visit's doctor. The referral itself is the outside doctor's, typed off the slip
 *     — name AND registration number, both required (`place.ts` `resolveExternalReferrer`: the
 *     registration is the radiation justification an AERB inspector reads and, for an ultrasound, the
 *     PCPNDT referral). Imaging on the patient's own request stays refused (`selfOrderable: false`).
 *   · **A second slip the same day rides the same visit** (D2) — `visitOpened: false` says so.
 *   · **No consult fee, ever** (decision 0003 ruling 2). Nothing here bills; the desk's collect charges
 *     the studies (and film / CD) and nothing else.
 *
 * The order goes through `placeImagingOrder` itself, on this transaction (`followups.ts`'s idiom), so
 * every guard placement has — the encounter-status guard, PCPNDT applicability from the published
 * book, the 24-hour duplicate window — is the one the visit leg meets, not a copy of it.
 */
export type DeskWalkInOrderInput = {
  patientId: string;
  /** The radiologist of record, when the department has more than one active. Ignored when the visit is reused. */
  doctorId?: string;
  priority?: "routine" | "urgent" | "stat";
  indication: string;
  items: { serviceId: string; duplicateOfItemId?: string | null; duplicateReason?: string | null }[];
  /** Off the slip. Refused `referrer_required` when either is missing or blank. */
  referrer: ExternalReferrerInput;
};

export type DeskWalkInOrderResult = PlaceImagingOrderResult & {
  /** The visit the order hangs off: opened now, or the patient's open imaging walk-in of today. */
  encounterNo: string;
  visitOpened: boolean;
};

export async function placeWalkInOrder(
  db: Db,
  actor: Actor,
  decls: readonly OrderKindDecl[],
  input: DeskWalkInOrderInput,
  idemKey?: string,
  now: Date = new Date(),
): Promise<DeskWalkInOrderResult> {
  await requirePermissions(db, actor, [ORDERS_PLACE, SCHEDULE]);
  return await withIdempotency(db, { actorId: actor.id, route: DESK_WALK_IN_ROUTE, key: idemKey }, input, async () =>
    await withTx(db, async (tx): Promise<DeskWalkInOrderResult> => {
      const canonical = await resolvePatientId(tx, input.patientId);
      if (!canonical) {
        throw new RadiologyError("unknown_patient", `no patient ${input.patientId} — a walk-in is registered first`, { patientId: input.patientId });
      }
      const chainIds = [canonical, ...(await listMergedLoserIds(tx, canonical))];
      const referrerName = (input.referrer as ExternalReferrerInput | undefined)?.name?.trim() ?? "";
      const { encounter, opened } = await openImagingWalkinInTx(tx, actor, {
        patientId: canonical, chainIds, doctorId: input.doctorId,
        referrerName: referrerName === "" ? undefined : referrerName,
      }, now);
      const [doctor] = encounter.doctorId === null ? [undefined]
        : await tx.select({ userId: opdDoctors.userId }).from(opdDoctors).where(eq(opdDoctors.id, encounter.doctorId));
      const placed = await placeImagingOrder(tx as unknown as Db, actor, decls, {
        patientId: canonical,
        encounterNo: encounter.visitNo,
        serviceDate: istDayString(now),
        orderingClinicianId: doctor?.userId ?? null,
        priority: input.priority ?? "routine",
        indication: input.indication,
        /** F28 — the order's stamp reads the same clock as the duplicate window. */
        placedAt: now,
        items: input.items.map((i) => ({
          serviceId: i.serviceId, duplicateOfItemId: i.duplicateOfItemId ?? null, duplicateReason: i.duplicateReason ?? null,
        })),
        authority: "external_prescription",
        referrer: input.referrer,
      }, undefined, now);
      return { ...placed, encounterNo: encounter.visitNo, visitOpened: opened };
    }), now);
}

export type DeskWalkInView = {
  /** False when no study-type book is published: nothing can be ordered. */
  bookActive: boolean;
  book: ImagingBookEntry[];
  /**
   * The RAD department's active doctors — the radiologist of record is the sole one, or the one the desk
   * names when there are several (`openImagingWalkinInTx` refuses to choose). Empty when the department
   * or its radiologist is not set up yet (the go-live runbook's stand-up step).
   */
  radiologists: { doctorId: string; displayName: string; userId: string }[];
};

/** The walk-in door's read: the book with prices (the visit door's own, `imagingBookWithPrices`) and who can answer. */
export async function deskWalkInView(
  db: Db, actor: Actor, input: { now?: Date } = {},
): Promise<DeskWalkInView> {
  await requirePermissions(db, actor, [ORDERS_PLACE, SCHEDULE]);
  const { types, book } = await imagingBookWithPrices(db, input.now ?? new Date());
  const [dept] = await db.select({ id: opdDepartments.id, active: opdDepartments.active })
    .from(opdDepartments).where(eq(opdDepartments.code, RAD_DEPARTMENT_CODE));
  const radiologists = dept === undefined || !dept.active ? [] : await db
    .select({ doctorId: opdDoctors.id, displayName: opdDoctors.displayName, userId: opdDoctors.userId })
    .from(opdDoctors)
    .where(and(eq(opdDoctors.departmentId, dept.id), eq(opdDoctors.active, true)))
    .orderBy(asc(opdDoctors.id));
  return { bookActive: types !== null, book, radiologists };
}

/* ═══════════════════════════════ money ═══════════════════════════════ */

export type DeskTender = { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string | null };

export type DeskCollectInput = {
  encounterNo: string;
  studyIds: string[];
  /** Film and CD, named by kind: the service is the tariff's own `RAD-FILM` / `RAD-CD`, never the caller's. */
  addOns?: { studyId: string; kind: "film" | "cd" }[];
  tender: DeskTender;
};

export type DeskCollectResult = {
  invoiceId: string;
  invoiceNo: string;
  receiptNo: string | null;
  /** What was collected. 0 when an earlier bill already charged every study (`adopted`). */
  totalPaise: number;
  adopted: boolean;
  linked: { studyId: string; invoiceLineId: string }[];
};

type StudyRow = typeof imagingStudies.$inferSelect;
type Issued = { invoiceId: string; invoiceNo: string; receiptNo: string | null; totalPaise: number };

export async function collectAtDesk(
  db: Db, actor: Actor, input: DeskCollectInput, idempotencyKey: string, now: Date = new Date(),
): Promise<DeskCollectResult> {
  if (idempotencyKey.trim() === "") throw new Error("collectAtDesk needs the desk's idempotency key");
  await requirePermissions(db, actor, [INVOICE_ISSUE, RECEIPT_RECORD, BILL_DECISIONS]);

  /* ── every study first: on this visit, of one patient — before anything is priced or written ── */
  const ids = input.studyIds;
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new RadiologyError("not_collectable", "name each study to collect for once", { studyIds: ids });
  }
  const rows = await db.select().from(imagingStudies).where(inArray(imagingStudies.id, ids));
  const studies: StudyRow[] = ids.map((id) => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) throw new RadiologyError("unknown_study", `no study ${id}`, { studyId: id });
    return row;
  });
  const patientId = studies[0]!.patientId;
  const foreign = studies.filter((s) => s.encounterNo !== input.encounterNo || s.patientId !== patientId);
  if (foreign.length > 0) {
    throw new RadiologyError(
      "study_not_on_visit",
      `${foreign.map((s) => s.accessionNo).join(", ")} ${foreign.length === 1 ? "is" : "are"} not on visit `
      + `${input.encounterNo} of this patient — one bill names one person and one visit`,
      { encounterNo: input.encounterNo, studyIds: foreign.map((s) => s.id) },
    );
  }

  const addOns = await resolveAddOns(db, studies, input.addOns ?? []);
  const lines = studies.flatMap((s) => [
    { lineId: `study-${s.id}`, serviceId: s.serviceId, qty: 1 },
    ...addOns.filter((a) => a.studyId === s.id).map((a) => ({ lineId: `${a.kind}-${s.id}`, serviceId: a.serviceId, qty: 1 })),
  ]);
  const tender = {
    mode: input.tender.mode, amountPaise: input.tender.amountPaise,
    ...(input.tender.mode === "cash" || input.tender.refText === undefined || input.tender.refText === null
      ? {} : { refText: input.tender.refText }),
  };
  const body = { encounterNo: input.encounterNo, studyIds: ids, addOns: input.addOns ?? [], tender };

  let issued: Issued;
  try {
    issued = await withIdempotency(db, { actorId: actor.id, route: DESK_COLLECT_ROUTE, key: idempotencyKey }, body, async (): Promise<Issued> => {
      await assertCollectable(db, studies);
      const priced = await previewInvoice(db, { encounterId: input.encounterNo, lines, patientId }, now);
      if (priced.totals.netPayablePaise !== tender.amountPaise) {
        throw new RadiologyError(
          "price_changed",
          `the bill now comes to ${String(priced.totals.netPayablePaise)} paise and the desk showed `
          + `${String(tender.amountPaise)} — read the new total to the patient before collecting`,
          { netPayablePaise: priced.totals.netPayablePaise, amountPaise: tender.amountPaise },
        );
      }
      const result = await issueInvoice(db, actor, {
        draftId: newId(), patientId, encounterId: input.encounterNo, lines, receipt: { tenders: [tender] },
      }, now);
      return {
        invoiceId: result.invoiceId, invoiceNo: result.invoiceNo, receiptNo: result.receiptNo,
        totalPaise: result.totals.netPayablePaise,
      };
    }, now);
  } catch (e) {
    if (e instanceof BillingError && e.code === "duplicate_invoice_refused" && addOns.length === 0) {
      const adopted = await adoptStandingInvoice(db, studies, (e.detail as { invoiceId?: unknown } | undefined)?.invoiceId);
      if (adopted !== null) return adopted;
    }
    throw e;
  }

  const linked = await linkStudies(db, issued.invoiceId, issued.invoiceNo, studies);
  return { ...issued, adopted: false, linked };
}

/** Film and CD only when the tariff carries them, and never film on an X-ray (counter.ts's rule, ruling 1). */
async function resolveAddOns(
  db: Db, studies: StudyRow[], asked: readonly { studyId: string; kind: "film" | "cd" }[],
): Promise<{ studyId: string; kind: "film" | "cd"; serviceId: string }[]> {
  if (asked.length === 0) return [];
  const tariff = await db.select({ id: services.id, code: services.code }).from(services)
    .where(and(inArray(services.code, [FILM_SERVICE_CODE, CD_SERVICE_CODE]), eq(services.active, true)));
  const out: { studyId: string; kind: "film" | "cd"; serviceId: string }[] = [];
  for (const a of asked) {
    const study = studies.find((s) => s.id === a.studyId);
    const service = tariff.find((t) => t.code === (a.kind === "film" ? FILM_SERVICE_CODE : CD_SERVICE_CODE));
    const xray = study === undefined ? false : (await requireStudyType(db, study.studyTypeCode)).modality === "xray";
    if (study === undefined || service === undefined || (a.kind === "film" && xray)
      || out.some((o) => o.studyId === a.studyId && o.kind === a.kind)) {
      throw new RadiologyError(
        "not_collectable",
        `${a.kind === "film" ? "film" : "a CD"} is not offered for ${study?.accessionNo ?? a.studyId} at this counter`,
        { studyId: a.studyId, kind: a.kind },
      );
    }
    out.push({ studyId: a.studyId, kind: a.kind, serviceId: service.id });
  }
  return out;
}

/** Each study is the desk's to bill: not on the machine yet, not linked, and nothing else authorises it. */
async function assertCollectable(db: Db, studies: StudyRow[]): Promise<void> {
  const { intendedPayer } = await encounterPayer(db, studies[0]!.encounterNo);
  for (const s of studies) {
    const authorisation = authorisationOf(
      { invoiceLineId: s.invoiceLineId, priority: s.priority, encounterNo: s.encounterNo },
      { intendedPayer }, await imagingFreeAt(db, s.createdAt),
    );
    if (!COLLECTABLE_STATUSES.includes(s.status) || authorisation !== null) {
      throw new RadiologyError(
        "not_collectable",
        authorisation === null
          ? `${s.accessionNo} is ${s.status} — the desk collects only before the scan`
          : `${s.accessionNo} is already authorised (${authorisation}) — nothing to collect for it here`,
        { studyId: s.id, status: s.status, authorisation },
      );
    }
  }
}

/**
 * The invoice's lines onto the studies, in one transaction: a line of the study's service that pays for
 * no other study, the study's own link first (so a replay re-links what it linked).
 */
async function linkStudies(
  db: Db, invoiceId: string, invoiceNo: string, studies: StudyRow[],
): Promise<{ studyId: string; invoiceLineId: string }[]> {
  const lines = await db.select({ id: invoiceLines.id, serviceId: invoiceLines.serviceId })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.lineNo));
  const plan = await planLinks(db, lines, studies);
  if (plan === null) {
    throw new RadiologyError(
      "unknown_invoice_line", `invoice ${invoiceNo} carries no free line for every study asked about`, { invoiceId },
    );
  }
  return await withTx(db, async (tx) => {
    const linked: { studyId: string; invoiceLineId: string }[] = [];
    for (const { study, lineId } of plan) linked.push(await linkInvoiceLine(tx, study.id, lineId));
    return linked;
  });
}

async function planLinks(
  db: Db, lines: readonly { id: string; serviceId: string }[], studies: StudyRow[],
): Promise<{ study: StudyRow; lineId: string }[] | null> {
  if (lines.length === 0) return null;
  const elsewhere = new Set((await db.select({ line: imagingStudies.invoiceLineId }).from(imagingStudies)
    .where(and(
      inArray(imagingStudies.invoiceLineId, lines.map((l) => l.id)),
      notInArray(imagingStudies.id, studies.map((s) => s.id)),
    ))).map((r) => r.line));
  const used = new Set<string>();
  const plan: { study: StudyRow; lineId: string }[] = [];
  for (const study of studies) {
    const line = lines.find((l) => l.id === study.invoiceLineId)
      ?? lines.find((l) => l.serviceId === study.serviceId && !used.has(l.id) && !elsewhere.has(l.id)
        && !studies.some((s) => s.invoiceLineId === l.id));
    if (line === undefined) return null;
    used.add(line.id);
    plan.push({ study, lineId: line.id });
  }
  return plan;
}

/** Billing named the invoice that already charges this visit; link its lines if it pays for every study. */
async function adoptStandingInvoice(
  db: Db, studies: StudyRow[], invoiceId: unknown,
): Promise<DeskCollectResult | null> {
  if (typeof invoiceId !== "string") return null;
  const [standing] = await db.select({ id: invoices.id, invoiceNo: invoices.invoiceNo, patientId: invoices.patientId })
    .from(invoices).where(eq(invoices.id, invoiceId));
  if (standing === undefined || standing.patientId !== studies[0]!.patientId) return null;
  const lines = await db.select({ id: invoiceLines.id, serviceId: invoiceLines.serviceId })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, standing.id)).orderBy(asc(invoiceLines.lineNo));
  const plan = await planLinks(db, lines, studies);
  if (plan === null) return null;
  const linked = await withTx(db, async (tx) => {
    const out: { studyId: string; invoiceLineId: string }[] = [];
    for (const { study, lineId } of plan) out.push(await linkInvoiceLine(tx, study.id, lineId));
    return out;
  });
  return { invoiceId: standing.id, invoiceNo: standing.invoiceNo, receiptNo: null, totalPaise: 0, adopted: true, linked };
}
