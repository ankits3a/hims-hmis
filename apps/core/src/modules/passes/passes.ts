import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { PASS_INTENTS, newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { istDayWindow } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { passAdmissionFlags, passEvents, passes } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withIdempotency } from "../billing";
import { admissionPlace, ageInYears } from "../ipd";
import { getPatientSummaries } from "../patients";
import { PassForbidden, PassRefusal } from "./errors";
import { passCustodySet, passRevoked, passesExpired, passesIssued, passesMoved, passesPaused, passesResumed } from "./events";
import { PASSES_ISSUE, PASSES_MANAGE, PASSES_PAUSE } from "./manifest";
import { ENTITLEMENT_KINDS, PASS_CRITICAL_CLASSES, entitlementFor, inVisitingHours } from "./policy";
import type { Actor, PassEndReason, PassHolder, PassIntentName, PassKind } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionPlace } from "../ipd";

/**
 * E1.3 (#720) — THE PASS INTENTS. Each one: parse the contract's zod input → re-check the permission → run once per
 * idempotency key → take the admission's pass lock → re-read the facts (where the patient lies, custody, the ban) →
 * write rows + `pass_events` + one domain event, in ONE transaction. A refusal is `PassRefusal` (code, rule, fix).
 *
 * THE LOCK is a transaction-scoped advisory lock on `passes:<admissionId>`: two desks issuing at once cannot both take
 * the last entitled pass, and the expiry consumer cannot interleave with an issue.
 */

export type PassRow = typeof passes.$inferSelect;
type Opts = { now?: Date };
type In<N extends PassIntentName> = ReturnType<(typeof PASS_INTENTS)[N]["parse"]>;

const LIVE_STATES = ["active", "paused"] as const;
/** The viewer a pass card is rendered for: nobody in particular — a sealed patient prints as the alias. */
const PASS_CARD_VIEWER: Actor = { type: "agent", id: "passes-card" };
export const PASSES_SYSTEM_ACTOR: Actor = { type: "system", id: "passes-expiry" };

async function holds(db: Db, actor: Actor, permission: string): Promise<boolean> {
  if (actor.type === "system") return true;
  return hasPermission(db, actor.id, permission, "hospital");
}
async function requirePermission(db: Db, actor: Actor, permission: string): Promise<void> {
  if (!(await holds(db, actor, permission))) throw new PassForbidden(permission);
}
function once<T>(db: Db, actor: Actor, intent: PassIntentName, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `passes:${intent}`, key: key.toLowerCase() }, body, work, now);
}

/** 24 random bytes, base64url: 32 characters, the QR's whole payload. Never derived from anything about the patient. */
export function newPassToken(): string {
  return randomBytes(24).toString("base64url");
}

