import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  IPD_CRASH_CART_STANDARD, IpdCheckCrashCartInputSchema, IpdNarcoticKeysInputSchema, IpdRegisterCrashCartInputSchema, IpdUseCrashCartInputSchema,
  IpdVerifyNurseRegistrationInputSchema, newId,
} from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdCrashCartChecks, ipdCrashCarts, ipdNarcoticKeyHolds, ipdNurseRegistrations, ipdWardIncidents, resources, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { withIdempotency } from "../billing";
import { provenanceOf, requireIpdPermission } from "./admission-core";
import { IpdError } from "./errors";
import { RN_ROLES, STUDENT_ROLES, shiftSlotOf } from "./nurse-ward";
import { IPD_ASSESSMENT_RECORD, IPD_EMAR_GIVE, IPD_NURSE_REGISTRATION_VERIFY, IPD_NURSING_ASSIGN } from "./permissions";
import { crashCartChecked, crashCartUsed, narcoticKeysTaken, nurseRegistrationVerified, wardIncidentRaised } from "./ward-safety-events";
import { activeRoleHolders } from "./ward-safety";
import type { Actor, IpdAgencyNurses, IpdCrashCartView } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * WM-2 (#983) — THE CRASH CART, THE WARD INCIDENT AND THE NARCOTIC KEYS.
 *
 * - A cart is registered by the in-charge with its numbered seal and its contents (the hospital's standard list,
 *   `IPD_CRASH_CART_STANDARD`, unless the ward gives its own). Every shift a nurse checks it against the seal.
 * - A SEAL NUMBER DIFFERENT FROM THE LAST CHECK cannot be saved without a FULL RECOUNT (every content line counted;
 *   `crash_cart_recount_required` with `detail.missing`) and writes ONE ward incident, told to the nursing
 *   superintendent(s). After a code (`useCrashCart`) the cart shows `needs_restock` until a check recounts and reseals it
 *   (`crash_cart_restock_required`); that reseal is expected and raises no incident.
 * - THE NARCOTIC KEYS (0089 rule 5): one holder per ward at a time; taking them releases the last holder. An agency
 *   nurse (role `agency_nurse`) or a student never holds them.
 */

type Opts = { now?: Date };
export const AGENCY_ROLES = ["agency_nurse"];

function once<T>(db: Db, actor: Actor, act: string, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${act}`, key: key.toLowerCase() }, body, work, now);
}

async function wardOrThrow(exec: Db | Tx, wardId: string): Promise<typeof resources.$inferSelect> {
  const ward = (await exec.select().from(resources).where(eq(resources.id, wardId)))[0];
  if (ward === undefined || (ward.kind !== "ward" && ward.kind !== "hall")) throw new IpdError("ward_not_found", "no ward has this id", { wardId });
  return ward;
}

export async function isAgencyNurse(exec: Db | Tx, userId: string): Promise<boolean> {
  return actorHoldsAnyRole(exec as Tx, userId, AGENCY_ROLES);
}
export async function isStudentNurse(exec: Db | Tx, userId: string): Promise<boolean> {
  return !(await actorHoldsAnyRole(exec as Tx, userId, RN_ROLES)) && (await actorHoldsAnyRole(exec as Tx, userId, STUDENT_ROLES));
}

/** One ward incident (no separate incident module in WM-2): a row, an event, a notice to each nursing superintendent. */
export async function raiseWardIncidentIn(
  tx: Tx, actor: Actor, i: { wardId: string; kind: string; refType: string; refId: string; text: string }, at: Date,
): Promise<string> {
  const incidentId = newId();
  await tx.insert(ipdWardIncidents).values({ id: incidentId, ...i, raisedBy: actor.id, raisedAt: at });
  let notified = 0;
  for (const userId of await activeRoleHolders(tx, "nursing_superintendent")) {
    if (await raiseNoticeIn(tx, {
      userId, kind: "ipd.ward_incident", title: "Ward incident", body: i.text, refType: "ipd_ward_incident", refId: incidentId,
      sourceKey: `ipd.ward_incident:${incidentId}`, at,
    })) notified += 1;
  }
  await appendEvent(tx, wardIncidentRaised.make({
    payload: { incidentId, wardId: i.wardId, kind: i.kind, refType: i.refType, refId: i.refId, notified, provenance: provenanceOf(actor) },
    actor, correlationId: i.wardId, occurredAt: at,
  }));
  return incidentId;
}

export async function registerCrashCart(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ cartId: string }> {
  const input = IpdRegisterCrashCartInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSING_ASSIGN);
  const at = opts.now ?? new Date();
  return once(db, actor, "register_crash_cart", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const ward = await wardOrThrow(tx, input.wardId);
    const cartId = newId();
    const inserted = await tx.insert(ipdCrashCarts).values({
      id: cartId, wardId: ward.id, code: input.code, contents: input.contents ?? [...IPD_CRASH_CART_STANDARD], sealNo: input.sealNo, status: "ready",
      createdBy: actor.id, createdAt: at,
    }).onConflictDoNothing().returning({ id: ipdCrashCarts.id });
    if (inserted.length === 0) throw new IpdError("crash_cart_code_taken", "this ward already has a cart with this code", { code: input.code });
    return { cartId };
  }), at);
}

async function lockCart(tx: Tx, cartId: string): Promise<typeof ipdCrashCarts.$inferSelect> {
  const c = (await tx.select().from(ipdCrashCarts).where(eq(ipdCrashCarts.id, cartId)).for("update"))[0];
  if (c === undefined) throw new IpdError("crash_cart_not_found", "no crash cart has this id", { cartId });
  return c;
}

export async function checkCrashCart(
  db: Db, actor: Actor, raw: unknown, opts: Opts = {},
): Promise<{ checkId: string; status: "ready" | "needs_restock"; sealChanged: boolean; incidentId: string | null }> {
  const input = IpdCheckCrashCartInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "check_crash_cart", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const cart = await lockCart(tx, input.cartId);
    const sealChanged = input.sealNo !== cart.sealNo;
    const restock = cart.status === "needs_restock";
    if (sealChanged || restock) {
      const counted = new Set((input.recount ?? []).map((l) => l.item.toLowerCase()));
      const missing = cart.contents.filter((c) => !counted.has(c.item.toLowerCase())).map((c) => c.item);
      if (missing.length > 0) {
        if (restock && input.recount === undefined) {
          throw new IpdError("crash_cart_restock_required", "the cart was used in a code: recount every item and reseal it", { missing });
        }
        throw new IpdError("crash_cart_recount_required", "the seal number changed: recount every item", { missing });
      }
    }
    const s = shiftSlotOf(at);
    const checkId = newId();
    await tx.insert(ipdCrashCartChecks).values({
      id: checkId, cartId: cart.id, kind: "check", sealNo: input.sealNo, previousSealNo: cart.sealNo, recount: input.recount ?? null,
      shiftDate: s.date, shift: s.key, byUser: actor.id, at, note: input.note ?? null,
    });
    await tx.update(ipdCrashCarts).set({ sealNo: input.sealNo, status: "ready", lastCheckAt: at }).where(eq(ipdCrashCarts.id, cart.id));
    // A seal broken on a cart nobody reported used: one incident. A reseal after a code is expected.
    const incidentId = sealChanged && !restock ? await raiseWardIncidentIn(tx, actor, {
      wardId: cart.wardId, kind: "crash_cart_seal", refType: "ipd_crash_cart", refId: cart.id,
      text: `Crash cart ${cart.code}: seal ${cart.sealNo} found as ${input.sealNo}`,
    }, at) : null;
    await appendEvent(tx, crashCartChecked.make({
      payload: { cartId: cart.id, checkId, sealChanged, recounted: input.recount !== undefined, status: "ready", provenance: provenanceOf(actor) },
      actor, correlationId: cart.wardId, occurredAt: at,
    }));
    return { checkId, status: "ready" as const, sealChanged, incidentId };
  }), at);
}

/** The cart was opened in a code: it needs a restock (a full recount and a new seal) before it reads ready again. */
export async function useCrashCart(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ cartId: string; status: "needs_restock" }> {
  const input = IpdUseCrashCartInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_ASSESSMENT_RECORD);
  const at = opts.now ?? new Date();
  return once(db, actor, "use_crash_cart", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const cart = await lockCart(tx, input.cartId);
    const s = shiftSlotOf(at);
    const checkId = newId();
    await tx.insert(ipdCrashCartChecks).values({
      id: checkId, cartId: cart.id, kind: "used", sealNo: null, previousSealNo: cart.sealNo, shiftDate: s.date, shift: s.key, byUser: actor.id, at, note: input.note ?? null,
    });
    await tx.update(ipdCrashCarts).set({ status: "needs_restock" }).where(eq(ipdCrashCarts.id, cart.id));
    await appendEvent(tx, crashCartUsed.make({ payload: { cartId: cart.id, checkId, provenance: provenanceOf(actor) }, actor, correlationId: cart.wardId, occurredAt: at }));
    return { cartId: cart.id, status: "needs_restock" as const };
  }), at);
}

export async function crashCartsOf(exec: Db | Tx, wardId: string, now: Date): Promise<IpdCrashCartView[]> {
  const carts = await exec.select().from(ipdCrashCarts).where(eq(ipdCrashCarts.wardId, wardId));
  const s = shiftSlotOf(now);
  const out: IpdCrashCartView[] = [];
  for (const c of carts.sort((x, y) => x.code.localeCompare(y.code))) {
    const last = (await exec.select().from(ipdCrashCartChecks)
      .where(and(eq(ipdCrashCartChecks.cartId, c.id), eq(ipdCrashCartChecks.kind, "check"))).orderBy(desc(ipdCrashCartChecks.at)).limit(1))[0];
    out.push({
      cartId: c.id, code: c.code, sealNo: c.sealNo, status: c.status as "ready", contents: c.contents,
      lastCheckAt: c.lastCheckAt?.toISOString() ?? null, checkedThisShift: last !== undefined && last.shiftDate === s.date && last.shift === s.key,
    });
  }
  return out;
}

// ═══════════════════════════════════════════ narcotic keys ═══════════════════════════════════════════

export async function takeNarcoticKeys(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ holdId: string; wardId: string; fromUserId: string | null }> {
  const input = IpdNarcoticKeysInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_EMAR_GIVE);
  const at = opts.now ?? new Date();
  if (await isAgencyNurse(db, actor.id)) throw new IpdError("agency_no_narcotic_keys", "an agency nurse does not hold the narcotic keys (decision 0089)");
  if (await isStudentNurse(db, actor.id)) throw new IpdError("student_no_narcotic_keys", "a student nurse does not hold the narcotic keys");
  return once(db, actor, "take_narcotic_keys", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const ward = await wardOrThrow(tx, input.wardId);
    const held = (await tx.select().from(ipdNarcoticKeyHolds).where(and(eq(ipdNarcoticKeyHolds.wardId, ward.id), isNull(ipdNarcoticKeyHolds.releasedAt))).for("update"))[0];
    if (held !== undefined) await tx.update(ipdNarcoticKeyHolds).set({ releasedAt: at }).where(eq(ipdNarcoticKeyHolds.id, held.id));
    const holdId = newId();
    await tx.insert(ipdNarcoticKeyHolds).values({ id: holdId, wardId: ward.id, userId: actor.id, takenAt: at });
    await appendEvent(tx, narcoticKeysTaken.make({ payload: { holdId, wardId: ward.id, fromUserId: held?.userId ?? null, provenance: provenanceOf(actor) }, actor, correlationId: ward.id, occurredAt: at }));
    return { holdId, wardId: ward.id, fromUserId: held?.userId ?? null };
  }), at);
}

export async function narcoticKeysOf(exec: Db | Tx, wardId: string): Promise<{ userId: string; takenAt: Date } | null> {
  const h = (await exec.select().from(ipdNarcoticKeyHolds).where(and(eq(ipdNarcoticKeyHolds.wardId, wardId), isNull(ipdNarcoticKeyHolds.releasedAt))))[0];
  return h === undefined ? null : { userId: h.userId, takenAt: h.takenAt };
}

// ═══════════════════════════════════════════ #1009 — council registration and the agency witness ═══════════════════════════════════════════

/** The nurse's registration lets her witness at `at`: verified, not revoked, valid through that IST date. */
export async function registrationValid(exec: Db | Tx, userId: string, at: Date): Promise<boolean> {
  const r = (await exec.select().from(ipdNurseRegistrations).where(eq(ipdNurseRegistrations.userId, userId)))[0];
  return r !== undefined && r.revokedAt === null && String(r.validUntil) >= istDayString(at);
}

/**
 * Decision 0089 rule 5: an agency nurse witnesses (the second nurse on a high-alert dose, an infusion or a narcotic
 * wastage) only while her council registration is verified and in date. Staff nurses need no record.
 */
export async function requireWitnessAllowed(exec: Db | Tx, userId: string, at: Date): Promise<void> {
  if (!(await isAgencyNurse(exec, userId))) return;
  if (!(await registrationValid(exec, userId, at))) {
    throw new IpdError("agency_witness_unverified", "an agency nurse witnesses only with a verified, in-date council registration (decision 0089)");
  }
}

export async function verifyNurseRegistration(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<{ userId: string; validUntil: string }> {
  const input = IpdVerifyNurseRegistrationInputSchema.parse(raw);
  await requireIpdPermission(db, actor, IPD_NURSE_REGISTRATION_VERIFY);
  const at = opts.now ?? new Date();
  return once(db, actor, "verify_nurse_registration", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    if (!(await actorHoldsAnyRole(tx, input.userId, [...RN_ROLES, ...AGENCY_ROLES]))) throw new IpdError("not_a_nurse", "this person holds no nursing role", { userId: input.userId });
    const row = {
      council: input.council, registrationNo: input.registrationNo, validUntil: input.validUntil, verifiedBy: actor.id, verifiedAt: at, revokedBy: null, revokedAt: null,
    };
    await tx.insert(ipdNurseRegistrations).values({ userId: input.userId, ...row }).onConflictDoUpdate({ target: ipdNurseRegistrations.userId, set: row });
    await appendEvent(tx, nurseRegistrationVerified.make({
      payload: { userId: input.userId, validUntil: input.validUntil, provenance: provenanceOf(actor) }, actor, correlationId: input.userId, occurredAt: at,
    }));
    return { userId: input.userId, validUntil: input.validUntil };
  }), at);
}

export async function readAgencyNurses(db: Db, actor: Actor, opts: { now?: Date } = {}): Promise<IpdAgencyNurses> {
  await requireIpdPermission(db, actor, IPD_NURSE_REGISTRATION_VERIFY);
  const now = opts.now ?? new Date();
  const ids = await activeRoleHolders(db, "agency_nurse");
  const people = ids.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids));
  const regs = new Map((ids.length === 0 ? [] : await db.select().from(ipdNurseRegistrations).where(inArray(ipdNurseRegistrations.userId, ids))).map((r) => [r.userId, r] as const));
  const today = istDayString(now);
  return {
    asOf: now.toISOString(),
    nurses: people.sort((x, y) => x.name.localeCompare(y.name)).map((p) => {
      const r = regs.get(p.id);
      return {
        userId: p.id, name: p.name, canWitness: r !== undefined && r.revokedAt === null && String(r.validUntil) >= today,
        registration: r === undefined ? null : { council: r.council, registrationNo: r.registrationNo, validUntil: String(r.validUntil), verifiedAt: r.verifiedAt.toISOString() },
      };
    }),
  };
}
