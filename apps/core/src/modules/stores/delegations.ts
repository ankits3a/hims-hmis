import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  orgDepartments, storeIndents, storesCommitteeSeats, storesDelegations, storesPurchaseRequestStamps, storesPurchaseRequests, storesTicketDetails, users,
} from "../../kernel/db/schema";
import { STORES_BUYING_MANAGE, STORES_INDENTS_APPROVE, holds, recordAct } from "./access";
import { StoresError } from "./errors";
import { holdersOf } from "./tickets";
import type { WireStoresDelegation } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, decision 11) — A DATED DELEGATION OF THE HOD'S APPROVAL (the stores layer; the kernel is untouched).
 *
 * An HOD (a holder of `stores.indents.approve` assigned AT the department) hands the department's purchase-request and
 * ticket approval to a colleague for at most 30 days. Inside the window the delegate's stamp reads "for HOD"; after the
 * end date the delegate is refused (`delegation_ended`). Never to the requester of the department's open requests or
 * tickets, never to the buyer (`stores.buying.manage`). NOT delegable in HMIS: the PO tiers, the payment run and any
 * owner approval — they are kernel approvals and money, and they stay with the named role (`not_delegable`). A
 * committee seat joins the scope with S5b's seats.
 */
export const DELEGATION_MAX_DAYS = 30;
export const DELEGATION_SCOPES = ["hod_approval", "committee_seat"] as const;
/** S5b (#1115, decision 11; ruling 0100 Q3): the committee seats a member may hand over, with an end date. The owner's is not one. */
export const DELEGABLE_SEATS = ["materials_head", "accounts_head", "medical_superintendent", "biomedical"] as const;

export type DelegationInput = {
  toUserId: string; scope: string; departmentId?: string | null; seat?: string | null; from: Date; to: Date; reason?: string | null;
};

type DelegationRow = typeof storesDelegations.$inferSelect;

export async function delegateApprovals(db: Db, actor: Actor, input: DelegationInput, now: Date = new Date()): Promise<WireStoresDelegation> {
  if (!(DELEGATION_SCOPES as readonly string[]).includes(input.scope)) {
    throw new StoresError("not_delegable", "PO tiers, the payment run and owner approvals stay with the named role", { scope: input.scope });
  }
  const seatScope = input.scope === "committee_seat";
  const departmentId = seatScope ? null : (input.departmentId ?? null);
  const seat = seatScope ? (input.seat ?? null) : null;
  if (seatScope) {
    if (seat === null || !(DELEGABLE_SEATS as readonly string[]).includes(seat)) {
      throw new StoresError("not_delegable", "only a committee member's seat is handed over; the owner's is not", { seat });
    }
    if (actor.type !== "user" || (await seatHolderAt(db, seat, input.from)) !== actor.id) {
      throw new StoresError("not_your_seat", "only the seat's member hands it over", { seat });
    }
  } else {
    if (departmentId === null) throw new StoresError("bad_delegation", "name the department whose approval is handed over");
    if (actor.type !== "user" || !(await holdersOf(db, STORES_INDENTS_APPROVE, { departmentId })).includes(actor.id)) {
      throw new StoresError("not_permitted", "only the department's HOD hands over its approval", { permission: STORES_INDENTS_APPROVE, departmentId });
    }
  }
  const from = input.from.getTime();
  const to = input.to.getTime();
  if (!(to > from) || to - from > DELEGATION_MAX_DAYS * 86_400_000 || to <= now.getTime()) {
    throw new StoresError("bad_delegation", `a delegation ends after it starts, in the future, and within ${String(DELEGATION_MAX_DAYS)} days`);
  }
  if (input.toUserId === actor.id) throw new StoresError("bad_delegation", "a delegation is to someone else");
  const [to_] = await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.toUserId));
  if (to_ === undefined || !to_.active) throw new StoresError("bad_delegation", "no such active user", { toUserId: input.toUserId });
  if (await holds(db, { type: "user", id: input.toUserId }, STORES_BUYING_MANAGE)) {
    throw new StoresError("delegate_is_buyer", "the buyer never approves what they will buy");
  }
  if (departmentId !== null && await isOpenRequester(db, input.toUserId, departmentId)) {
    throw new StoresError("delegate_is_requester", "this person has requests of the department waiting for approval");
  }
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(storesDelegations).values({
      id, fromUserId: actor.id, toUserId: input.toUserId, scope: input.scope, departmentId, seat, fromAt: input.from, toAt: input.to,
      reason: input.reason?.trim() || null, createdAt: now,
    });
    await recordAct(tx, actor, now, {
      act: "delegate_approvals", refId: id, reason: input.reason?.trim() || null,
      after: { toUserId: input.toUserId, scope: input.scope, departmentId, seat, from: input.from.toISOString(), to: input.to.toISOString() },
    });
  });
  return (await delegationViews(db, [id], now))[0]!;
}

/** S5b: who sits in a committee seat at `at` — the newest seat row whose window covers it. */
export async function seatHolderAt(db: Db | Tx, seat: string, at: Date): Promise<string | null> {
  const rows = await (db as Db).select().from(storesCommitteeSeats).where(and(eq(storesCommitteeSeats.seat, seat), lte(storesCommitteeSeats.fromAt, at)))
    .orderBy(desc(storesCommitteeSeats.at), desc(storesCommitteeSeats.id));
  const live = rows.find((r) => r.toAt === null || r.toAt.getTime() > at.getTime());
  return live?.userId ?? null;
}

