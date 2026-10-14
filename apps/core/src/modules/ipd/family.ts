import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { IPD_FAMILY_PURPOSE, newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  eventIdempotency, ipdAdmissionConditions, ipdAdmissions, ipdBedStays, ipdFamilyCallbacks, ipdFamilyLinks, patients,
} from "../../kernel/db/schema";
import { hmacSign } from "../../kernel/crypto";
import { appendEvent } from "../../kernel/events/append";
import { maskPhone } from "../../kernel/notify/mask";
import { getPatientSummaries, patientUpdated } from "../patients";
import { admissionAdvisoryLock, holdsPermission, readAdmission, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { bedWithWard } from "./beds";
import { attendantOf } from "./daily-totals";
import { IPD_LADDER_STATES } from "./deposit-ladder";
import { IpdError } from "./errors";
import { IPD_FAMILY_STOP_CONSUMER, conditionSet, familyCallbackClosed, familyLinkIssued, familyLinkRevoked } from "./family-events";
import { admissionAbsconded, admissionDeceased } from "./discharge-events";
import { IPD_CONDITION_SET, IPD_FAMILY_ISSUE } from "./permissions";
import type {
  Actor, IpdConditionWord, IpdFamilyCallback, IpdFamilyCallbackList, IpdFamilyLinkIssued, IpdFamilyPanel, IpdIssueFamilyLink,
  IpdSetCondition,
} from "@hmis/contracts";
import type { DeskCard } from "../../kernel/desk/types";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * E3.3 (#731) — THE FAMILY LINK, STAFF SIDE (spec SPEC-ipd-core §4.9 G, §4.10 edges 14–17; decision 0072).
 *
 * DECIDED (no owner answer was available; ⚖ = law):
 * - ⚖ WHO: the link goes only to the REGISTERED ATTENDANT — the daily totals' recipient (`attendantOf`): the active guardian
 *   with a phone and bill authority, else the latest deposit payer recorded as a relative with a phone. The desk cannot
 *   type a number. The phone's SHA-256 is kept with the link; an OTP is sent only while that reference still resolves to
 *   the same phone (a changed phone needs a new link — §4.10 edge 15, impostor relative).
 * - ⚖ OFF FOR: a sealed patient (`patients.sensitive_context`, D-31 — VIP-protected), a medico-legal admission
 *   (`ipd_admissions.mlc`: no "MLC-restricted" field exists, so every MLC is restricted), and any admission the treating
 *   team turns off (psychiatric — Mental Healthcare Act 2017 §23; HIV — HIV/AIDS Act 2017 §8; MTP — MTP Act §5A; POCSO;
 *   the patient's own request). A confidential (staff / VIP) patient keeps the link with the ALIAS and no ward.
 * - ⚖ DPDP Act 2023: the purpose (`inpatient_updates`) is stated on the page and stored with the consent; consent names
 *   who agreed and their relation, and how (verbal or paper). Minimisation: first name, ward, day, condition word,
 *   totals and tracker; line items only after a second explicit step, logged.
 * - STOPS (§4.10 edges 16–17): death and absconding revoke the link (`familyStopConsumer` on `ipd.admission.deceased` /
 *   `.absconded`); the public side also re-checks the admission's state on every read, so the page closes at once even
 *   before the worker runs. Discharge, LAMA / DAMA and refer-out: "Discharged" for 24 hours after the exit, then closed.
 * - CALLBACKS go to the ward desk (`ipd.family.issue` holders: front office, its supervisor, the duty manager — no ward
 *   nurse role is seeded yet) who route them to the nurse in charge; nothing answers them automatically.
 * - The condition word is set by a doctor (`ipd.condition.set`); nursing roles join when the ipd-nursing lane seeds them.
 */
const SYSTEM: Actor = { type: "system", id: "ipd-family" };

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** A phone as the registry stores it, digits only, the last ten (Indian mobile). */
export const normalisePhone = (p: string): string => p.replace(/\D/g, "").slice(-10);

/**
 * Review #764 — the phone kept with a link is an HMAC-SHA256 under the server's `SECRET_KEY` (kernel/crypto `hmacSign`, the
 * badge token's primitive), domain-separated, so a copy of the table does not give back the number by trying the ten-digit
 * space. Compared only by recomputing it.
 */
export const familyPhoneDigest = (secretKey: Buffer, phone: string): string => hmacSign(secretKey, `hmis.ipd.family.phone.v1|${normalisePhone(phone)}`);

type Blocked = IpdFamilyPanel["blocked"];
const OPEN_STATES = IPD_LADDER_STATES as readonly string[];

async function conditionOf(db: Db | Tx, admissionId: string) {
  return (await db.select().from(ipdAdmissionConditions).where(eq(ipdAdmissionConditions.admissionId, admissionId)))[0];
}

async function patientFacts(db: Db | Tx, patientId: string) {
  return (await db.select({
    name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential, sealed: patients.sensitiveContext,
  }).from(patients).where(eq(patients.id, patientId)))[0];
}

/** Why the family link is off for this admission right now, or null. The public side calls it on every read too. */
export async function familyBlockOf(db: Db | Tx, a: AdmissionRow): Promise<Exclude<Blocked, "no_attendant_phone" | "stay_ended"> | null> {
  const p = await patientFacts(db, a.patientId);
  if (p === undefined || p.sealed) return "sealed";
  if (a.mlc) return "mlc";
  const c = await conditionOf(db, a.id);
  if (c?.familyOffReason != null) return "family_off";
  return null;
}

async function liveLink(db: Db | Tx, admissionId: string) {
  return (await db.select().from(ipdFamilyLinks).where(and(eq(ipdFamilyLinks.admissionId, admissionId), eq(ipdFamilyLinks.status, "active"))))[0];
}

type RevokeReason = "deceased" | "absconded" | "reissued" | "family_off" | "sealed" | "desk";

async function revokeIn(tx: Tx, link: typeof ipdFamilyLinks.$inferSelect, reason: RevokeReason, actor: Actor, now: Date): Promise<void> {
  await tx.update(ipdFamilyLinks).set({ status: "revoked", revokedAt: now, revokedReason: reason, revokedBy: actor.id })
    .where(and(eq(ipdFamilyLinks.id, link.id), eq(ipdFamilyLinks.status, "active")));
  await appendEvent(tx, familyLinkRevoked.make({
    actor, occurredAt: now, correlationId: link.admissionId, patientId: link.patientId,
    payload: { admissionId: link.admissionId, linkId: link.id, reason, provenance: actor.type === "system" ? "system" : "person" },
  }));
}

/** Issue (or re-issue) the family link for an admission. The token is answered once and kept only as a hash. */
export async function issueFamilyLink(
  db: Db, actor: Actor, admissionId: string, input: IpdIssueFamilyLink, opts: { now?: Date; secretKey: Buffer },
): Promise<IpdFamilyLinkIssued> {
  await requireIpdPermission(db, actor, IPD_FAMILY_ISSUE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, admissionId);
    const a = await readAdmission(tx, admissionId);
    if (!OPEN_STATES.includes(a.state) || a.admittedAt === null) {
      throw new IpdError("family_link_refused", "The family link is only for a patient in a bed; this stay has not started or has ended.", { reason: "stay_ended" });
    }
    const blocked = await familyBlockOf(tx, a);
    if (blocked !== null) {
      throw new IpdError("family_link_refused", BLOCK_WORDS[blocked], { reason: blocked });
    }
    const to = await attendantOf(tx, a.patientId, a.id);
    if (to === null) {
      throw new IpdError("family_link_refused", BLOCK_WORDS.no_attendant_phone, { reason: "no_attendant_phone" });
    }
    const old = await liveLink(tx, a.id);
    if (old !== undefined) await revokeIn(tx, old, "reissued", actor, now);
    const token = randomBytes(32).toString("base64url");
    const phone = normalisePhone(to.phone);
    const linkId = newId();
    await tx.insert(ipdFamilyLinks).values({
      id: linkId, admissionId: a.id, patientId: a.patientId, tokenHash: sha256(token), attendantKind: to.kind, attendantRef: to.ref,
      phoneHash: familyPhoneDigest(opts.secretKey, phone), phoneMasked: maskPhone(phone), purpose: IPD_FAMILY_PURPOSE, consent: input.consent, status: "active",
      issuedBy: actor.id, issuedAt: now,
    });
    await appendEvent(tx, familyLinkIssued.make({
      actor, occurredAt: now, correlationId: a.id, patientId: a.patientId,
      payload: { admissionId: a.id, linkId, attendantKind: to.kind, relation: input.consent.relation, method: input.consent.method, provenance: "person" },
    }));
    // The token rides in the FRAGMENT: a browser never sends it to the server, so no access log can keep it (#764).
    return { linkId, path: `/family#${token}`, phoneMasked: maskPhone(phone) };
  });
}

const BLOCK_WORDS: Record<Exclude<Blocked, null>, string> = {
  sealed: "The family link is off for a sealed patient. Give updates in person at the ward desk.",
  mlc: "The family link is off for a medico-legal admission. Give updates in person at the ward desk.",
  family_off: "The treating team turned the family link off for this admission.",
  no_attendant_phone: "No registered attendant phone. Record a guardian with bill authority and a phone, or the deposit payer's phone.",
  stay_ended: "The family link is only for a patient in a bed.",
};

export async function revokeFamilyLink(db: Db, actor: Actor, linkId: string, opts: { now?: Date } = {}): Promise<{ revoked: boolean }> {
  await requireIpdPermission(db, actor, IPD_FAMILY_ISSUE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const link = (await tx.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.id, linkId)))[0];
    if (link === undefined) throw new IpdError("family_link_not_found", "No family link has this id.");
    await admissionAdvisoryLock(tx, link.admissionId);
    if (link.status !== "active") return { revoked: false };
    await revokeIn(tx, link, "desk", actor, now);
    return { revoked: true };
  });
}