async function lockPasses(tx: Tx, admissionId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`passes:${admissionId}`}))`);
}

async function placeOf(tx: Tx | Db, admissionId: string): Promise<AdmissionPlace> {
  const place = await admissionPlace(tx, admissionId);
  if (place === null) throw new PassRefusal("admission_not_found");
  return place;
}
async function placedOf(tx: Tx, admissionId: string): Promise<AdmissionPlace> {
  const place = await placeOf(tx, admissionId);
  if (!place.placed) throw new PassRefusal("admission_not_placed", { state: place.state });
  return place;
}

export type Flags = { policeCustody: boolean; visitorBanReason: string | null; visitorBanAt: Date | null };
export async function flagsOf(db: Db | Tx, admissionId: string): Promise<Flags> {
  const f = (await db.select().from(passAdmissionFlags).where(eq(passAdmissionFlags.admissionId, admissionId)))[0];
  return { policeCustody: f?.policeCustody ?? false, visitorBanReason: f?.visitorBanReason ?? null, visitorBanAt: f?.visitorBanAt ?? null };
}
async function writeFlags(tx: Tx, admissionId: string, actor: Actor, at: Date, set: Partial<typeof passAdmissionFlags.$inferInsert>): Promise<void> {
  await tx.insert(passAdmissionFlags).values({ admissionId, updatedBy: actor.id, updatedAt: at, ...set })
    .onConflictDoUpdate({ target: passAdmissionFlags.admissionId, set: { ...set, updatedBy: actor.id, updatedAt: at } });
}

/** The patient's line on a pass: the name, or for a sealed / VIP patient the alias — never the name. */
export async function patientFacts(db: Db, patientId: string, at: Date): Promise<{ label: string; uhid: string | null; ageYears: number | null }> {
  const s = (await getPatientSummaries(db, PASS_CARD_VIEWER, [patientId]))[0];
  if (s === undefined) return { label: "Patient", uhid: null, ageYears: null };
  const label = s.restricted ? (s.alias ?? "Restricted record") : (s.name ?? "Patient");
  return { label, uhid: s.uhid, ageYears: ageInYears(s.dob, at) };
}

async function liveCount(tx: Tx, admissionId: string, kinds: readonly PassKind[], at?: Date): Promise<number> {
  const rows = await tx.select({ id: passes.id }).from(passes).where(and(
    eq(passes.admissionId, admissionId), inArray(passes.kind, [...kinds]), inArray(passes.state, [...LIVE_STATES]),
    ...(at === undefined ? [] : [or(isNull(passes.validTo), gt(passes.validTo, at))]),
  ));
  return rows.length;
}

async function logEvent(
  tx: Tx, actor: Actor, at: Date, admissionId: string, kind: typeof passEvents.$inferInsert["kind"], passId: string | null,
  reason: string | null = null, detail: Record<string, unknown> | null = null,
): Promise<void> {
  await tx.insert(passEvents).values({ id: newId(), passId, admissionId, kind, reason, detail, actorId: actor.id, at });
}

type NewPass = {
  admissionId: string; kind: PassKind; holder: PassHolder; wardId: string | null; validFrom: Date; validTo: Date | null;
  linkedAdmissionId?: string | null; replaces?: string | null; state?: "active" | "paused"; pauseReason?: string | null;
};
async function insertPass(tx: Tx, actor: Actor, at: Date, p: NewPass): Promise<PassRow> {
  const row: typeof passes.$inferInsert = {
    id: newId(), admissionId: p.admissionId, linkedAdmissionId: p.linkedAdmissionId ?? null, kind: p.kind,
    holderName: p.holder.name, holderPhone: p.holder.phone ?? null, holderRelation: p.holder.relation, token: newPassToken(),
    wardId: p.wardId, validFrom: p.validFrom, validTo: p.validTo, state: p.state ?? "active", pauseReason: p.pauseReason ?? null,
    replaces: p.replaces ?? null, issuedBy: actor.id, issuedAt: at,
  };
  const [inserted] = await tx.insert(passes).values(row).returning();
  await logEvent(tx, actor, at, p.admissionId, "issued", inserted!.id, null, { kind: p.kind });
  return inserted!;
}

// ═══════════════════════════════════════════ issue ═══════════════════════════════════════════

/**
 * Issue the entitled passes at or after admission (§8). The kind defaults to the entitled one: police guard in custody,
 * lounge on a critical-care bed, parent stay for a child, attendant otherwise. Never more live than the class allows;
 * a lost pass is REISSUED, which revokes the old one, rather than issued again.
 */
export async function issuePasses(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ passIds: string[] }> {
  const input: In<"issue_passes"> = PASS_INTENTS.issue_passes.parse(raw);
  await requirePermission(db, actor, PASSES_ISSUE);
  const at = opts.now ?? new Date();
  return once(db, actor, "issue_passes", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await lockPasses(tx, input.admissionId);
    const place = await placedOf(tx, input.admissionId);
    const flags = await flagsOf(tx, place.admissionId);
    if (input.kind === "nicu_mother") return issueNicuMother(tx, actor, at, place, flags, input);
    const { ageYears } = await patientFacts(db, place.patientId, at);
    const ent = entitlementFor({ bedClass: place.bedClass, ageYears, policeCustody: flags.policeCustody });
    const kind = input.kind ?? ent.kind;
    if (flags.policeCustody && kind !== "police_guard") throw new PassRefusal("police_custody_guard_only");
    if (!flags.policeCustody && kind === "police_guard") throw new PassRefusal("not_in_police_custody");
    if (kind !== ent.kind) {
      if ((kind === "attendant" || kind === "parent_stay") && PASS_CRITICAL_CLASSES.has(place.bedClass ?? "")) {
        throw new PassRefusal("icu_no_bedside_pass", { entitled: ent.kind, basis: ent.basis });
      }
      throw new PassRefusal("kind_not_entitled", { entitled: ent.kind, basis: ent.basis });
    }
    const live = await liveCount(tx, place.admissionId, ENTITLEMENT_KINDS);
    if (live + input.holders.length > ent.max) {
      throw new PassRefusal("entitlement_used", { max: ent.max, live, basis: ent.basis });
    }
    const ids: string[] = [];
    for (const holder of input.holders) {
      ids.push((await insertPass(tx, actor, at, { admissionId: place.admissionId, kind, holder, wardId: place.wardId, validFrom: at, validTo: null })).id);
    }
    await appendEvent(tx, passesIssued.make({
      payload: { admissionId: place.admissionId, passIds: ids, kind }, actor, correlationId: place.admissionId,
      patientId: place.patientId, occurredAt: at,
    }));
    return { passIds: ids };
  }), at);
}

/** The mother's pass to her baby's NICU (§8): linked by the baby's admission id, entered by hand; one live at a time. */
async function issueNicuMother(
  tx: Tx, actor: Actor, at: Date, mother: AdmissionPlace, flags: Flags, input: In<"issue_passes">,
): Promise<{ passIds: string[] }> {
  if (flags.policeCustody) throw new PassRefusal("police_custody_guard_only");
  if (input.babyAdmissionId === undefined) throw new PassRefusal("baby_admission_required");
  const baby = await admissionPlace(tx, input.babyAdmissionId);
  if (baby === null || !baby.placed || baby.bedClass !== "nicu") {
    throw new PassRefusal("baby_not_in_nicu", { babyAdmissionId: input.babyAdmissionId, babyBedClass: baby?.bedClass ?? null });
  }
  if (input.holders.length !== 1 || (await liveCount(tx, mother.admissionId, ["nicu_mother"])) > 0) {
    throw new PassRefusal("entitlement_used", { max: 1, basis: "NICU mother: 1 pass" });
  }
  const p = await insertPass(tx, actor, at, {
    admissionId: mother.admissionId, kind: "nicu_mother", holder: input.holders[0]!, wardId: baby.wardId, validFrom: at,
    validTo: null, linkedAdmissionId: baby.admissionId,
  });
  await appendEvent(tx, passesIssued.make({
    payload: { admissionId: mother.admissionId, passIds: [p.id], kind: "nicu_mother" }, actor, correlationId: mother.admissionId,
    patientId: mother.patientId, occurredAt: at,
  }));
  return { passIds: [p.id] };
}

/** A visitor pass: only inside visiting hours, at most two live, valid until the end of that IST day. */
export async function issueVisitorPass(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ passIds: string[] }> {
  const input: In<"issue_visitor_pass"> = PASS_INTENTS.issue_visitor_pass.parse(raw);
  await requirePermission(db, actor, PASSES_ISSUE);
  const at = opts.now ?? new Date();
  return once(db, actor, "issue_visitor_pass", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await lockPasses(tx, input.admissionId);
    const place = await placedOf(tx, input.admissionId);
    const flags = await flagsOf(tx, place.admissionId);
    if (flags.policeCustody) throw new PassRefusal("police_custody_guard_only");
    if (flags.visitorBanReason !== null) throw new PassRefusal("visitors_banned", { reason: flags.visitorBanReason });
    if (!inVisitingHours(at)) throw new PassRefusal("outside_visiting_hours");
    const live = await liveCount(tx, place.admissionId, ["visitor"], at);
    if (live >= 2) throw new PassRefusal("visitor_limit", { live, max: 2 });
    const p = await insertPass(tx, actor, at, {
      admissionId: place.admissionId, kind: "visitor", holder: input.holder, wardId: place.wardId, validFrom: at,
      validTo: istDayWindow(at).end,
    });
    await appendEvent(tx, passesIssued.make({
      payload: { admissionId: place.admissionId, passIds: [p.id], kind: "visitor" }, actor, correlationId: place.admissionId,
      patientId: place.patientId, occurredAt: at,
    }));
    return { passIds: [p.id] };
  }), at);
}

// ═══════════════════════════════════════════ reissue ═══════════════════════════════════════════

/** Lost, damaged or a new holder: the old pass is revoked in the SAME transaction the new one is written. */
export async function reissuePass(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ passId: string; revokedPassId: string }> {
  const input: In<"reissue_pass"> = PASS_INTENTS.reissue_pass.parse(raw);
  await requirePermission(db, actor, PASSES_ISSUE);
  const at = opts.now ?? new Date();
  return once(db, actor, "reissue_pass", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const first = (await tx.select({ admissionId: passes.admissionId }).from(passes).where(eq(passes.id, input.passId)))[0];
    if (first === undefined) throw new PassRefusal("pass_not_found");
    await lockPasses(tx, first.admissionId);
    const old = (await tx.select().from(passes).where(eq(passes.id, input.passId)).for("update"))[0]!;
    if (old.state !== "active" && old.state !== "paused") throw new PassRefusal("pass_not_live", { state: old.state });
    if (old.validTo !== null && at.getTime() >= old.validTo.getTime()) throw new PassRefusal("pass_not_live", { state: "expired" });
    const place = await placedOf(tx, old.admissionId);
    const holder: PassHolder = input.holder ?? {
      name: old.holderName, relation: old.holderRelation, ...(old.holderPhone === null ? {} : { phone: old.holderPhone }),
    };
    const fresh = await insertPass(tx, actor, at, {
      admissionId: old.admissionId, kind: old.kind as PassKind, holder, wardId: old.wardId, validFrom: at, validTo: old.validTo,
      linkedAdmissionId: old.linkedAdmissionId, replaces: old.id, state: old.state as "active" | "paused", pauseReason: old.pauseReason,
    });
    await tx.update(passes).set({ state: "revoked", endReason: input.reason, endedAt: at, endedBy: actor.id, replacedBy: fresh.id })
      .where(eq(passes.id, old.id));
    await logEvent(tx, actor, at, old.admissionId, "revoked", old.id, input.reason, { replacedBy: fresh.id });
    await appendEvent(tx, passRevoked.make({
      payload: { admissionId: old.admissionId, passId: old.id, reason: input.reason, replacedBy: fresh.id }, actor,
      correlationId: old.admissionId, patientId: place.patientId, occurredAt: at,
    }));
    return { passId: fresh.id, revokedPassId: old.id };
  }), at);
}

// ═══════════════════════════════════════════ pause / resume / custody ═══════════════════════════════════════════

/**
 * The doctor's visitor ban (scope `visitors`, passes.pause): live visitor passes pause with the reason and new visitor
 * passes are refused until resumed. Scope `all` pauses every live pass and needs passes.manage.
 */
export async function pausePasses(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ pausedPassIds: string[] }> {
  const input: In<"pause_passes"> = PASS_INTENTS.pause_passes.parse(raw);
  const manager = await holds(db, actor, PASSES_MANAGE);
  if (!manager) {
    await requirePermission(db, actor, PASSES_PAUSE);
    if (input.scope === "all") throw new PassRefusal("pause_needs_manage");
  }
  const at = opts.now ?? new Date();
  return once(db, actor, "pause_passes", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await lockPasses(tx, input.admissionId);
    const place = await placeOf(tx, input.admissionId);
    const kinds = input.scope === "visitors" ? [eq(passes.kind, "visitor")] : [];
    const rows = await tx.update(passes).set({ state: "paused", pauseReason: input.reason })
      .where(and(eq(passes.admissionId, place.admissionId), eq(passes.state, "active"), ...kinds)).returning({ id: passes.id });
    const ids = rows.map((r) => r.id);
    for (const passId of ids) await logEvent(tx, actor, at, place.admissionId, "paused", passId, input.reason, { scope: input.scope });
    await writeFlags(tx, place.admissionId, actor, at, { visitorBanReason: input.reason, visitorBanBy: actor.id, visitorBanAt: at });
    await appendEvent(tx, passesPaused.make({
      payload: { admissionId: place.admissionId, passIds: ids, scope: input.scope }, actor, correlationId: place.admissionId,
      patientId: place.patientId, occurredAt: at,
    }));
    return { pausedPassIds: ids };
  }), at);
}

/** Lifts the ban: a doctor (passes.pause) resumes visitor passes; the manager resumes every paused pass. */
export async function resumePasses(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ resumedPassIds: string[] }> {
  const input: In<"resume_passes"> = PASS_INTENTS.resume_passes.parse(raw);
  const manager = await holds(db, actor, PASSES_MANAGE);
  if (!manager) await requirePermission(db, actor, PASSES_PAUSE);
  const at = opts.now ?? new Date();
  return once(db, actor, "resume_passes", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await lockPasses(tx, input.admissionId);
    const place = await placeOf(tx, input.admissionId);
    const flags = await flagsOf(tx, place.admissionId);
    const kinds = manager ? [] : [eq(passes.kind, "visitor")];
    const rows = await tx.update(passes).set({ state: "active", pauseReason: null })
      .where(and(eq(passes.admissionId, place.admissionId), eq(passes.state, "paused"), ...kinds)).returning({ id: passes.id });
    if (rows.length === 0 && flags.visitorBanReason === null) throw new PassRefusal("nothing_paused");
    const ids = rows.map((r) => r.id);
    for (const passId of ids) await logEvent(tx, actor, at, place.admissionId, "resumed", passId, input.note ?? null);
    await writeFlags(tx, place.admissionId, actor, at, { visitorBanReason: null, visitorBanBy: null, visitorBanAt: null });
    await appendEvent(tx, passesResumed.make({
      payload: { admissionId: place.admissionId, passIds: ids }, actor, correlationId: place.admissionId,
      patientId: place.patientId, occurredAt: at,
    }));
    return { resumedPassIds: ids };
  }), at);
}

/**
 * Police custody (§8 edge case): only police guard passes. Setting it revokes every other live pass at once; clearing
 * it revokes the guards' passes. DECIDED: custody is recorded here, by the passes manager, because the admission
 * record has no custody field yet (MLC is not custody).
 */
export async function setPoliceCustody(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ policeCustody: boolean; revokedPassIds: string[] }> {
  const input: In<"set_police_custody"> = PASS_INTENTS.set_police_custody.parse(raw);
  await requirePermission(db, actor, PASSES_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "set_police_custody", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    await lockPasses(tx, input.admissionId);
    const place = await placeOf(tx, input.admissionId);
    const which = input.custody ? ne(passes.kind, "police_guard") : eq(passes.kind, "police_guard");
    const rows = await tx.update(passes).set({ state: "revoked", endReason: "police_custody", endedAt: at, endedBy: actor.id })
      .where(and(eq(passes.admissionId, place.admissionId), inArray(passes.state, [...LIVE_STATES]), which)).returning({ id: passes.id });
    const ids = rows.map((r) => r.id);
    for (const passId of ids) await logEvent(tx, actor, at, place.admissionId, "revoked", passId, "police_custody");
    await writeFlags(tx, place.admissionId, actor, at, { policeCustody: input.custody, custodyNote: input.note });
    await logEvent(tx, actor, at, place.admissionId, input.custody ? "custody_set" : "custody_cleared", null, input.note);
    await appendEvent(tx, passCustodySet.make({
      payload: { admissionId: place.admissionId, custody: input.custody, revokedPassIds: ids }, actor,
      correlationId: place.admissionId, patientId: place.patientId, occurredAt: at,
    }));
    return { policeCustody: input.custody, revokedPassIds: ids };
  }), at);
}

// ═══════════════════════════════════════════ the consumer's acts ═══════════════════════════════════════════

/**
 * EXPIRE EVERY LIVE PASS OF AN ADMISSION AT ONCE (§8, done means): one transaction, under the admission's pass lock.
 * A NICU mother pass linked to this admission (the baby) expires with it. Idempotent: a second call finds nothing live
 * and writes nothing — the dispatcher delivers at least once.
 */
export async function expireAdmissionPasses(
  db: Db, args: { admissionId: string; reason: PassEndReason; at: Date; causationEvent?: string | null; actor?: Actor },
): Promise<{ expiredPassIds: string[] }> {
  const actor = args.actor ?? PASSES_SYSTEM_ACTOR;
  return withTx(db, async (tx) => {
    await lockPasses(tx, args.admissionId);
    const rows = await tx.select().from(passes).where(and(
      or(eq(passes.admissionId, args.admissionId), eq(passes.linkedAdmissionId, args.admissionId)),
      inArray(passes.state, [...LIVE_STATES]),
    )).for("update");
    if (rows.length === 0) return { expiredPassIds: [] };
    const byAdmission = new Map<string, string[]>();
    for (const r of rows) {
      const reason = r.admissionId === args.admissionId ? args.reason : "baby_discharged";
      await tx.update(passes).set({ state: "expired", endReason: reason, endedAt: args.at, endedBy: actor.id }).where(eq(passes.id, r.id));
      await logEvent(tx, actor, args.at, r.admissionId, "expired", r.id, reason, { causationEvent: args.causationEvent ?? null });
      byAdmission.set(r.admissionId, [...(byAdmission.get(r.admissionId) ?? []), r.id]);
    }
    for (const [admissionId, passIds] of byAdmission) {
      await appendEvent(tx, passesExpired.make({
        payload: { admissionId, passIds, reason: admissionId === args.admissionId ? args.reason : "baby_discharged", causationEvent: args.causationEvent ?? null },
        actor, correlationId: admissionId, occurredAt: args.at,
      }));
    }
    return { expiredPassIds: rows.map((r) => r.id) };
  });
}

/**
 * A ward transfer accepted: the admission's live passes now open the NEW ward (read live from IPD, so the event's
 * payload shape does not matter). A NICU mother pass follows the baby, not the mother, and is left alone.
 */
export async function movePassesToCurrentWard(db: Db, admissionId: string, at: Date, actor: Actor = PASSES_SYSTEM_ACTOR): Promise<{ movedPassIds: string[] }> {
  return withTx(db, async (tx) => {
    await lockPasses(tx, admissionId);
    const place = await admissionPlace(tx, admissionId);
    if (place === null || place.wardId === null) return { movedPassIds: [] };
    const rows = await tx.update(passes).set({ wardId: place.wardId }).where(and(
      eq(passes.admissionId, admissionId), inArray(passes.state, [...LIVE_STATES]), ne(passes.kind, "nicu_mother"),
      or(isNull(passes.wardId), ne(passes.wardId, place.wardId)),
    )).returning({ id: passes.id });
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { movedPassIds: [] };
    for (const passId of ids) await logEvent(tx, actor, at, admissionId, "moved", passId, null, { wardId: place.wardId });
    await appendEvent(tx, passesMoved.make({
      payload: { admissionId, passIds: ids, wardId: place.wardId }, actor, correlationId: admissionId, patientId: place.patientId, occurredAt: at,
    }));
    return { movedPassIds: ids };
  });
}
