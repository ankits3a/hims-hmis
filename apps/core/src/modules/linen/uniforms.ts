import { and, eq, inArray, sql } from "drizzle-orm";
import {
  exchangeUniformInput, issueUniformInput, LINEN_UNIFORM_ENTITLEMENT, newId, returnUniformInput, setUniformRoleInput,
} from "@hmis/contracts";
import { linenUniformMoves, linenUniformRoles, roleAssignments, users } from "../../kernel/db/schema";
import { LinenError } from "./errors";
import { lock, parse, requireItems, stamp, tx } from "./intents";
import { replacementCosts } from "./vendor";
import type { Actor, LinenUniformDue, LinenUniformHolding } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { Exec } from "./intents";

/**
 * ═══ UNIFORMS (LD-2, #979, D5; decisions 0087 and 0092) ═══
 *
 * Staff in an entitled role (`linen_uniform_roles`: nurses, lab technicians, OT staff, housekeeping, and roles added in
 * setup) are issued up to three sets against their staff id. An exchange takes one dirty set for each clean set and
 * leaves the holding as it was. On exit (`users.active = false`) the sets still held are on the no-dues list, valued at
 * replacement cost less 1/12 per month of use; HR approves the deduction from the final settlement (no HR module yet:
 * the list is linen's, and the settlement is owed to HR — see the spec's build notes).
 */
export const UNIFORM_ITEM = "uniform_set";
const MONTH_MS = 30.4375 * 24 * 3_600_000;

export async function setUniformRole(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ roleKey: string; entitled: boolean }> {
  const input = parse(setUniformRoleInput, raw);
  return tx(exec, async (t) => {
    const now = await stamp(t, nowIn);
    if (input.entitled) {
      await t.insert(linenUniformRoles).values({ roleKey: input.roleKey, setBy: actor.id, setAt: now }).onConflictDoNothing();
    } else {
      await t.delete(linenUniformRoles).where(eq(linenUniformRoles.roleKey, input.roleKey));
    }
    return { roleKey: input.roleKey, entitled: input.entitled };
  });
}

export async function uniformRoles(exec: Exec): Promise<string[]> {
  return (await exec.select({ k: linenUniformRoles.roleKey }).from(linenUniformRoles)).map((r) => r.k).sort();
}

async function holdingOf(t: Exec, userId: string, itemCode: string): Promise<number> {
  const r = await t.select({ n: sql<string>`coalesce(sum(${linenUniformMoves.setsOut} - ${linenUniformMoves.setsIn}), 0)` })
    .from(linenUniformMoves).where(and(eq(linenUniformMoves.userId, userId), eq(linenUniformMoves.itemCode, itemCode)));
  return Number(r[0]?.n ?? 0);
}

async function staff(t: Tx, ref: { userId?: string | undefined; username?: string | undefined }): Promise<{ id: string; active: boolean }> {
  const where = ref.userId !== undefined ? eq(users.id, ref.userId) : eq(users.username, ref.username ?? "");
  const u = (await t.select({ id: users.id, active: users.active }).from(users).where(where))[0];
  if (u === undefined) throw new LinenError("unknown_user", { ...ref });
  return u;
}

async function begin(t: Tx, userId: string, itemCode: string | undefined): Promise<string> {
  const item = itemCode ?? UNIFORM_ITEM;
  await requireItems(t, [{ itemCode: item, qty: 1 }]);
  await lock(t, `uniform:${userId}`);
  return item;
}

export async function issueUniform(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ holding: number }> {
  const input = parse(issueUniformInput, raw);
  return tx(exec, async (t) => {
    const u = await staff(t, input);
    if (!u.active) throw new LinenError("unknown_user", { userId: u.id });
    const item = await begin(t, u.id, input.itemCode);
    const entitled = await t.select({ k: roleAssignments.roleKey }).from(roleAssignments)
      .innerJoin(linenUniformRoles, eq(linenUniformRoles.roleKey, roleAssignments.roleKey)).where(eq(roleAssignments.userId, u.id)).limit(1);
    if (entitled.length === 0) throw new LinenError("not_entitled", { userId: u.id });
    const held = await holdingOf(t, u.id, item);
    if (held + input.sets > LINEN_UNIFORM_ENTITLEMENT) throw new LinenError("above_entitlement", { holding: held, max: LINEN_UNIFORM_ENTITLEMENT });
    const now = await stamp(t, nowIn);
    await t.insert(linenUniformMoves).values({ id: newId(), userId: u.id, itemCode: item, kind: "issue", setsOut: input.sets, size: input.size ?? null, at: now, by: actor.id });
    return { holding: held + input.sets };
  });
}