/** The treating team's condition word and the family-link switch. Turning the link off revokes a live link. */
export async function setCondition(
  db: Db, actor: Actor, admissionId: string, input: IpdSetCondition, opts: { now?: Date } = {},
): Promise<{ word: IpdConditionWord | null; familyOff: string | null }> {
  await requireIpdPermission(db, actor, IPD_CONDITION_SET);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    await admissionAdvisoryLock(tx, admissionId);
    const a = await readAdmission(tx, admissionId);
    if (!OPEN_STATES.includes(a.state)) {
      throw new IpdError("family_link_refused", "The condition is set only while the patient is in a bed.", { reason: "stay_ended" });
    }
    const prev = await conditionOf(tx, a.id);
    const off = input.familyOff === undefined ? prev?.familyOffReason ?? null : input.familyOff;
    const offChanged = off !== (prev?.familyOffReason ?? null);
    const wordChanged = input.word !== (prev?.word ?? null);
    const row = {
      admissionId: a.id, word: input.word,
      setBy: wordChanged ? actor.id : prev?.setBy ?? null, setAt: wordChanged ? now : prev?.setAt ?? null,
      familyOffReason: off, familyOffBy: offChanged ? actor.id : prev?.familyOffBy ?? null,
      familyOffAt: offChanged ? (off === null ? null : now) : prev?.familyOffAt ?? null, updatedAt: now,
    };
    await tx.insert(ipdAdmissionConditions).values(row).onConflictDoUpdate({ target: ipdAdmissionConditions.admissionId, set: row });
    if (off !== null && offChanged) {
      const link = await liveLink(tx, a.id);
      if (link !== undefined) await revokeIn(tx, link, "family_off", actor, now);
    }
    if (wordChanged || offChanged) {
      await appendEvent(tx, conditionSet.make({
        actor, occurredAt: now, correlationId: a.id, patientId: a.patientId,
        payload: { admissionId: a.id, word: input.word, familyOff: off, provenance: "person" },
      }));
    }
    return { word: input.word, familyOff: off };
  });
}

