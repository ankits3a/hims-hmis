import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { defineEvent, newId } from "@hmis/contracts";
import { agents, printComputers, printEnrolmentCodes, printJobs } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import { randomInt } from "node:crypto";
import type { Db, Tx } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COUNTER'S OWN PRINT PROGRAM — enrolment, liveness, and routing a paper to one computer
 * (owner 2026-10-07: "If you can make a program that runs on windows operating system then I have
 * no problem" — decision 0047; narrows 0002, follows 0045)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ONE COMPUTER, ONE AGENT, ONE DESTINATION. The claim route already intersects what a relay asks for
 * with `agents.print_destinations` (WASA M-10), so giving each counter PC its own agent whose only
 * grant is `counter:<its id>:a4` makes "a program can fetch only its own counter's paper" a property
 * of the existing guard rather than of a new one. Revoking is the agent's kill switch, which
 * `AuthGuard` reads on every request — the program's next poll is refused.
 *
 * A JOB IS BORN SITE-WIDE AND SENT TO A COMPUTER BY THE DESK THAT WANTS IT. The enqueue rides the
 * visit's transaction and cannot know which browser will hand the paper over, so the row keeps its
 * declared destination (`front_desk_a4`) until the counter's browser says "print this on the
 * computer I am sitting at" (`sendJobToComputer`). Until then it is exactly the job decision 0045
 * describes, and the browser can still print it.
 */

export const COUNTER_DESTINATION_PREFIX = "counter:";
/** A code is read out across a room and typed once. */
export const ENROLMENT_CODE_MINUTES = 15;
/** DECIDED: a computer that has not asked for work for this long is offline and the browser prints. */
export const PRINT_COMPUTER_ALIVE_SECONDS = 90;
/** `last_seen_at` is rewritten at most this often — the program polls every three seconds. */
const SEEN_WRITE_SECONDS = 20;
/** Unambiguous when read aloud: no 0/O, 1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function counterDestination(computerId: string): string {
  return `${COUNTER_DESTINATION_PREFIX}${computerId}:a4`;
}
export function isCounterDestination(destination: string): boolean {
  return destination.startsWith(COUNTER_DESTINATION_PREFIX);
}

/** The documents a counter program may be sent: A4 paper only (no counter has a roll printer). */
export const COUNTER_A4_DESTINATIONS: readonly string[] = ["front_desk_a4"];

export const printComputerCodeIssued = defineEvent(
  "print.computer_code_issued", "printing",
  z.object({ codeId: z.string(), name: z.string(), expiresAt: z.string() }),
);
export const printComputerEnrolled = defineEvent(
  "print.computer_enrolled", "printing",
  z.object({ computerId: z.string(), agentId: z.string(), name: z.string(), codeId: z.string(), platform: z.string().nullable(), appVersion: z.string().nullable() }),
);
export const printComputerRevoked = defineEvent(
  "print.computer_revoked", "printing",
  z.object({ computerId: z.string(), agentId: z.string(), name: z.string() }),
);
export const printJobSentToComputer = defineEvent(
  "print.job_sent_to_computer", "printing",
  z.object({ jobId: z.string(), computerId: z.string(), document: z.string(), from: z.string() }),
);
export const PRINT_COMPUTER_EVENTS = [printComputerCodeIssued, printComputerEnrolled, printComputerRevoked, printJobSentToComputer] as const;

export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function newCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
/** As shown and as read out: `ABCD-EFGH`. */
export function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function issueEnrolmentCode(db: Db | Tx, input: { name: string; createdBy: string; now?: Date }): Promise<{ id: string; code: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const code = newCode();
  const id = newId();
  const expiresAt = new Date(now.getTime() + ENROLMENT_CODE_MINUTES * 60_000);
  await db.insert(printEnrolmentCodes).values({ id, codeHash: sha256Hex(code), name: input.name.trim().slice(0, 80), expiresAt, createdBy: input.createdBy, createdAt: now });
  return { id, code: displayCode(code), expiresAt };
}

export type Enrolled = { computerId: string; agentId: string; agentKey: string; destination: string; name: string; codeId: string };

/**
 * Spends a code. The UPDATE both proves the code unused and unexpired and marks it used, so a
 * second installer with the same code gets null — never a second computer.
 */
export async function enrolComputer(
  tx: Tx,
  input: { code: string; platform?: string | null; appVersion?: string | null; now?: Date },
): Promise<Enrolled | null> {
  const now = input.now ?? new Date();
  const code = normaliseCode(input.code);
  if (code.length !== 8) return null;
  const spent = await tx
    .update(printEnrolmentCodes)
    .set({ usedAt: now })
    .where(and(eq(printEnrolmentCodes.codeHash, sha256Hex(code)), isNull(printEnrolmentCodes.usedAt), gt(printEnrolmentCodes.expiresAt, now)))
    .returning({ id: printEnrolmentCodes.id, name: printEnrolmentCodes.name, createdBy: printEnrolmentCodes.createdBy });
  const row = spent[0];
  if (row === undefined) return null;

  const computerId = newId();
  const agentId = newId();
  const agentKey = randomToken();
  const destination = counterDestination(computerId);
  // The agent's name is unique; the computer id makes it so whatever the administrator typed.
  await tx.insert(agents).values({ id: agentId, name: `print-computer:${computerId}`, apiKeyHash: sha256Hex(agentKey), printDestinations: [destination] });
  await tx.insert(printComputers).values({
    id: computerId, agentId, name: row.name, platform: input.platform ?? null, appVersion: input.appVersion ?? null,
    lastSeenAt: now, createdBy: row.createdBy, createdAt: now,
  });
  await tx.update(printEnrolmentCodes).set({ computerId }).where(eq(printEnrolmentCodes.id, row.id));
  return { computerId, agentId, agentKey, destination, name: row.name, codeId: row.id };
}

export type ComputerRow = typeof printComputers.$inferSelect;

export function computerAlive(row: Pick<ComputerRow, "lastSeenAt" | "revokedAt">, now: Date = new Date()): boolean {
  if (row.revokedAt !== null || row.lastSeenAt === null) return false;
  return now.getTime() - row.lastSeenAt.getTime() <= PRINT_COMPUTER_ALIVE_SECONDS * 1000;
}

export async function listComputers(db: Db | Tx): Promise<ComputerRow[]> {
  const rows = await db.select().from(printComputers);
  return rows.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

export async function getComputer(db: Db | Tx, id: string): Promise<ComputerRow | null> {
  const rows = await db.select().from(printComputers).where(eq(printComputers.id, id));
  return rows[0] ?? null;
}

/**
 * The program asked for work (or reported itself). Rewritten at most every `SEEN_WRITE_SECONDS` so
 * a three-second poll is not a write every three seconds; what it reports is written when given.
 */
export async function touchComputer(
  db: Db | Tx,
  agentId: string,
  report: { printer?: string | null; printers?: string[]; platform?: string | null; appVersion?: string | null } = {},
  now: Date = new Date(),
): Promise<void> {
  const stale = new Date(now.getTime() - SEEN_WRITE_SECONDS * 1000);
  const set: Partial<typeof printComputers.$inferInsert> = { lastSeenAt: now };
  const reporting = report.printer !== undefined || report.printers !== undefined || report.appVersion !== undefined || report.platform !== undefined;
  if (report.printer !== undefined) set.printer = report.printer === null ? null : report.printer.slice(0, 200);
  if (report.printers !== undefined) set.printers = report.printers.slice(0, 40).map((p) => p.slice(0, 200));
  if (report.platform !== undefined) set.platform = report.platform === null ? null : report.platform.slice(0, 40);
  if (report.appVersion !== undefined) set.appVersion = report.appVersion === null ? null : report.appVersion.slice(0, 40);
  await db.update(printComputers).set(set).where(and(
    eq(printComputers.agentId, agentId),
    isNull(printComputers.revokedAt),
    reporting ? sql`true` : or(isNull(printComputers.lastSeenAt), lt(printComputers.lastSeenAt, stale)),
  ));
}

/** Ends a computer: its agent's kill switch goes on (the next poll is refused) and its paper goes back to the site. */
export async function revokeComputer(tx: Tx, id: string, revokedBy: string, now: Date = new Date()): Promise<ComputerRow | null> {
  const rows = await tx.update(printComputers).set({ revokedAt: now, revokedBy })
    .where(and(eq(printComputers.id, id), isNull(printComputers.revokedAt))).returning();
  const row = rows[0];
  if (row === undefined) return null;
  await tx.update(agents).set({ killSwitch: true, printDestinations: [] }).where(eq(agents.id, row.agentId));
  // Paper that was waiting for this computer is nobody's now: hand it back so a browser can print it.
  await tx.update(printJobs)
    .set({ destination: "front_desk_a4", status: "queued", claimedBy: null, claimedAt: null, leaseExpiresAt: null, nextAttemptAt: null, updatedAt: now })
    .where(and(eq(printJobs.destination, counterDestination(id)), inArray(printJobs.status, ["queued", "claimed"])));
  return row;
}

export type SendOutcome = "sent" | "offline" | "no_printer" | "not_sendable" | "unknown_computer";

/**
 * "Print this on the computer I am sitting at." Only a job nobody holds (`queued`, `failed`) and
 * only A4 paper; only to a computer that is alive, so a paper is never parked behind a PC that is
 * switched off — the caller prints in the browser instead (0045). The row is re-armed as a fresh
 * queued job for the counter's destination: attempts back to zero, because the failures it carried
 * were some other printer's.
 */
export async function sendJobToComputer(
  tx: Tx,
  input: { jobId: string; computerId: string; now?: Date },
): Promise<{ outcome: SendOutcome; document: string | null; from: string | null }> {
  const now = input.now ?? new Date();
  const computer = await getComputer(tx, input.computerId);
  if (computer === null) return { outcome: "unknown_computer", document: null, from: null };
  if (!computerAlive(computer, now)) return { outcome: "offline", document: null, from: null };
  // Running, but nobody has chosen its printer yet (or the program has not reported one): a paper
  // sent now would be claimed and failed three times. The browser prints it instead.
  if (computer.printer === null || computer.printer.trim() === "") return { outcome: "no_printer", document: null, from: null };
  const dest = counterDestination(computer.id);
  const rows = await tx.select({ document: printJobs.document, destination: printJobs.destination, status: printJobs.status })
    .from(printJobs).where(eq(printJobs.id, input.jobId));
  const job = rows[0];
  if (job === undefined) return { outcome: "not_sendable", document: null, from: null };
  const a4 = COUNTER_A4_DESTINATIONS.includes(job.destination) || isCounterDestination(job.destination);
  if (!a4) return { outcome: "not_sendable", document: job.document, from: job.destination };
  const moved = await tx.update(printJobs)
    .set({ destination: dest, status: "queued", attempts: 0, lastError: null, nextAttemptAt: null, claimedBy: null, claimedAt: null, leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(printJobs.id, input.jobId), inArray(printJobs.status, ["queued", "failed"])))
    .returning({ id: printJobs.id });
  return { outcome: moved.length > 0 ? "sent" : "not_sendable", document: job.document, from: job.destination };
}