/** S5b: the live delegation of a committee seat to this user at `at` (the giver still sitting in the seat). */
export async function seatDelegationFor(db: Db | Tx, userId: string, seat: string, at: Date): Promise<{ live: DelegationRow | null; ended: boolean }> {
  const rows = await (db as Db).select().from(storesDelegations)
    .where(and(eq(storesDelegations.toUserId, userId), eq(storesDelegations.scope, "committee_seat"), eq(storesDelegations.seat, seat), lte(storesDelegations.fromAt, at)))
    .orderBy(desc(storesDelegations.toAt));
  if (rows.length === 0) return { live: null, ended: false };
  const holder = await seatHolderAt(db, seat, at);
  const live = rows.find((r) => r.toAt.getTime() > at.getTime() && r.fromUserId === holder) ?? null;
  return { live, ended: live === null };
}

/** Has this person a department request or ticket still waiting for its approval? */
async function isOpenRequester(db: Db | Tx, userId: string, departmentId: string): Promise<boolean> {
  const prs = await (db as Db).select({ id: storesPurchaseRequests.id }).from(storesPurchaseRequests)
    .leftJoin(storesPurchaseRequestStamps, eq(storesPurchaseRequestStamps.prId, storesPurchaseRequests.id))
    .where(and(eq(storesPurchaseRequests.raisedBy, userId), eq(storesPurchaseRequests.departmentId, departmentId), isNull(storesPurchaseRequestStamps.id)))
    .limit(1);
  if (prs.length > 0) return true;
  const tickets = await (db as Db).select({ id: storeIndents.id }).from(storeIndents)
    .innerJoin(storesTicketDetails, eq(storesTicketDetails.indentId, storeIndents.id))
    .where(and(
      eq(storeIndents.requestedBy, userId), eq(storesTicketDetails.departmentId, departmentId), eq(storeIndents.status, "requested"),
      eq(storeIndents.approvalRequired, true), isNull(storeIndents.approvalDecision),
    )).limit(1);
  return tickets.length > 0;
}

/**
 * The delegation this user acts under for a department at `at`: `live` when one covers the instant and its giver
 * still holds the approval at the department; `ended` when the newest one that had started is over.
 */
export async function delegationFor(db: Db | Tx, userId: string, departmentId: string, at: Date): Promise<{ live: DelegationRow | null; ended: boolean }> {
  const rows = await (db as Db).select().from(storesDelegations)
    .where(and(eq(storesDelegations.toUserId, userId), eq(storesDelegations.scope, "hod_approval"), eq(storesDelegations.departmentId, departmentId),
      lte(storesDelegations.fromAt, at)))
    .orderBy(desc(storesDelegations.toAt));
  if (rows.length === 0) return { live: null, ended: false };
  const holders = await holdersOf(db, STORES_INDENTS_APPROVE, { departmentId });
  const live = rows.find((r) => r.toAt.getTime() > at.getTime() && holders.includes(r.fromUserId)) ?? null;
  return { live, ended: live === null };
}

/** The departments this user approves for as a delegate at `at` (the giver still holding the approval there). */
export async function liveDelegatedDepartments(db: Db | Tx, userId: string, at: Date): Promise<Set<string>> {
  const rows = await (db as Db).select({ dept: storesDelegations.departmentId, from: storesDelegations.fromUserId }).from(storesDelegations)
    .where(and(eq(storesDelegations.toUserId, userId), eq(storesDelegations.scope, "hod_approval"), lte(storesDelegations.fromAt, at), gt(storesDelegations.toAt, at)));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.dept !== null && (await holdersOf(db, STORES_INDENTS_APPROVE, { departmentId: r.dept })).includes(r.from)) out.add(r.dept);
  }
  return out;
}

/** The delegations a user gave or holds that have not ended (and, for the giver, the last ended ones too). */
export async function myDelegations(db: Db, actor: Actor, now: Date = new Date()): Promise<WireStoresDelegation[]> {
  if (actor.type !== "user") return [];
  const since = new Date(now.getTime() - DELEGATION_MAX_DAYS * 86_400_000);
  const rows = await db.select({ id: storesDelegations.id }).from(storesDelegations)
    .where(and(or(eq(storesDelegations.fromUserId, actor.id), eq(storesDelegations.toUserId, actor.id)), gt(storesDelegations.toAt, since)))
    .orderBy(desc(storesDelegations.createdAt)).limit(20);
  return delegationViews(db, rows.map((r) => r.id), now);
}

async function delegationViews(db: Db | Tx, ids: readonly string[], now: Date): Promise<WireStoresDelegation[]> {
  if (ids.length === 0) return [];
  const rows = await (db as Db).select({ d: storesDelegations, dept: orgDepartments.name }).from(storesDelegations)
    .leftJoin(orgDepartments, eq(orgDepartments.id, storesDelegations.departmentId)).where(inArray(storesDelegations.id, [...ids]))
    .orderBy(desc(storesDelegations.createdAt));
  const people = [...new Set(rows.flatMap((r) => [r.d.fromUserId, r.d.toUserId]))];
  const names = new Map((await (db as Db).select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.name] as const));
  const person = (id: string) => ({ id, name: names.get(id) ?? id });
  return rows.map(({ d, dept }) => ({
    id: d.id, from: person(d.fromUserId), to: person(d.toUserId), scope: d.scope as "hod_approval" | "committee_seat", seat: d.seat, departmentId: d.departmentId, departmentName: dept,
    fromAt: d.fromAt.toISOString(), toAt: d.toAt.toISOString(), reason: d.reason,
    live: d.fromAt.getTime() <= now.getTime() && d.toAt.getTime() > now.getTime(),
  }));
}