async function callbackRows(db: Db, actor: Actor, where: ReturnType<typeof eq> | ReturnType<typeof and>): Promise<IpdFamilyCallback[]> {
  const rows = await db.select({
    id: ipdFamilyCallbacks.id, admissionId: ipdFamilyCallbacks.admissionId, text: ipdFamilyCallbacks.text, status: ipdFamilyCallbacks.status,
    createdAt: ipdFamilyCallbacks.createdAt, closedAt: ipdFamilyCallbacks.closedAt, closedBy: ipdFamilyCallbacks.closedBy, note: ipdFamilyCallbacks.note,
    phoneMasked: ipdFamilyLinks.phoneMasked, patientId: ipdFamilyLinks.patientId,
    sealed: patients.sensitiveContext, confidential: patients.isConfidential,
  }).from(ipdFamilyCallbacks).innerJoin(ipdFamilyLinks, eq(ipdFamilyLinks.id, ipdFamilyCallbacks.linkId))
    .innerJoin(patients, eq(patients.id, ipdFamilyLinks.patientId))
    .where(where).orderBy(asc(ipdFamilyCallbacks.createdAt)).limit(200);
  if (rows.length === 0) return [];
  const people = new Map((await getPatientSummaries(db, actor, rows.map((r) => r.patientId))).map((p) => [p.id, p] as const));
  const names = await userNames(db, rows.flatMap((r) => (r.closedBy === null ? [] : [r.closedBy])));
  const beds = new Map<string, { code: string; wardName: string | null } | null>();
  for (const admissionId of new Set(rows.map((r) => r.admissionId))) {
    const stay = (await db.select({ bedId: ipdBedStays.bedId }).from(ipdBedStays).where(eq(ipdBedStays.admissionId, admissionId))
      .orderBy(desc(ipdBedStays.startedAt)).limit(1))[0];
    beds.set(admissionId, stay === undefined ? null : await bedWithWard(db, stay.bedId));
  }
  return rows.map((r) => {
    const p = people.get(r.patientId);
    // Review #764: a SEALED patient (D-31) shows no name, bed or ward ("Sealed patient" on the screen); a CONFIDENTIAL one
    // keeps the alias rule and shows no bed or ward. `restricted` alone tracks only `isConfidential`.
    const privacy = r.sealed ? "sealed" as const : r.confidential ? "confidential" as const : null;
    const bed = privacy === null ? beds.get(r.admissionId) ?? null : null;
    return {
      id: r.id, admissionId: r.admissionId, patientName: privacy === "sealed" || p === undefined ? null : p.restricted ? p.alias : p.name,
      bedCode: bed?.code ?? null, wardName: bed?.wardName ?? null, privacy, text: r.text, phoneMasked: r.phoneMasked,
      status: r.status as "open" | "done", createdAt: r.createdAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null,
      closedBy: r.closedBy === null ? null : names.get(r.closedBy) ?? r.closedBy, note: r.note,
    };
  });
}

