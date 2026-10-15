import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { aadhaarHash, maskedAadhaar, normaliseAadhaar } from "./aadhaar";
import { userIdentityChanged } from "./events";
import { linkPeople, linkStates, normaliseMobile } from "./linking";
import { aadhaarKeyOf } from "./secrets";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { AttendanceConfig } from "./secrets";
import type { LinkState } from "./linking";

/**
 * ═══ ONE WRITER FOR A LOGIN'S MOBILE AND AADHAAR ═══
 *
 * Two routes set these: the Users screen's (`users-identity.controller.ts`, an administrator, any
 * login) and the person's own (`me-identity.controller.ts`, "Add your Aadhaar", owner 2026-10-09).
 * Both go through THIS file, so the validation, the keyed hash, the event and the in-transaction
 * link attempt cannot drift apart.
 *
 * THE AADHAAR NUMBER PASSES THROUGH `aadhaarChange` AND IS DROPPED THERE: what leaves it is the hash
 * and the last four digits. A refusal names the rule that failed, never the number.
 */

/** A mobile to store: a string sets, `null` removes. Refused when it is not a ten-digit Indian mobile. */
export function mobileChange(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const phone = normaliseMobile(raw);
  if (phone === null) throw new BadRequestException({ code: "mobile_invalid", message: "a mobile is ten digits starting 6 to 9" });
  return phone;
}

/** An Aadhaar to store, as hash + last four; `null` removes. Refused without a key, or when it is not a valid number. */
export function aadhaarChange(raw: string | null, cfg: AttendanceConfig, nowMs: number): { hash: string; last4: string } | null {
  if (raw === null || raw.trim() === "") return null;
  const key = aadhaarKeyOf(cfg, nowMs);
  if (key === null) throw new ConflictException({ code: "aadhaar_key_not_configured", message: "the Aadhaar linking key is not set up on this server" });
  const n = normaliseAadhaar(raw);
  if (!n.ok) throw new BadRequestException({ code: "aadhaar_invalid", problem: n.problem, message: "that is not a valid Aadhaar number" });
  return { hash: aadhaarHash(n.digits, key)!, last4: n.digits.slice(-4) };
}

export type IdentityWritten = { userId: string; mobile: string | null; aadhaar: string | null; attendance: LinkState };

/** The row a write starts from, locked for the rest of the transaction. 404 when there is no such login. */
export async function lockIdentity(tx: Tx, userId: string): Promise<{ id: string; username: string; phone: string | null; aadhaarHash: string | null; last4: string | null }> {
  const user = (await tx.select({ id: users.id, username: users.username, phone: users.phone, aadhaarHash: users.aadhaarHash, last4: users.aadhaarLast4 }).from(users).where(eq(users.id, userId)).for("update"))[0];
  if (user === undefined) throw new NotFoundException({ code: "user_not_found" });
  return user;
}

/**
 * Apply a change to a login locked by `lockIdentity`. `undefined` leaves a field alone. One event per
 * field that actually changed (WHICH and "set"/"removed", never WHAT), then — "whenever a user's phone
 * or Aadhaar changes" — the link is tried at once, in this transaction.
 */
export async function writeIdentity(
  tx: Tx, actor: Actor, now: Date, user: Awaited<ReturnType<typeof lockIdentity>>,
  change: { phone?: string | null; aadhaar?: { hash: string; last4: string } | null },
): Promise<IdentityWritten> {
  const set: { phone?: string | null; aadhaarHash?: string | null; aadhaarLast4?: string | null } = {};
  if (change.phone !== undefined && change.phone !== user.phone) {
    set.phone = change.phone;
    await appendEvent(tx, userIdentityChanged.make({ actor, occurredAt: now, payload: { userId: user.id, username: user.username, field: "mobile", change: change.phone === null ? "removed" : "set" } }));
  }
  if (change.aadhaar !== undefined && (change.aadhaar?.hash ?? null) !== user.aadhaarHash) {
    set.aadhaarHash = change.aadhaar?.hash ?? null;
    set.aadhaarLast4 = change.aadhaar?.last4 ?? null;
    await appendEvent(tx, userIdentityChanged.make({ actor, occurredAt: now, payload: { userId: user.id, username: user.username, field: "aadhaar", change: change.aadhaar === null ? "removed" : "set" } }));
  }
  if (Object.keys(set).length > 0) {
    await tx.update(users).set({ ...set, updatedAt: now }).where(eq(users.id, user.id));
    await linkPeople(tx, now);
  }
  const last4 = set.aadhaarLast4 !== undefined ? set.aadhaarLast4 : user.last4;
  return {
    userId: user.id, mobile: set.phone !== undefined ? set.phone : user.phone, aadhaar: last4 === null ? null : maskedAadhaar(last4),
    attendance: (await linkStates(tx)).get(user.id) ?? "not_linked",
  };
}
