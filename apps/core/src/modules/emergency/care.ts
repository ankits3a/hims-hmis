import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { ER_INTENTS, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { verifyPinByUsername } from "../../kernel/auth/identity";
import { clearThrottle, recordThrottleFailure, throttleRetryAt } from "../../kernel/auth/throttle";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import {
  ER_OPEN_STATE_VALUES, erConsents, erCriticalAlerts, erDoses, erEpisodes, erMedIssues, erNotes, erProcedures, erSpecialtyCalls,
  items, orderItems, orders, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { resolveMedicines } from "../formulary";
import { duplicateWarnings, openCriticalsForEncounters } from "../lab";
import { MaterialsError, fefoPick, findStoreByCode, postMovements } from "../materials";
import { orderTests } from "../ordering";
import { listAllergies } from "../patients";
import { calloutList, escalationRecipients, orgDepartmentByCode, unitOnTake } from "../roster";
import { bandPerson } from "./bands";
import { postErChargeIn } from "./charge-sink";
import { lockEpisode, onceEr, provenanceOf, readEpisode, requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import {
  erCallAnswered, erCallRaised, erConsentRecorded, erDoseRecorded, erMedIssued, erNoteCosigned, erNoteRecorded, erOrderPlaced,
  erProcedureRecorded, erStabilised, erVerbalSigned,
} from "./events";
import { ER_CARE } from "./names";
import { isActiveDoctor } from "./triage";
import type { Actor, ErIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { OrderKindDecl } from "../../kernel/orders/kinds";
import type { EpisodeRow } from "./core";

/**
 * ER lane 3 (#810) — CARE (spec SPEC-emergency §3.10–§3.11, §4.3; contracts `packages/contracts/src/emergency/care.ts`).
 *
 * CARE IS NEVER GATED (spec §0): no intent here reads the bill, the identity status or the MLC state to refuse — the
 * acceptance suite proves it per intent with an unidentified patient who has paid nothing. The checks that remain are
 * clinical (who may sign, a high-alert drug's second person, an allergy's override reason) and never about money.
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

const MIN = 60_000;
/** DECIDED (lane 3): the ER satellite store (crash cart, emergency drugs) is a materials store with this code. */
export const ER_SATELLITE_STORE_CODE = "ER-SAT";
/** A verbal order (resus) is signed by the ordering doctor within this many minutes (spec §3.11). */
export const ER_VERBAL_SIGN_MIN = 120;
/** A specialty call unanswered this long climbs (spec §4.3); a critical unacknowledged this long climbs. */
export const ER_CALL_CLIMB_MIN = 15;
export const ER_CRITICAL_CLIMB_MIN = 15;
/** A duplicate STAT test: the same service ordered on the episode within this window (a warning only). */
export const ER_DUPLICATE_WINDOW_MIN = 6 * 60;
export const ER_CARE_ACTOR: Actor = { type: "system", id: "er-care-clock" };
const OPEN: readonly string[] = ER_OPEN_STATE_VALUES;
const RESIDENT_ROLES = ["resident", "radiology_resident"];
/** The roles a second checker of a high-alert drug holds (a nurse or a doctor). */
const SECOND_CHECK_ROLES = ["er_nurse", "ward_nurse", "nursing_supervisor", "doctor"];

async function openEpisode(tx: Tx, episodeId: string): Promise<EpisodeRow> {
  const e = await lockEpisode(tx, episodeId);
  if (!OPEN.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
  return e;
}

async function requireDoctor(tx: Tx, userId: string): Promise<void> {
  if (!(await isActiveDoctor(tx, userId))) throw new ErRefusal("not_a_doctor", { userId });
}

async function nameOf(tx: Db | Tx, userId: string): Promise<string> {
  return (await (tx as Db).select({ n: users.fullName }).from(users).where(eq(users.id, userId)))[0]?.n ?? userId;
}

// ═══════════════════════════════════════════ notes ═══════════════════════════════════════════

export async function recordErNote(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_er_note">> {
  const input: Input<"record_er_note"> = ER_INTENTS.record_er_note.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_er_note", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await openEpisode(tx, input.episodeId);
    // A resident's note is a draft until a senior co-signs it (spec §4.3); everyone else's is signed as written.
    const draft = actor.type === "user" && await actorHoldsAnyRole(tx, actor.id, RESIDENT_ROLES);
    const id = newId();
    await tx.insert(erNotes).values({
      id, episodeId: e.id, kind: input.kind, text: input.text, authorId: actor.id, status: draft ? "draft" : "signed",
      recordedAt: at, provenance: provenanceOf(actor),
    });
    await appendEvent(tx, erNoteRecorded.make({
      payload: { episodeId: e.id, noteId: id, kind: input.kind, draft, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { noteId: id, status: draft ? "draft" as const : "signed" as const, at: at.toISOString() };
  }), at);
}

export async function cosignErNote(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"cosign_er_note">> {
  const input: Input<"cosign_er_note"> = ER_INTENTS.cosign_er_note.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "cosign_er_note", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const n = (await tx.select().from(erNotes).where(eq(erNotes.id, input.noteId)).for("update"))[0];
    if (n === undefined) throw new ErRefusal("note_not_found");
    if (n.status === "signed") throw new ErRefusal("note_signed");
    if (n.authorId === actor.id) throw new ErRefusal("cosign_own_note");
    if (!(await isActiveDoctor(tx, actor.id)) || await actorHoldsAnyRole(tx, actor.id, RESIDENT_ROLES)) {
      throw new ErRefusal("cosigner_not_senior");
    }
    await tx.update(erNotes).set({ status: "signed", cosignedBy: actor.id, cosignedAt: at, addendum: input.addendum ?? null })
      .where(eq(erNotes.id, n.id));
    const e = await readEpisode(tx, n.episodeId);
    await appendEvent(tx, erNoteCosigned.make({
      payload: { episodeId: n.episodeId, noteId: n.id, provenance: provenanceOf(actor) },
      actor, correlationId: n.episodeId, patientId: e.patientId, occurredAt: at,
    }));
    return { noteId: n.id, status: "signed" as const, cosignedAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ orders ═══════════════════════════════════════════

/**
 * Through THE ordering door (decision 0067: `orderTests`), naming the ER episode number at STAT unless told otherwise.
 * The ER sink takes the lines (no invoice, no report held for money). A test already ordered on this episode within
 * 6 hours comes back as a duplicate WARNING — the order still goes (two doctors at one resus, spec §4.3).
 */
export async function placeErOrder(
  db: Db, actor: Actor, raw: unknown, opts: Opts & { orderKinds: readonly OrderKindDecl[] },
): Promise<Output<"place_er_order">> {
  const input: Input<"place_er_order"> = ER_INTENTS.place_er_order.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "place_er_order", input.idempotencyKey, input, async () => {
    const e = await readEpisode(db, input.episodeId);
    if (!OPEN.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (!(await isActiveDoctor(db as unknown as Tx, actor.id))) throw new ErRefusal("not_a_doctor", { userId: actor.id });
    const since = new Date(at.getTime() - ER_DUPLICATE_WINDOW_MIN * MIN);
    const earlier = await db.select({ serviceId: orderItems.serviceId }).from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.encounterNo, e.episodeNo), inArray(orderItems.serviceId, input.serviceIds), sql`${orders.placedAt} >= ${since}`));
    // The lab's own duplicate detector (per patient, analyte-aware) refuses an unacknowledged repeat; in the ER a repeated
    // STAT test is a WARNING (spec §4.3), so its findings are acknowledged here and come back to the doctor as the warning.
    const labDupes = await duplicateWarnings(db, actor, e.patientId, input.serviceIds, at);
    const duplicates = [...new Set([...earlier.map((r) => r.serviceId), ...labDupes.map((d) => d.serviceId)])];
    const r = await orderTests(db, actor, opts.orderKinds, {
      patientId: e.patientId, encounterNo: e.episodeNo, serviceDate: istDayString(at), orderingClinicianId: actor.id,
      serviceIds: input.serviceIds, indication: input.indication, priority: input.priority ?? "stat",
      acknowledgedDuplicates: labDupes.map((d) => d.duplicateOfItemId),
    }, at);
    const labOrderId = (r.lab as { orderId?: string } | null)?.orderId ?? null;
    const imagingOrderId = (r.imaging as { orderId?: string } | null)?.orderId ?? null;
    await withTx(db, async (tx) => {
      await appendEvent(tx, erOrderPlaced.make({
        payload: {
          episodeId: e.id, labOrderId, imagingOrderId, priority: input.priority ?? "stat", items: input.serviceIds.length,
          skipped: r.skipped.length, provenance: provenanceOf(actor),
        },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
    });
    return {
      episodeId: e.id, labOrderId, imagingOrderId,
      skipped: r.skipped.map((s) => ({ department: s.department, serviceIds: [...s.serviceIds], code: s.code, message: s.message })),
      duplicates,
    };
  }, at);
}

// ═══════════════════════════════════════════ medicines ═══════════════════════════════════════════

/** Allergy words that meet the drug's name or salts — a plain, recorded-allergy check (salt-aware where the item is a formulary drug). */
async function allergyHits(db: Db, patientId: string, itemName: string, medicineId: string | null): Promise<string[]> {
  const live = (await listAllergies(db, patientId)).filter((a) => a.status === "active");
  if (live.length === 0) return [];
  const words = [itemName.toLowerCase()];
  if (medicineId !== null) {
    const r = (await resolveMedicines(db, [medicineId])).get(medicineId);
    for (const s of r?.salts ?? []) {
      if (s.moiety) words.push(s.moiety.toLowerCase());
      if (s.drugClass) words.push(s.drugClass.toLowerCase());
    }
  }
  return live.filter((a) => {
    const sub = a.substance.trim().toLowerCase();
    return sub !== "" && words.some((w) => w.includes(sub) || sub.includes(w));
  }).map((a) => a.substance);
}

/**
 * The ER satellite issue: FEFO from the ER store, patient labels, one charge line on the episode's sink (priced by lane
 * 6's bill desk), and the medication record's order half. Own medicines (brought by the family) are recorded, never
 * charged, never taken from stock. A recorded allergy that matches needs the override reason; it is never a hard block.
 */
export async function issueErMed(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"issue_er_med">> {
  const input: Input<"issue_er_med"> = ER_INTENTS.issue_er_med.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "issue_er_med", input.idempotencyKey, input, async () => {
    const pre = await readEpisode(db, input.episodeId);
    const item = input.itemId === undefined ? null
      : (await db.select().from(items).where(eq(items.id, input.itemId)))[0] ?? null;
    if (input.itemId !== undefined && item === null) throw new ErRefusal("item_not_stocked", { itemId: input.itemId });
    const name = item?.name ?? input.ownMedicine!;
    const hits = await allergyHits(db, (await bandPerson(db, pre.patientId)).id, name, item?.formularyMedicineId ?? null);
    if (hits.length > 0 && input.allergyOverride === undefined) throw new ErRefusal("allergy_override_needed", { allergies: hits });
    return withTx(db, async (tx) => {
      const e = await openEpisode(tx, input.episodeId);
      await requireDoctor(tx, input.orderedBy);
      const id = newId();
      let batches: { batchId: string; qty: number; ledgerEntryId: string }[] = [];
      let storeId: string | null = null;
      if (item !== null) {
        const store = await findStoreByCode(tx, ER_SATELLITE_STORE_CODE);
        if (store === undefined) throw new ErRefusal("item_not_stocked", { store: ER_SATELLITE_STORE_CODE });
        storeId = store.id;
        const picks = await fefoPick(tx, store.id, item.id, input.units, at);
        const have = picks.reduce((s, p) => s + p.qty, 0);
        if (have < input.units) throw new ErRefusal("stock_short", { asked: input.units, available: have });
        try {
          const moved = await postMovements(tx, actor, picks.map((p) => ({
            resourceId: store.id, batchId: p.batchId, qtyDelta: -p.qty, reason: "consume" as const, refType: "er_issue", refId: id,
            patientId: e.patientId, encounterId: e.id, occurredAt: at,
          })));
          batches = picks.map((p, i) => ({ batchId: p.batchId, qty: p.qty, ledgerEntryId: moved[i]!.ledgerEntryId }));
        } catch (err) {
          if (err instanceof MaterialsError) throw new ErRefusal("stock_short", { reason: err.code });
          throw err;
        }
      }
      const highAlert = item?.highAlert === true;
      await tx.insert(erMedIssues).values({
        id, episodeId: e.id, patientId: e.patientId, itemId: item?.id ?? null, ownMedicine: input.ownMedicine ?? null, name,
        doseWords: input.doseWords, route: input.route, units: input.units, highAlert, storeId, batches,
        orderedBy: input.orderedBy, verbal: input.verbal !== undefined, allergyOverride: input.allergyOverride ?? null,
        issuedBy: actor.id, issuedAt: at,
      });
      if (item !== null) {
        await postErChargeIn(tx, actor, { episodeId: e.id, source: "er.issue", issueId: id, itemId: item.id, qty: input.units, at });
      }
      const p = await bandPerson(tx, e.patientId);
      const labelLines = [
        `${name} · ${input.doseWords} · ${input.route.toUpperCase()}`,
        `${p.name} · ${p.uhid} · ${e.episodeNo}`,
        ...(highAlert ? ["HIGH ALERT — second check"] : []),
        p.unidentified ? "Allergy: unknown" : hits.length > 0 ? `Allergy: ${hits.join(", ")} — override recorded` : "",
      ].filter((x) => x !== "");
      await appendEvent(tx, erMedIssued.make({
        payload: { episodeId: e.id, issueId: id, units: input.units, highAlert, own: item === null, verbal: input.verbal !== undefined, provenance: provenanceOf(actor) },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      return { issueId: id, highAlert, labels: item === null ? 0 : 1, verbal: input.verbal !== undefined, labelLines };
    });
  }, at);
}

/** Verifies a second person's PIN on its own connection (a failure is COMMITTED before the refusal — IPD's shape). */
async function secondPerson(db: Db, actor: Actor, username: string, pin: string, at: Date): Promise<string> {
  const user = username.trim();
  const outcome = await withTx(db, async (lockTx) => {
    const ldb = lockTx as unknown as Db;
    await lockTx.execute(sql`select pg_advisory_xact_lock(hashtext(${`er.dose.pin:${user.toLowerCase()}`}))`);
    if (await throttleRetryAt(ldb, "pin", user, at) !== null) return null;
    const v = await verifyPinByUsername(ldb, user, pin);
    if (v === null) { await recordThrottleFailure(ldb, "pin", user, at); return null; }
    await clearThrottle(ldb, "pin", user);
    return v.userId;
  });
  if (outcome === null) throw new ErRefusal("second_check_failed");
  if (outcome === actor.id) throw new ErRefusal("second_checker_same");
  const ok = await withTx(db, (tx) => actorHoldsAnyRole(tx, outcome, SECOND_CHECK_ROLES));
  if (!ok) throw new ErRefusal("second_check_failed", { role: "not_clinical" });
  return outcome;
}

export async function giveErDose(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"give_er_dose">> {
  const input: Input<"give_er_dose"> = ER_INTENTS.give_er_dose.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "give_er_dose", input.idempotencyKey, input, async () => {
    const issue = (await db.select().from(erMedIssues).where(eq(erMedIssues.id, input.issueId)))[0];
    if (issue === undefined) throw new ErRefusal("issue_not_found");
    let checker: string | null = null;
    if (issue.highAlert && input.outcome === "given") {
      if (input.secondCheck === undefined) throw new ErRefusal("second_check_needed");
      checker = await secondPerson(db, actor, input.secondCheck.username, input.secondCheck.pin, at);
    }
    return withTx(db, async (tx) => {
      const e = await openEpisode(tx, issue.episodeId);
      const done = (await tx.select({ id: erDoses.id }).from(erDoses).where(eq(erDoses.issueId, issue.id)))[0];
      if (done !== undefined) throw new ErRefusal("dose_already_recorded", { doseId: done.id });
      const id = newId();
      await tx.insert(erDoses).values({
        id, issueId: issue.id, outcome: input.outcome, reason: input.reason ?? null, secondCheckBy: checker, recordedBy: actor.id, recordedAt: at,
      });
      await appendEvent(tx, erDoseRecorded.make({
        payload: { episodeId: e.id, issueId: issue.id, doseId: id, outcome: input.outcome, highAlert: issue.highAlert, provenance: provenanceOf(actor) },
        actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
      }));
      return { doseId: id, outcome: input.outcome, at: at.toISOString(), secondCheckedBy: checker };
    });
  }, at);
}

export async function signErVerbalOrder(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"sign_er_verbal_order">> {
  const input: Input<"sign_er_verbal_order"> = ER_INTENTS.sign_er_verbal_order.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "sign_er_verbal_order", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const i = (await tx.select().from(erMedIssues).where(eq(erMedIssues.id, input.issueId)).for("update"))[0];
    if (i === undefined) throw new ErRefusal("issue_not_found");
    if (!i.verbal || i.verbalSignedAt !== null) throw new ErRefusal("verbal_not_pending");
    if (i.orderedBy !== actor.id) throw new ErRefusal("not_ordering_doctor", { orderedBy: i.orderedBy });
    await tx.update(erMedIssues).set({ verbalSignedAt: at }).where(eq(erMedIssues.id, i.id));
    await appendEvent(tx, erVerbalSigned.make({
      payload: { episodeId: i.episodeId, issueId: i.id, lateMin: Math.max(0, Math.round((at.getTime() - i.issuedAt.getTime()) / MIN) - ER_VERBAL_SIGN_MIN), provenance: provenanceOf(actor) },
      actor, correlationId: i.episodeId, patientId: i.patientId, occurredAt: at,
    }));
    return { issueId: i.id, signedAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ procedures and consent ═══════════════════════════════════════════

export async function recordProcedure(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_procedure">> {
  const input: Input<"record_procedure"> = ER_INTENTS.record_procedure.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  const performedAt = input.performedAt === undefined ? at : new Date(input.performedAt);
  if (performedAt.getTime() > at.getTime() + 2 * MIN) throw new ErRefusal("time_in_future");
  return onceEr(db, actor, "record_procedure", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await openEpisode(tx, input.episodeId);
    if (input.consentId !== undefined) {
      const c = (await tx.select({ id: erConsents.id }).from(erConsents).where(and(eq(erConsents.id, input.consentId), eq(erConsents.episodeId, e.id))))[0];
      if (c === undefined) throw new ErRefusal("consent_not_found");
    }
    const id = newId();
    await tx.insert(erProcedures).values({
      id, episodeId: e.id, name: input.name, serviceId: input.serviceId ?? null, performedBy: input.performedBy, performedAt,
      consentId: input.consentId ?? null, notes: input.notes ?? null, recordedBy: actor.id, recordedAt: at,
    });
    if (input.serviceId !== undefined) {
      await postErChargeIn(tx, actor, { episodeId: e.id, source: "er.procedure", procedureId: id, serviceId: input.serviceId, qty: 1, at: performedAt });
    }
    await appendEvent(tx, erProcedureRecorded.make({
      payload: { episodeId: e.id, procedureId: id, performedBy: input.performedBy, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { procedureId: id, at: performedAt.toISOString() };
  }), at);
}

export async function recordConsent(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_consent">> {
  const input: Input<"record_consent"> = ER_INTENTS.record_consent.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  if (input.method === "paper" && input.signedBy !== "emergency" && input.witnessName === undefined) throw new ErRefusal("consent_witness_needed");
  if ((input.signedBy === "guardian" || input.signedBy === "representative") && (input.signerName === undefined || input.relation === undefined)) {
    throw new ErRefusal("consent_witness_needed", { signer: "name and relation" });
  }
  if (input.signedBy === "emergency" && input.secondDoctorId === undefined) throw new ErRefusal("emergency_needs_second_doctor");
  return onceEr(db, actor, "record_consent", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await openEpisode(tx, input.episodeId);
    if (input.signedBy === "emergency") {
      // The treating doctor's word with a second doctor's concurrence: both must be doctors, and different people.
      await requireDoctor(tx, actor.id);
      await requireDoctor(tx, input.secondDoctorId!);
      if (input.secondDoctorId === actor.id) throw new ErRefusal("emergency_needs_second_doctor", { same: true });
    }
    const id = newId();
    await tx.insert(erConsents).values({
      id, episodeId: e.id, kind: input.kind, about: input.about, signedBy: input.signedBy, signerName: input.signerName ?? null,
      relation: input.relation ?? null, method: input.method, witnessName: input.witnessName ?? null,
      secondDoctorId: input.secondDoctorId ?? null, language: input.language ?? null, recordedBy: actor.id, recordedAt: at,
    });
    await appendEvent(tx, erConsentRecorded.make({
      payload: { episodeId: e.id, consentId: id, kind: input.kind, signedBy: input.signedBy, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { consentId: id, at: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ specialty calls ═══════════════════════════════════════════

/**
 * Who: the roster's call-out rungs for the department (the unit on take at the GATE instant, seam E2 — a 07:55 arrival
 * called at 08:10 belongs to the night's unit). When called, answered, seen: stamped; unanswered 15 min, it climbs.
 */
export async function callSpecialty(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"call_specialty">> {
  const input: Input<"call_specialty"> = ER_INTENTS.call_specialty.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "call_specialty", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await openEpisode(tx, input.episodeId);
    const dept = await orgDepartmentByCode(tx, input.departmentCode.toUpperCase());
    if (dept === undefined) throw new ErRefusal("department_not_found", { departmentCode: input.departmentCode });
    const open = (await tx.select({ id: erSpecialtyCalls.id }).from(erSpecialtyCalls).where(and(
      eq(erSpecialtyCalls.episodeId, e.id), eq(erSpecialtyCalls.departmentId, dept.id), isNull(erSpecialtyCalls.seenAt),
    )))[0];
    if (open !== undefined) throw new ErRefusal("call_already_open", { callId: open.id });
    const take = await unitOnTake(tx, dept.id, e.arrivedAt);
    const rungs = await calloutList(tx, dept.id, at);
    const ids = [...new Set(rungs.flatMap((r) => (r.userId === null ? [] : [r.userId])))].slice(0, 6);
    const callees = [];
    for (const userId of ids) callees.push({ userId, name: await nameOf(tx, userId) });
    const id = newId();
    await tx.insert(erSpecialtyCalls).values({
      id, episodeId: e.id, departmentId: dept.id, departmentCode: dept.code, urgency: input.urgency, reason: input.reason,
      takeTeamId: take.teamId, takeSource: take.source, callees, calledBy: actor.id, calledAt: at,
    });
    for (const c of callees) {
      await raiseNoticeIn(tx, {
        userId: c.userId, kind: "er.call", title: `ER call · ${dept.code} · ${e.episodeNo}`, body: `${input.urgency} · bay ${e.bayId === null ? "—" : "assigned"}`,
        refType: "er_episode", refId: e.id, sourceKey: `er_call:${id}`, at,
      });
    }
    await appendEvent(tx, erCallRaised.make({
      payload: { episodeId: e.id, callId: id, departmentCode: dept.code, urgency: input.urgency, takeTeamId: take.teamId, provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { callId: id, takeTeamId: take.teamId, takeSource: take.source, callees, calledAt: at.toISOString() };
  }), at);
}

export async function answerCall(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"answer_call">> {
  const input: Input<"answer_call"> = ER_INTENTS.answer_call.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "answer_call", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const c = (await tx.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.id, input.callId)).for("update"))[0];
    if (c === undefined) throw new ErRefusal("call_not_found");
    if (c.seenAt !== null) throw new ErRefusal("call_closed");
    await requireDoctor(tx, actor.id);
    const answeredAt = c.answeredAt ?? at;
    const set = input.step === "answered"
      ? { answeredAt, answeredBy: c.answeredBy ?? actor.id }
      : { answeredAt, answeredBy: c.answeredBy ?? actor.id, seenAt: at, seenBy: actor.id };
    await tx.update(erSpecialtyCalls).set(set).where(eq(erSpecialtyCalls.id, c.id));
    const e = await readEpisode(tx, c.episodeId);
    await appendEvent(tx, erCallAnswered.make({
      payload: { episodeId: c.episodeId, callId: c.id, step: input.step, minutes: Math.round((at.getTime() - c.calledAt.getTime()) / MIN), provenance: provenanceOf(actor) },
      actor, correlationId: c.episodeId, patientId: e.patientId, occurredAt: at,
    }));
    return { callId: c.id, answeredAt: answeredAt.toISOString(), seenAt: input.step === "seen" ? at.toISOString() : null };
  }), at);
}

// ═══════════════════════════════════════════ stabilised ═══════════════════════════════════════════

export async function declareStabilised(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"declare_stabilised">> {
  const input: Input<"declare_stabilised"> = ER_INTENTS.declare_stabilised.input.parse(raw);
  await requireErPermission(db, actor, ER_CARE);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "declare_stabilised", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const e = await openEpisode(tx, input.episodeId);
    await requireDoctor(tx, actor.id);
    if (e.stabilisedAt !== null) throw new ErRefusal("already_stabilised", { stabilisedAt: e.stabilisedAt.toISOString() });
    await tx.update(erEpisodes).set({ stabilisedAt: at, stabilisedBy: actor.id, updatedAt: at }).where(eq(erEpisodes.id, e.id));
    if (input.note !== undefined) {
      await tx.insert(erNotes).values({
        id: newId(), episodeId: e.id, kind: "progress", text: `Stabilised: ${input.note}`, authorId: actor.id, status: "signed",
        recordedAt: at, provenance: provenanceOf(actor),
      });
    }
    await appendEvent(tx, erStabilised.make({
      payload: { episodeId: e.id, stabilisedAt: at.toISOString(), provenance: provenanceOf(actor) },
      actor, correlationId: e.id, patientId: e.patientId, occurredAt: at,
    }));
    return { episodeId: e.id, stabilisedAt: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ the care clocks ═══════════════════════════════════════════

/**
 * Every minute (inside the bed-reservation lapse job). Three things, each raised ONCE and stamped:
 * - a CRITICAL lab result on an open ER episode (the lab's call ladder still open): told to the ER doctor of record (or,
 *   with none yet, to the `er_critical` ladder's people); still open 15 min later → climbs on the `er_critical` ladder
 *   (fallback `duty_manager`). The call itself closes only by the lab's read-back.
 * - a SPECIALTY CALL unanswered 15 min → climbs on the `er_call` ladder (fallback `duty_manager`).
 * - a VERBAL ORDER unsigned 2 h after issue → the ordering doctor's bell.
 * Notices carry the ER number and the analyte, never a patient's name.
 */
export async function sweepErCareClocks(db: Db, now: Date): Promise<{ criticals: number; climbs: number; calls: number; verbal: number }> {
  const out = { criticals: 0, climbs: 0, calls: 0, verbal: 0 };
  const open = await db.select({ id: erEpisodes.id, episodeNo: erEpisodes.episodeNo }).from(erEpisodes)
    .where(inArray(erEpisodes.state, [...ER_OPEN_STATE_VALUES]));
  const byNo = new Map(open.map((e) => [e.episodeNo, e.id] as const));
  for (const c of await openCriticalsForEncounters(db, [...byNo.keys()])) {
    const episodeId = byNo.get(c.encounterNo);
    if (episodeId === undefined) continue;
    await withTx(db, async (tx) => {
      const e = await lockEpisode(tx, episodeId);
      const row = (await tx.select().from(erCriticalAlerts).where(eq(erCriticalAlerts.callId, c.callId)).for("update"))[0];
      const body = `${c.analyteCode} ${c.value}${c.unit === null ? "" : ` ${c.unit}`}`;
      if (row === undefined) {
        const to = e.doctorId !== null ? [e.doctorId]
          : (await escalationRecipients(tx, "er_critical", { fallbackRoleKey: "duty_manager" }, now)).userIds;
        for (const userId of to) {
          await raiseNoticeIn(tx, {
            userId, kind: "er.critical_result", title: `Critical result · ${e.episodeNo}`, body, refType: "er_episode", refId: e.id,
            sourceKey: `er_critical:${c.callId}`, at: now,
          });
        }
        await tx.insert(erCriticalAlerts).values({ id: newId(), callId: c.callId, episodeId: e.id, notifiedAt: now, notifiedUserIds: to });
        out.criticals += 1;
      } else if (row.climbedAt === null && now.getTime() >= row.notifiedAt.getTime() + ER_CRITICAL_CLIMB_MIN * MIN) {
        const to = (await escalationRecipients(tx, "er_critical", { fallbackRoleKey: "duty_manager" }, now)).userIds;
        for (const userId of to) {
          await raiseNoticeIn(tx, {
            userId, kind: "er.critical_unacknowledged", title: `Critical not acknowledged · ${e.episodeNo}`, body,
            refType: "er_episode", refId: e.id, sourceKey: `er_critical:${c.callId}:climb`, at: now,
          });
        }
        await tx.update(erCriticalAlerts).set({ climbedAt: now }).where(eq(erCriticalAlerts.id, row.id));
        out.climbs += 1;
      }
    });
  }
  const lateCalls = await db.select({ id: erSpecialtyCalls.id }).from(erSpecialtyCalls).where(and(
    isNull(erSpecialtyCalls.answeredAt), isNull(erSpecialtyCalls.climbedAt), lte(erSpecialtyCalls.calledAt, new Date(now.getTime() - ER_CALL_CLIMB_MIN * MIN)),
  ));
  for (const { id } of lateCalls) {
    await withTx(db, async (tx) => {
      const c = (await tx.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.id, id)).for("update"))[0];
      if (c === undefined || c.answeredAt !== null || c.climbedAt !== null) return;
      const e = await readEpisode(tx, c.episodeId);
      if (!OPEN.includes(e.state)) return;
      const to = (await escalationRecipients(tx, "er_call", { fallbackRoleKey: "duty_manager", departmentId: c.departmentId }, now)).userIds;
      for (const userId of to) {
        await raiseNoticeIn(tx, {
          userId, kind: "er.call_unanswered", title: `ER call unanswered · ${c.departmentCode} · ${e.episodeNo}`,
          body: `${c.urgency} · ${String(Math.round((now.getTime() - c.calledAt.getTime()) / MIN))} min`,
          refType: "er_episode", refId: e.id, sourceKey: `er_call:${c.id}:climb`, at: now,
        });
      }
      await tx.update(erSpecialtyCalls).set({ climbedAt: now }).where(eq(erSpecialtyCalls.id, c.id));
      out.calls += 1;
    });
  }
  const verbal = await db.select().from(erMedIssues).where(and(
    eq(erMedIssues.verbal, true), isNull(erMedIssues.verbalSignedAt), isNull(erMedIssues.verbalNoticeAt),
    lte(erMedIssues.issuedAt, new Date(now.getTime() - ER_VERBAL_SIGN_MIN * MIN)),
  ));
  for (const v of verbal) {
    await withTx(db, async (tx) => {
      const e = await readEpisode(tx, v.episodeId);
      await raiseNoticeIn(tx, {
        userId: v.orderedBy, kind: "er.verbal_unsigned", title: `Sign verbal order · ${e.episodeNo}`, body: `${v.name} · ${v.doseWords}`,
        refType: "er_episode", refId: e.id, sourceKey: `er_verbal:${v.id}`, at: now,
      });
      await tx.update(erMedIssues).set({ verbalNoticeAt: now }).where(eq(erMedIssues.id, v.id));
      out.verbal += 1;
    });
  }
  return out;
}