/** The ward desk's list: open callbacks first-come first-served (`status: "done"` for the day's closed ones). */
export async function listFamilyCallbacks(db: Db, actor: Actor, opts: { status?: "open" | "done" } = {}): Promise<IpdFamilyCallbackList> {
  await requireIpdPermission(db, actor, IPD_FAMILY_ISSUE);
  return { rows: await callbackRows(db, actor, eq(ipdFamilyCallbacks.status, opts.status ?? "open")) };
}

export async function closeFamilyCallback(db: Db, actor: Actor, callbackId: string, note: string, opts: { now?: Date } = {}): Promise<{ closed: boolean }> {
  await requireIpdPermission(db, actor, IPD_FAMILY_ISSUE);
  const now = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const cb = (await tx.select().from(ipdFamilyCallbacks).where(eq(ipdFamilyCallbacks.id, callbackId)))[0];
    if (cb === undefined) throw new IpdError("family_callback_not_found", "No callback request has this id.");
    await admissionAdvisoryLock(tx, cb.admissionId);
    // Review #764: the close is the conditional UPDATE itself; only the call that moved the row writes the event.
    const moved = await tx.update(ipdFamilyCallbacks).set({ status: "done", closedAt: now, closedBy: actor.id, note })
      .where(and(eq(ipdFamilyCallbacks.id, cb.id), eq(ipdFamilyCallbacks.status, "open"))).returning({ id: ipdFamilyCallbacks.id });
    if (moved.length === 0) return { closed: false };
    const a = await readAdmission(tx, cb.admissionId);
    await appendEvent(tx, familyCallbackClosed.make({
      actor, occurredAt: now, correlationId: cb.admissionId, patientId: a.patientId,
      payload: { admissionId: cb.admissionId, callbackId: cb.id, provenance: "person" },
    }));
    return { closed: true };
  });
}

