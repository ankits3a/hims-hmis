import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { attStaff, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { maskedAadhaar } from "./aadhaar";
import { attendancePersonLinked } from "./events";
import { normaliseMobile, pinOfUser } from "./linking";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { LinkProblem } from "./linking";

/**
 * ═══ LINKING BY HAND, AND THE COUNT TO WATCH (#634) ═══
 *
 * `linking.ts` links by itself whatever is unambiguous: one Aadhaar hash on both sides, or one
 * mobile one active machine person and one active login share. What it cannot decide is left to a
 * person, and this file is that person's tools:
 *
 *   - the COUNT and the UNLINKED LIST — how far adoption has got, for the owner and the Attendance
 *     Committee (`attendance.all.read`), and for the Users screen's administrator;
 *   - SUGGESTIONS — exact mobile matches only (the same normalised ten digits on both sides), each
 *     one waiting for a click. They are mostly the pairs the automatic rule withheld because a
 *     number is shared; `shared` says so, and the click is the human judgement the rule refused to make;
 *   - a HAND LINK — an administrator picks a machine person and a login and confirms. The owner's
 *     rule still binds the hand ("Match by mobile or Aadhaar only", 2026-10-09): the pair is linked
 *     only when the login's mobile or Aadhaar hash EQUALS the machine person's. A name is never
 *     enough. With no match the administrator first gives the login its mobile or Aadhaar
 *     (`identity-write.ts`, the Users screen's own writer), which may link it there and then.
 *
 * Nothing here returns a mobile number or a hash. A suggestion says which LAST FOUR digits match
 * so the administrator can check them against a register; a login's Aadhaar is the masked form.
 */

export type LinkCounts = {
  /** Active people on the machine's list. `linked + unlinked === active`. */
  active: number;
  linked: number;
  unlinked: number;
  /** Unlinked active people the automatic rule flagged (two matches, a login already taken). */
  needsAttention: number;
  /** Active HMIS logins, and how many of them are somebody's attendance record. */
  loginsActive: number;
  loginsLinked: number;
};

export async function linkCounts(db: Db | Tx): Promise<LinkCounts> {
  const s = (await db.select({
    active: sql<number>`count(*) filter (where ${attStaff.status} = 'active')::int`,
    linked: sql<number>`count(*) filter (where ${attStaff.status} = 'active' and ${attStaff.userId} is not null)::int`,
    attention: sql<number>`count(*) filter (where ${attStaff.status} = 'active' and ${attStaff.userId} is null and ${attStaff.needsAttention} is not null)::int`,
  }).from(attStaff))[0]!;
  const u = (await db.select({
    active: sql<number>`count(*)::int`,
    linked: sql<number>`count(*) filter (where exists (select 1 from att_staff a where a.user_id = ${users.id}))::int`,
  }).from(users).where(eq(users.active, true)))[0]!;
  return { active: s.active, linked: s.linked, unlinked: s.active - s.linked, needsAttention: s.attention, loginsActive: u.active, loginsLinked: u.linked };
}

/** Why an unlinked person is unlinked: the automatic rule's named reason, or simply that no login matches yet. */
export type UnlinkedReason = LinkProblem | "no_match";
export type UnlinkedRow = { pin: string; name: string; dept: string | null; post: string | null; reason: UnlinkedReason };
export const UNLINKED_PAGE = 100;

function like(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Active machine people with no login, by department then name. `q` matches the pin, the name or the department. */
export async function unlinkedPeople(db: Db | Tx, opts: { q?: string; offset?: number }): Promise<{ total: number; people: UnlinkedRow[] }> {
  const q = opts.q?.trim() ?? "";
  const where = and(
    eq(attStaff.status, "active"), isNull(attStaff.userId),
    q === "" ? undefined : or(eq(attStaff.pin, q), ilike(attStaff.name, like(q)), ilike(attStaff.dept, like(q))),
  );
  const total = (await db.select({ n: sql<number>`count(*)::int` }).from(attStaff).where(where))[0]!.n;
  const rows = await db.select({ pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, attention: attStaff.needsAttention })
    .from(attStaff).where(where)
    .orderBy(sql`${attStaff.dept} asc nulls last`, asc(attStaff.name), asc(attStaff.pin))
    .limit(UNLINKED_PAGE).offset(Math.max(0, opts.offset ?? 0));
  return { total, people: rows.map((r) => ({ pin: r.pin, name: r.name, dept: r.dept, post: r.post, reason: (r.attention as LinkProblem | null) ?? "no_match" })) };
}

export type MachinePersonRow = {
  pin: string; name: string; dept: string | null; post: string | null; status: string;
  needsAttention: LinkProblem | null;
  /** The login this person is, or null. */
  login: { userId: string; username: string; fullName: string; source: "mobile" | "aadhaar" } | null;
};
export const SEARCH_LIMIT = 30;

/** The administrator's search of the machine's list: by pin (exact), name or department. Linked and left people included. */
export async function searchMachine(db: Db | Tx, rawQ: string): Promise<MachinePersonRow[]> {
  const q = rawQ.trim();
  if (q === "") return [];
  const rows = await db.select({
    pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, status: attStaff.status,
    attention: attStaff.needsAttention, userId: attStaff.userId, source: attStaff.linkSource, username: users.username, fullName: users.fullName,
  }).from(attStaff).leftJoin(users, eq(users.id, attStaff.userId))
    .where(or(eq(attStaff.pin, q), ilike(attStaff.name, like(q)), ilike(attStaff.dept, like(q))))
    .orderBy(sql`(${attStaff.pin} = ${q}) desc`, asc(attStaff.name), asc(attStaff.pin)).limit(SEARCH_LIMIT);
  return rows.map(personRow);
}

function personRow(r: { pin: string; name: string; dept: string | null; post: string | null; status: string; attention: string | null; userId: string | null; source: string | null; username: string | null; fullName: string | null }): MachinePersonRow {
  return {
    pin: r.pin, name: r.name, dept: r.dept, post: r.post, status: r.status, needsAttention: r.attention as LinkProblem | null,
    login: r.userId === null ? null : { userId: r.userId, username: r.username ?? "", fullName: r.fullName ?? "", source: r.source as "mobile" | "aadhaar" },
  };
}

// ─────────────────────────── matching, pure ───────────────────────────

export type Match = "aadhaar" | "mobile";

/** The owner's two keys, in the automatic rule's order: an Aadhaar hash both sides hold, else the same normalised mobile. */
export function matchOf(person: { mobile: string | null; aadhaarHash: string | null }, login: { phone: string | null; aadhaarHash: string | null }): Match | null {
  if (person.aadhaarHash !== null && login.aadhaarHash !== null && person.aadhaarHash === login.aadhaarHash) return "aadhaar";
  const m = normaliseMobile(person.mobile);
  if (m !== null && m === normaliseMobile(login.phone)) return "mobile";
  return null;
}

type SuggestStaff = { pin: string; mobile: string | null; status: string; userId: string | null };
type SuggestLogin = { id: string; phone: string | null };

/**
 * EXACT MOBILE MATCHES, pure: every (unlinked active machine person, unlinked active login) pair whose
 * normalised mobiles are equal. `shared` is true when the number is not one-to-one — more than one
 * active machine person (linked ones counted, as the automatic rule counts them) or more than one
 * login holds it; those are the pairs only a person can choose between.
 */
export function mobileSuggestions(staff: readonly SuggestStaff[], logins: readonly SuggestLogin[]): { pin: string; userId: string; last4: string; shared: boolean }[] {
  const taken = new Set(staff.filter((s) => s.userId !== null).map((s) => s.userId as string));
  const activeByMobile = new Map<string, number>();
  for (const s of staff) {
    const m = s.status === "active" ? normaliseMobile(s.mobile) : null;
    if (m !== null) activeByMobile.set(m, (activeByMobile.get(m) ?? 0) + 1);
  }
  const loginsByMobile = new Map<string, string[]>();
  for (const u of logins) {
    const m = normaliseMobile(u.phone);
    if (m === null) continue;
    const had = loginsByMobile.get(m);
    if (had === undefined) loginsByMobile.set(m, [u.id]); else had.push(u.id);
  }
  const out: { pin: string; userId: string; last4: string; shared: boolean }[] = [];
  for (const s of staff) {
    if (s.status !== "active" || s.userId !== null) continue;
    const m = normaliseMobile(s.mobile);
    if (m === null) continue;
    const holders = loginsByMobile.get(m) ?? [];
    const shared = (activeByMobile.get(m) ?? 0) > 1 || holders.length > 1;
    for (const id of holders) if (!taken.has(id)) out.push({ pin: s.pin, userId: id, last4: m.slice(-4), shared });
  }
  return out;
}

// ─────────────────────────── the administrator's reads ───────────────────────────

export type LoginRow = {
  userId: string; username: string; fullName: string; staffCode: string;
  /** The pin this login already is, or null. A login is one person's record at most. */
  linkedPin: string | null;
  /** Whether this login matches the person being linked, and by which key. */
  match: Match | null;
  hasMobile: boolean;
  /** `XXXX XXXX 0124`, or null. */
  aadhaar: string | null;
};
export type Suggestion = { person: { pin: string; name: string; dept: string | null; post: string | null }; login: { userId: string; username: string; fullName: string }; last4: string; shared: boolean };

export async function suggestions(db: Db | Tx): Promise<Suggestion[]> {
  const staff = await db.select({ pin: attStaff.pin, mobile: attStaff.mobile, status: attStaff.status, userId: attStaff.userId, name: attStaff.name, dept: attStaff.dept, post: attStaff.post }).from(attStaff);
  const logins = await db.select({ id: users.id, phone: users.phone, username: users.username, fullName: users.fullName }).from(users).where(eq(users.active, true));
  const byPin = new Map(staff.map((s) => [s.pin, s]));
  const byId = new Map(logins.map((u) => [u.id, u]));
  return mobileSuggestions(staff, logins)
    .map((p) => {
      const s = byPin.get(p.pin)!;
      const u = byId.get(p.userId)!;
      return { person: { pin: s.pin, name: s.name, dept: s.dept, post: s.post }, login: { userId: u.id, username: u.username, fullName: u.fullName }, last4: p.last4, shared: p.shared };
    })
    .sort((a, b) => Number(a.shared) - Number(b.shared) || (a.person.dept ?? "~").localeCompare(b.person.dept ?? "~") || a.person.name.localeCompare(b.person.name));
}

export class LinkError extends Error {
  constructor(readonly code: "unknown_person" | "user_not_found" | "person_linked" | "login_linked" | "login_inactive" | "no_match") { super(code); }
}

async function machinePerson(db: Db | Tx, pin: string): Promise<{ pin: string; name: string; dept: string | null; post: string | null; status: string; mobile: string | null; aadhaarHash: string | null; userId: string | null; source: string | null; attention: string | null; username: string | null; fullName: string | null }> {
  const row = (await db.select({
    pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, status: attStaff.status, mobile: attStaff.mobile, aadhaarHash: attStaff.aadhaarHash,
    userId: attStaff.userId, source: attStaff.linkSource, attention: attStaff.needsAttention, username: users.username, fullName: users.fullName,
  }).from(attStaff).leftJoin(users, eq(users.id, attStaff.userId)).where(eq(attStaff.pin, pin)))[0];
  if (row === undefined) throw new LinkError("unknown_person");
  return row;
}

/**
 * For one machine person: the logins that MATCH them (by Aadhaar or mobile), and — when `q` is given —
 * the logins a search finds, each saying whether it matches. Active logins only, as the automatic rule.
 */
export async function candidatesFor(db: Db | Tx, pin: string, rawQ: string): Promise<{ person: MachinePersonRow; matches: LoginRow[]; found: LoginRow[] }> {
  const p = await machinePerson(db, pin);
  const linked = await db.select({ userId: attStaff.userId, pin: attStaff.pin }).from(attStaff).where(sql`${attStaff.userId} is not null`);
  const pinOf = new Map(linked.map((l) => [l.userId as string, l.pin]));
  const cols = { id: users.id, username: users.username, fullName: users.fullName, staffCode: users.staffCode, phone: users.phone, aadhaarHash: users.aadhaarHash, last4: users.aadhaarLast4 };
  const toRow = (u: { id: string; username: string; fullName: string; staffCode: string; phone: string | null; aadhaarHash: string | null; last4: string | null }): LoginRow => ({
    userId: u.id, username: u.username, fullName: u.fullName, staffCode: u.staffCode, linkedPin: pinOf.get(u.id) ?? null,
    match: matchOf(p, u), hasMobile: u.phone !== null, aadhaar: u.last4 === null ? null : maskedAadhaar(u.last4),
  });
  const mobile = normaliseMobile(p.mobile);
  const keys = [
    p.aadhaarHash === null ? undefined : eq(users.aadhaarHash, p.aadhaarHash),
    // Stored phones are already normalised by `mobileChange`; the pure `matchOf` below re-checks every row.
    mobile === null ? undefined : eq(users.phone, mobile),
  ].filter((k) => k !== undefined);
  const matches = keys.length === 0 ? [] : (await db.select(cols).from(users).where(and(eq(users.active, true), or(...keys))).orderBy(asc(users.username)))
    .map(toRow).filter((r) => r.match !== null);
  const q = rawQ.trim();
  const found = q === "" ? [] : (await db.select(cols).from(users)
    .where(and(eq(users.active, true), or(ilike(users.username, like(q)), ilike(users.fullName, like(q)), eq(users.staffCode, q))))
    .orderBy(asc(users.username)).limit(20)).map(toRow);
  return { person: personRow(p), matches, found };
}

/**
 * THE HAND LINK. In the caller's transaction: the machine person's row is locked, both sides must be
 * free, the login active, and the pair must MATCH by Aadhaar or mobile — the source recorded is the
 * key that matched. The event is the automatic rule's own (`attendance.person_linked`); its ACTOR
 * is the administrator, which is what tells a hand link from the job's.
 */
export async function linkByHand(tx: Tx, actor: Actor, now: Date, pin: string, userId: string): Promise<{ pin: string; userId: string; source: Match }> {
  const locked = (await tx.select({ pin: attStaff.pin }).from(attStaff).where(eq(attStaff.pin, pin)).for("update"))[0];
  if (locked === undefined) throw new LinkError("unknown_person");
  const p = await machinePerson(tx, pin);
  if (p.userId !== null) throw new LinkError("person_linked");
  const u = (await tx.select({ id: users.id, active: users.active, phone: users.phone, aadhaarHash: users.aadhaarHash }).from(users).where(eq(users.id, userId)).for("update"))[0];
  if (u === undefined) throw new LinkError("user_not_found");
  if (!u.active) throw new LinkError("login_inactive");
  if ((await pinOfUser(tx, userId)) !== null) throw new LinkError("login_linked");
  const source = matchOf(p, u);
  if (source === null) throw new LinkError("no_match");
  const done = await tx.update(attStaff)
    .set({ userId, linkSource: source, linkedAt: now, needsAttention: null, updatedAt: now })
    .where(and(eq(attStaff.pin, pin), isNull(attStaff.userId)))
    .returning({ pin: attStaff.pin });
  if (done.length === 0) throw new LinkError("person_linked");
  await appendEvent(tx, attendancePersonLinked.make({ actor, occurredAt: now, payload: { pin, userId, source } }));
  return { pin, userId, source };
}
