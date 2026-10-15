import { Controller, Get, Inject } from "@nestjs/common";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { TEAM_ROLES } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { DB, MODULE_REGISTRY } from "../tokens";
import { istDayString as istDay } from "../approvals/cumulative";
import { CurrentActor } from "../auth/decorators";
import { roleAssignments, rosterTeamMemberships, tempRoleGrants, users } from "../db/schema";
import { collectDeskProviders } from "./registry";
import { addDays, factsForWindow, sumWindow } from "./rollup";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

/** A team card lists people, not a hospital: past this many it is a report (`/staff`), not a card. */
export const TEAM_CARD_MAX = 40;
/** "Last 30 days" on the card — today and the 29 days before it. */
export const TEAM_WINDOW_DAYS = 30;

export type TeamMember = {
  userId: string;
  name: string;
  /** Today, live — the same named counters the person's own "My day" shows. */
  today: Record<string, number>;
  /** The last 30 days summed, and the days of it that carried anything. */
  month: Record<string, number>;
  daysWithActivity: number;
};

export type TeamCard = { date: string; from: string; why: ("role" | "unit_head")[]; members: TeamMember[] };

/**
 * WHOSE PEOPLE ARE WHOSE (owner 2026-10-07, decision 0042: "supervisors see their team's … unit
 * heads, the billing manager, the nursing in-charge, for their own people only").
 *
 * Two sources, both facts the system already holds — no reporting-line table is invented:
 *
 *   · a supervising ROLE sees the people who hold the roles under it (`TEAM_ROLES`);
 *   · a UNIT HEAD sees the current members of the units they head (`roster_team_memberships`,
 *     `role_in_team = 'head'` — the roster's own word; 'unit_head' is not one, and round 1 asked for it).
 *
 * The caller is never on their own team, and inactive people are not on anybody's.
 */
export async function teamOf(db: Db, userId: string, now: Date): Promise<{ userIds: string[]; why: ("role" | "unit_head")[] }> {
  const held = [
    ...(await db.select({ k: roleAssignments.roleKey }).from(roleAssignments).where(eq(roleAssignments.userId, userId))).map((r) => r.k),
    ...(await db.select({ k: tempRoleGrants.roleKey }).from(tempRoleGrants).where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, now)))).map((r) => r.k),
  ];
  const under = [...new Set(held.flatMap((k) => TEAM_ROLES[k] ?? []))];
  const ids = new Set<string>();
  const why = new Set<"role" | "unit_head">();
  if (under.length > 0) {
    const rows = await db.select({ u: roleAssignments.userId }).from(roleAssignments).where(inArray(roleAssignments.roleKey, under));
    for (const r of rows) { ids.add(r.u); why.add("role"); }
  }
  const current = and(lte(rosterTeamMemberships.startsAt, now), or(isNull(rosterTeamMemberships.endsAt), gt(rosterTeamMemberships.endsAt, now)));
  const heads = await db.select({ t: rosterTeamMemberships.teamId }).from(rosterTeamMemberships)
    .where(and(eq(rosterTeamMemberships.userId, userId), eq(rosterTeamMemberships.roleInTeam, "head"), current));
  if (heads.length > 0) {
    const members = await db.select({ u: rosterTeamMemberships.userId }).from(rosterTeamMemberships)
      .where(and(inArray(rosterTeamMemberships.teamId, heads.map((h) => h.t)), current));
    for (const m of members) { ids.add(m.u); why.add("unit_head"); }
  }
  ids.delete(userId);
  if (ids.size === 0) return { userIds: [], why: [] };
  const active = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, [...ids]), eq(users.active, true)));
  return { userIds: active.map((a) => a.id).sort(), why: [...why].sort() };
}

/**
 * APP HOME — THE SUPERVISOR'S ONE EXTRA CARD.
 *
 * `/me/…` and no `userId` parameter, for the reason the report and the brief give: there is no way
 * to ask for somebody else's team because there is nowhere to put their id. WHO is on the card is
 * decided here from the caller alone (`teamOf`), so a supervisor cannot read another team by asking.
 *
 * COUNTS ONLY — the same named, summable counters as the brief (`facts`), which cannot carry a
 * patient or a note. Today is computed live with the SUPERVISOR as the reader, so the blind-count
 * gate judges the supervisor's own clearance over a cashier's drawer, exactly as `/staff/:id/brief`.
 * A person with no team gets an empty card, which is an answer, not a refusal.
 */
@Controller("me")
export class HomeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  @Get("team")
  async team(@CurrentActor() actor: Actor): Promise<TeamCard> {
    const now = new Date();
    const date = istDay(now);
    const from = addDays(date, -(TEAM_WINDOW_DAYS - 1));
    if (actor.type !== "user") return { date, from, why: [], members: [] };
    const { userIds, why } = await teamOf(this.db, actor.id, now);
    if (userIds.length === 0) return { date, from, why: [], members: [] };
    const shown = userIds.slice(0, TEAM_CARD_MAX);
    const names = await this.db.select({ id: users.id, fullName: users.fullName, username: users.username }).from(users).where(inArray(users.id, shown));
    const nameOf = new Map(names.map((n) => [n.id, n.fullName ?? n.username] as const));
    const providers = collectDeskProviders(this.registry);
    const members: TeamMember[] = [];
    for (const userId of shown) {
      const days = await factsForWindow(this.db, providers, { type: "user", id: userId }, from, date, date, now, actor);
      const today = days.find((d) => d.day === date)?.facts ?? {};
      members.push({
        userId, name: nameOf.get(userId) ?? userId, today, month: sumWindow(days),
        daysWithActivity: days.filter((d) => Object.values(d.facts).some((v) => v > 0)).length,
      });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    return { date, from, why, members };
  }
}