/** The panel on the discharge desk (any viewer holding `ipd.family.issue` or `ipd.condition.set`). */
export async function readFamilyPanel(db: Db, actor: Actor, admissionId: string): Promise<IpdFamilyPanel> {
  const [mIssue, mCondition] = await Promise.all([holdsPermission(db, actor, IPD_FAMILY_ISSUE), holdsPermission(db, actor, IPD_CONDITION_SET)]);
  if (!mIssue && !mCondition) throw new IpdError("ipd_forbidden", `this view needs ${IPD_FAMILY_ISSUE} or ${IPD_CONDITION_SET}`, { permission: IPD_FAMILY_ISSUE });
  const a = await readAdmission(db, admissionId);
  const c = await conditionOf(db, a.id);
  const open = OPEN_STATES.includes(a.state) && a.admittedAt !== null;
  const block = await familyBlockOf(db, a);
  const to = await attendantOf(db, a.patientId, a.id);
  const blocked: Blocked = !open ? "stay_ended" : block ?? (to === null ? "no_attendant_phone" : null);
  const link = (await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.admissionId, a.id)).orderBy(desc(ipdFamilyLinks.issuedAt)).limit(1))[0];
  const names = await userNames(db, c?.setBy == null ? [] : [c.setBy]);
  return {
    admissionId: a.id,
    condition: {
      word: (c?.word ?? null) as IpdConditionWord | null, setAt: c?.setAt?.toISOString() ?? null,
      setBy: c?.setBy == null ? null : names.get(c.setBy) ?? c.setBy,
    },
    familyOff: (c?.familyOffReason ?? null) as IpdFamilyPanel["familyOff"],
    blocked,
    link: link === undefined ? null : {
      id: link.id, status: link.status as "active" | "revoked" | "expired", phoneMasked: link.phoneMasked,
      issuedAt: link.issuedAt.toISOString(), revokedReason: link.revokedReason,
    },
    attendantPhoneMasked: to === null ? null : maskPhone(normalisePhone(to.phone)),
    callbacks: mIssue ? await callbackRows(db, actor, eq(ipdFamilyCallbacks.admissionId, a.id)) : [],
    can: {
      issue: mIssue && blocked === null,
      revoke: mIssue && link?.status === "active",
      setCondition: mCondition && open,
      closeCallback: mIssue,
    },
  };
}

// ═══════════════════════════════════════ the stops: death and absconding ═══════════════════════════════════════