/** One clean set for one dirty set, never otherwise (D5). The holding is unchanged. */
export async function exchangeUniform(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ holding: number }> {
  const input = parse(exchangeUniformInput, raw);
  if (input.clean !== input.dirty) throw new LinenError("one_for_one", { dirty: input.dirty, clean: input.clean });
  return tx(exec, async (t) => {
    const u = await staff(t, input);
    const item = await begin(t, u.id, input.itemCode);
    const held = await holdingOf(t, u.id, item);
    if (held < input.dirty) throw new LinenError("exchange_unmatched", { holding: held });
    const now = await stamp(t, nowIn);
    await t.insert(linenUniformMoves).values({ id: newId(), userId: u.id, itemCode: item, kind: "exchange", setsOut: input.clean, setsIn: input.dirty, at: now, by: actor.id });
    return { holding: held };
  });
}

export async function returnUniform(exec: Exec, actor: Actor, raw: unknown, nowIn?: Date): Promise<{ holding: number }> {
  const input = parse(returnUniformInput, raw);
  return tx(exec, async (t) => {
    const u = await staff(t, input);
    const item = await begin(t, u.id, input.itemCode);
    const held = await holdingOf(t, u.id, item);
    if (input.sets > held) throw new LinenError("exceeds_held", { holding: held });
    const now = await stamp(t, nowIn);
    await t.insert(linenUniformMoves).values({ id: newId(), userId: u.id, itemCode: item, kind: "return", setsIn: input.sets, at: now, by: actor.id });
    return { holding: held - input.sets };
  });
}

type HoldRow = { userId: string; itemCode: string; sets: number; firstIssue: Date; size: string | null };

async function holdings(exec: Exec): Promise<HoldRow[]> {
  const r = await exec.execute<{ user_id: string; item_code: string; sets: string; first_issue: Date | string; size: string | null }>(sql`
    select user_id, item_code, sum(sets_out - sets_in) as sets,
           min(at) filter (where kind = 'issue') as first_issue,
           (array_agg(size order by at desc) filter (where size is not null))[1] as size
      from linen_uniform_moves group by user_id, item_code having sum(sets_out - sets_in) > 0`);
  return r.rows.map((x) => ({ userId: x.user_id, itemCode: x.item_code, sets: Number(x.sets), firstIssue: new Date(x.first_issue), size: x.size }));
}

async function people(exec: Exec, ids: readonly string[]): Promise<Map<string, { name: string; staffCode: string; active: boolean }>> {
  if (ids.length === 0) return new Map();
  const rows = await exec.select({ id: users.id, name: users.fullName, staffCode: users.staffCode, active: users.active }).from(users).where(inArray(users.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { name: r.name, staffCode: r.staffCode, active: r.active }]));
}

export async function uniformHoldings(exec: Exec): Promise<LinenUniformHolding[]> {
  const rows = await holdings(exec);
  const who = await people(exec, rows.map((r) => r.userId));
  return rows.filter((r) => who.get(r.userId)?.active === true).map((r) => ({
    userId: r.userId, name: who.get(r.userId)!.name, staffCode: who.get(r.userId)!.staffCode, sets: r.sets, size: r.size,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The no-dues list (D5): every leaver (an inactive user) still holding sets, with the deduction decision 0092 allows —
 * replacement cost × sets, less 1/12 for each whole month since the first issue, nothing after a year. HR approves it.
 */
export async function uniformDues(exec: Exec, now: Date): Promise<LinenUniformDue[]> {
  const rows = await holdings(exec);
  const who = await people(exec, rows.map((r) => r.userId));
  const left = rows.filter((r) => who.get(r.userId)?.active === false);
  const costs = await replacementCosts(exec, left.map((r) => r.itemCode));
  return left.map((r) => {
    const months = Math.max(0, Math.floor((now.getTime() - r.firstIssue.getTime()) / MONTH_MS));
    const replacement = r.sets * (costs.get(r.itemCode)?.unitPaise ?? 0);
    const p = who.get(r.userId)!;
    return {
      userId: r.userId, name: p.name, staffCode: p.staffCode, sets: r.sets, size: r.size, firstIssuedAt: r.firstIssue.toISOString(),
      monthsUsed: months, replacementPaise: replacement, deductionPaise: Math.round((replacement * Math.max(0, 12 - months)) / 12),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
