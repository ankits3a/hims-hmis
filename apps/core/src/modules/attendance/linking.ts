import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { attStaff, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { attendancePersonLinked } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ WHO ON THE MACHINE'S LIST IS WHICH HMIS LOGIN (owner 2026-10-09: "Match by mobile or Aadhaar only") ═══
 *
 *   1. AADHAAR — the login's `aadhaar_hash` equals the machine person's (both there) ⇒ linked.
 *   2. else MOBILE — the login's ten-digit phone equals the machine person's mobile, normalised the
 *      same way, AND exactly one ACTIVE machine person and exactly one active login share it ⇒ linked.
 *
 * Two matches on either side is NO link, recorded on the machine person as a named reason
 * (`needs_attention`) for a person to sort out. A link is 1:1 and is NEVER re-pointed here: a
 * machine person who has a login keeps it, and a login that is somebody's attendance record is
 * nobody else's. There is no name matching, on purpose — two Dr A Kumars are two people.
 */
export const LINK_PROBLEMS = ["aadhaar_shared", "mobile_shared_on_machine", "mobile_shared_by_logins", "login_linked_elsewhere"] as const;
export type LinkProblem = (typeof LINK_PROBLEMS)[number];
export type LinkState = "linked" | "not_linked" | "two_matches";

export const LINK_ACTOR: Actor = { type: "system", id: "attendance-linking" };

/** Ten digits, first 6–9 — after dropping spaces, punctuation, a leading +91 / 91 / 0. Else null. */
export function normaliseMobile(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

type StaffRow = { pin: string; mobile: string | null; status: string; aadhaarHash: string | null; userId: string | null; needsAttention: string | null };
type UserRow = { id: string; phone: string | null; aadhaarHash: string | null };

function byKey<T>(rows: readonly T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const had = m.get(k);
    if (had === undefined) m.set(k, [r]); else had.push(r);
  }
  return m;
}

/**
 * The whole decision, pure: which (pin, login) pairs to link, and what to say about every unlinked
 * machine person and every login. Both the writer below and the Users screen's state read THIS, so
 * "Two matches" on the screen is the same judgement that withheld the link.
 */
export function decideLinks(staff: readonly StaffRow[], logins: readonly UserRow[]): {
  links: { pin: string; userId: string; source: "aadhaar" | "mobile" }[];
  problems: Map<string, LinkProblem>;
  loginState: Map<string, LinkState>;
} {
  const links: { pin: string; userId: string; source: "aadhaar" | "mobile" }[] = [];
  const problems = new Map<string, LinkProblem>();
  const loginState = new Map<string, LinkState>(logins.map((u) => [u.id, "not_linked"] as const));
  const takenLogins = new Set<string>();
  for (const s of staff) if (s.userId !== null) { takenLogins.add(s.userId); loginState.set(s.userId, "linked"); }
  const takenPins = new Set<string>();
  const flagLogin = (id: string): void => { if (loginState.get(id) === "not_linked") loginState.set(id, "two_matches"); };

  // 1 — Aadhaar. Any machine person may match, active or not: a hash is one human whatever their status.
  const free = staff.filter((s) => s.userId === null);
  const staffByHash = byKey(free, (s) => s.aadhaarHash);
  const loginsByHash = byKey(logins, (u) => u.aadhaarHash);
  for (const [hash, people] of staffByHash) {
    const holders = loginsByHash.get(hash) ?? [];
    if (holders.length === 0) continue;
    if (people.length > 1 || holders.length > 1) {
      for (const p of people) problems.set(p.pin, "aadhaar_shared");
      for (const h of holders) flagLogin(h.id);
      continue;
    }
    const person = people[0]!;
    const login = holders[0]!;
    if (takenLogins.has(login.id)) { problems.set(person.pin, "login_linked_elsewhere"); continue; }
    links.push({ pin: person.pin, userId: login.id, source: "aadhaar" });
    takenLogins.add(login.id); takenPins.add(person.pin); loginState.set(login.id, "linked");
  }

  // 2 — mobile, for whoever step 1 left. "Exactly one ACTIVE machine person" counts the linked ones
  // too: a number two active people share is ambiguous even when one of them is already somebody.
  const activeByMobile = byKey(staff.filter((s) => s.status === "active"), (s) => normaliseMobile(s.mobile));
  const loginsByMobile = byKey(logins, (u) => normaliseMobile(u.phone));
  for (const [mobile, people] of activeByMobile) {
    const holders = loginsByMobile.get(mobile) ?? [];
    if (holders.length === 0) continue;
    const open = people.filter((p) => p.userId === null && !takenPins.has(p.pin));
    if (open.length === 0) continue;
    if (people.length > 1) {
      for (const p of open) if (!problems.has(p.pin)) problems.set(p.pin, "mobile_shared_on_machine");
      for (const h of holders) flagLogin(h.id);
      continue;
    }
    const person = open[0]!;
    if (holders.length > 1) {
      if (!problems.has(person.pin)) problems.set(person.pin, "mobile_shared_by_logins");
      for (const h of holders) flagLogin(h.id);
      continue;
    }
    const login = holders[0]!;
    if (takenLogins.has(login.id)) { if (!problems.has(person.pin)) problems.set(person.pin, "login_linked_elsewhere"); continue; }
    links.push({ pin: person.pin, userId: login.id, source: "mobile" });
    takenLogins.add(login.id); takenPins.add(person.pin); loginState.set(login.id, "linked");
    problems.delete(person.pin);
  }
  return { links, problems, loginState };
}

async function load(exec: Db | Tx): Promise<{ staff: StaffRow[]; logins: UserRow[] }> {
  const staff = await exec.select({
    pin: attStaff.pin, mobile: attStaff.mobile, status: attStaff.status, aadhaarHash: attStaff.aadhaarHash,
    userId: attStaff.userId, needsAttention: attStaff.needsAttention,
  }).from(attStaff);
  // Active logins only: a deactivated account is nobody's attendance record to gain.
  const logins = await exec.select({ id: users.id, phone: users.phone, aadhaarHash: users.aadhaarHash }).from(users).where(eq(users.active, true));
  return { staff, logins };
}

/**
 * Link whoever can be linked, and bring every machine person's `needs_attention` up to date. Runs in
 * the caller's transaction: inside the staff stage of the sync, and when an administrator changes a
 * login's mobile or Aadhaar. Safe to run again — a second run links nobody new and writes nothing.
 */
export async function linkPeople(tx: Tx, now: Date): Promise<{ linked: number; needsAttention: number }> {
  const { staff, logins } = await load(tx);
  const { links, problems } = decideLinks(staff, logins);
  let linked = 0;
  for (const l of links) {
    // `user_id is null` in the WHERE is the "never re-point" rule held by the database as well.
    const done = await tx.update(attStaff)
      .set({ userId: l.userId, linkSource: l.source, linkedAt: now, needsAttention: null, updatedAt: now })
      .where(and(eq(attStaff.pin, l.pin), isNull(attStaff.userId)))
      .returning({ pin: attStaff.pin });
    if (done.length === 0) continue;
    linked += 1;
    await appendEvent(tx, attendancePersonLinked.make({ actor: LINK_ACTOR, occurredAt: now, payload: { pin: l.pin, userId: l.userId, source: l.source } }));
  }
  for (const s of staff) {
    if (s.userId !== null || links.some((l) => l.pin === s.pin)) continue;
    const want = problems.get(s.pin) ?? null;
    if (want !== s.needsAttention) await tx.update(attStaff).set({ needsAttention: want, updatedAt: now }).where(eq(attStaff.pin, s.pin));
  }
  return { linked, needsAttention: problems.size };
}

/** The Users screen's word per login: "Attendance linked" / "Not linked" / "Two matches". */
export async function linkStates(db: Db | Tx): Promise<Map<string, LinkState>> {
  const { staff, logins } = await load(db);
  return decideLinks(staff, logins).loginState;
}

/** The machine person a login is, or null. */
export async function pinOfUser(db: Db | Tx, userId: string): Promise<string | null> {
  const rows = await db.select({ pin: attStaff.pin }).from(attStaff).where(and(eq(attStaff.userId, userId), isNotNull(attStaff.userId)));
  return rows[0]?.pin ?? null;
}