/** Revoke the live link of an admission that ended in death or absconding. Idempotent by event id. */
export async function handleFamilyStop(tx: Tx, eventId: string, name: string, payload: unknown): Promise<{ handled: boolean; revoked: boolean }> {
  const claimed = await tx.insert(eventIdempotency).values({ idempotencyKey: `${IPD_FAMILY_STOP_CONSUMER}:${eventId}`, eventId })
    .onConflictDoNothing({ target: eventIdempotency.idempotencyKey }).returning({ eventId: eventIdempotency.eventId });
  if (claimed.length === 0) return { handled: false, revoked: false };
  if (name === patientUpdated.name) return { handled: true, revoked: await revokeOnSeal(tx, payload) };
  const reason: RevokeReason | null = name === admissionDeceased.name ? "deceased" : name === admissionAbsconded.name ? "absconded" : null;
  const admissionId = (payload as { admissionId?: unknown } | null)?.admissionId;
  if (reason === null || typeof admissionId !== "string") return { handled: true, revoked: false };
  await admissionAdvisoryLock(tx, admissionId);
  const link = await liveLink(tx, admissionId);
  if (link === undefined) return { handled: true, revoked: false };
  await revokeIn(tx, link, reason, SYSTEM, new Date());
  return { handled: true, revoked: true };
}

/**
 * Review #764 — a patient SEALED after the link was issued (`patient.updated` with `sensitiveContext` → true): every live
 * link of that patient is revoked on that path. The public side's read-time block stays as the belt. (An admission's MLC
 * flag is set only at admission, when the issue refuses, so it has no later path to watch.)
 */
async function revokeOnSeal(tx: Tx, payload: unknown): Promise<boolean> {
  const p = payload as { patientId?: unknown; changes?: { field?: unknown; to?: unknown }[] } | null;
  if (typeof p?.patientId !== "string" || !Array.isArray(p.changes)) return false;
  if (!p.changes.some((c) => c.field === "sensitiveContext" && c.to === "true")) return false;
  const live = await tx.select().from(ipdFamilyLinks).where(and(eq(ipdFamilyLinks.patientId, p.patientId), eq(ipdFamilyLinks.status, "active")));
  for (const link of live) {
    await admissionAdvisoryLock(tx, link.admissionId);
    await revokeIn(tx, link, "sealed", SYSTEM, new Date());
  }
  return live.length > 0;
}

export function familyStopConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== admissionDeceased.name && e.name !== admissionAbsconded.name && e.name !== patientUpdated.name) return;
    await withTx(db, (tx) => handleFamilyStop(tx, e.eventId, e.name, e.payload));
  };
}

// ═══════════════════════════════════════ the ward desk's Now card ═══════════════════════════════════════

/** Open callback requests for the ward desk (`ipd.family.issue`). Admission numbers, never names or the question. */
export async function familyCallbacksCard(db: Db): Promise<DeskCard[]> {
  const [n] = await db.select({ n: count() }).from(ipdFamilyCallbacks).where(eq(ipdFamilyCallbacks.status, "open"));
  if ((n?.n ?? 0) === 0) return [];
  const rows = await db.select({ id: ipdFamilyCallbacks.id, admissionNo: ipdAdmissions.admissionNo, createdAt: ipdFamilyCallbacks.createdAt })
    .from(ipdFamilyCallbacks).innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdFamilyCallbacks.admissionId))
    .where(and(eq(ipdFamilyCallbacks.status, "open"), inArray(ipdAdmissions.state, [...IPD_LADDER_STATES, "discharged", "transferred_out"])))
    .orderBy(asc(ipdFamilyCallbacks.createdAt)).limit(5);
  return [{
    key: "ipd.family_callbacks", band: "now", titleKey: "desk.ipdFamilyCallbacks.title",
    stats: [{ key: "desk.ipdFamilyCallbacks.open", value: String(n?.n ?? 0), href: "/ipd/family-callbacks" }],
    rows: rows.map((r) => ({
      id: r.id, badge: "☎", title: r.admissionNo ?? "—", subtitle: "Family asked for a call",
      action: "Open", href: "/ipd/family-callbacks", severity: "warn",
    })),
  }];
}
