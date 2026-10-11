import { and, count, eq, gte, isNull, lt, min, ne } from "drizzle-orm";
import { WAITING_KINDS, WAITING_TONE, WAITING_WEB_HREF } from "@hmis/contracts";
import type { WaitingItem, WaitingKind } from "@hmis/contracts";
import { hasPermission } from "../auth/permissions";
import { alerts, userReminders } from "../db/schema";
import { PERSONAL_REMINDER_KIND } from "../reminders/reminders";
import { istDayString as istDay } from "../approvals/cumulative";
import { addDays } from "./rollup";
import type { DeskProvider, DeskProviderCtx } from "./types";

/**
 * E1.4 / E1.5 (decision 0064) — WHAT IS WAITING ON ONE PERSON, as counts.
 *
 * `GET /me/waiting` composes this from two places: the kernel's own two (the bell and reminders,
 * both identity-scoped tables every user has) and each module's `waiting` hook, run only when the
 * caller holds that provider's permission — the desk's gate, applied before the provider runs.
 *
 * ONE PROVIDER FAILING LOSES ITS OWN LINES, never the card: the desk's bargain (`registry.ts`
 * `runOne`). A morning card that blanks because the radiology query failed tells a doctor nothing is
 * waiting, which is the one wrong answer.
 */

/** Bell rows older than this are history, not a loop: the bell itself still lists them. DECIDED. */
export const WAITING_ALERT_DAYS = 7;

/** One line, with the kind's fixed tone and web link — a provider names only the kind, the count and the age. */
export function waitingItem(kind: WaitingKind, n: number, oldest: Date | string | null): WaitingItem | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const oldestAt = oldest === null ? null : (oldest instanceof Date ? oldest : new Date(oldest)).toISOString();
  return { kind, count: Math.trunc(n), oldestAt, tone: WAITING_TONE[kind], href: WAITING_WEB_HREF[kind] };
}

/** The IST midnight that ends `day`, as an instant. */
export function istMidnightAfter(day: string): Date {
  return new Date(`${addDays(day, 1)}T00:00:00+05:30`);
}

async function kernelItems(ctx: DeskProviderCtx): Promise<WaitingItem[]> {
  const me = ctx.actor.id;
  const since = new Date(ctx.now.getTime() - WAITING_ALERT_DAYS * 86_400_000);
  const [bell] = await ctx.db
    .select({ n: count(), oldest: min(alerts.createdAt) })
    .from(alerts)
    .where(and(
      eq(alerts.userId, me), isNull(alerts.ackKind), gte(alerts.createdAt, since),
      // A fired reminder is the reminder's own line, not an unanswered alert.
      ne(alerts.kind, PERSONAL_REMINDER_KIND),
    ));
  const [rem] = await ctx.db
    .select({ n: count() })
    .from(userReminders)
    .where(and(
      eq(userReminders.userId, me), isNull(userReminders.firedAt), isNull(userReminders.cancelledAt),
      lt(userReminders.dueAt, istMidnightAfter(istDay(ctx.now))),
    ));
  return [
    waitingItem("alerts.unanswered", bell?.n ?? 0, bell?.oldest ?? null),
    waitingItem("reminders.today", rem?.n ?? 0, null),
  ].filter((i): i is WaitingItem => i !== null);
}

const RANK = new Map<string, number>(WAITING_KINDS.map((k, i) => [k, i] as const));

/**
 * The whole list for `ctx.actor`. Two providers naming the same kind are summed (oldest kept), so a
 * kind is one line however many modules feed it.
 */
export async function loadWaiting(providers: DeskProvider[], ctx: DeskProviderCtx): Promise<{ items: WaitingItem[] }> {
  const parts: WaitingItem[][] = [];
  try { parts.push(await kernelItems(ctx)); } catch { /* the bell's line is lost, not the card */ }
  for (const p of providers) {
    if (p.waiting === undefined) continue;
    if (!(await hasPermission(ctx.db, ctx.actor.id, p.permission, "hospital"))) continue;
    try { parts.push(await p.waiting(ctx)); } catch { /* one module's lines lost, never the card */ }
  }
  const byKind = new Map<WaitingKind, WaitingItem>();
  for (const item of parts.flat()) {
    if (!RANK.has(item.kind) || item.count <= 0) continue;
    const had = byKind.get(item.kind);
    if (had === undefined) { byKind.set(item.kind, item); continue; }
    const oldestAt = had.oldestAt === null ? item.oldestAt
      : item.oldestAt === null ? had.oldestAt
        : (had.oldestAt < item.oldestAt ? had.oldestAt : item.oldestAt);
    byKind.set(item.kind, { ...had, count: had.count + item.count, oldestAt });
  }
  const items = [...byKind.values()].sort((a, b) => (RANK.get(a.kind) ?? 0) - (RANK.get(b.kind) ?? 0));
  return { items };
}
