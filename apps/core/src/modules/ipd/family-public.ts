import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, sql, sum } from "drizzle-orm";
import { IPD_FAMILY_LIMITS, IPD_FAMILY_PURPOSE, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  ipdAdmissionConditions, ipdBedStays, ipdChargeLines, ipdFamilyCallbacks, ipdFamilyLinks, ipdFamilyOtps, ipdFamilySessions, patients,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { admissionAdvisoryLock, readAdmission } from "./admission-core";
import { bedWithWard } from "./beds";
import { attendantPhoneOf, dayOfStay, messageNameOf } from "./daily-totals";
import { depositPosition } from "./deposit-ladder";
import { familyTrackerOf } from "./discharge-read";
import { IpdError } from "./errors";
import { familyBlockOf, familyPhoneDigest, normalisePhone, sha256 } from "./family";
import { familyBillDetailsViewed, familyCallbackRequested, familyOtpSent, familyVerified } from "./family-events";
import { FamilyOtpUnavailable } from "./family-otp";
import type { Actor, IpdConditionWord, IpdFamilyBillDetails, IpdFamilyGate, IpdFamilyView } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";
import type { FamilyOtpSender } from "./family-otp";

/**
 * E3.3 (#731) — THE FAMILY LINK, PUBLIC SIDE. No staff session: the link's token is in the path, the browser holds two
 * http-only cookies the controller sets — a DEVICE id (minted on first open) and, after the OTP, a SESSION token (12 h).
 * Both are stored only as SHA-256. The link token travels in the request BODY (never a path the edge logs, #764). The OTP challenge is bound to the device that asked for it and the session to the
 * device that verified, so a code read off the phone cannot be redeemed from another browser, and a copied session
 * cookie needs the device cookie too (§4.10 edge 15).
 *
 * Limits (DECIDED): 3 OTP sends an hour per link, 5 wrong codes an hour per link, a code lives 10 minutes, a session 12
 * hours (never past "discharged + 24 h"), 5 callback requests a day per link. Every stamp is the server's clock (edge 18).
 *
 * The OPEN check runs on every request — the link active, the admission in a bed or within 24 h of its exit (discharged,
 * referred out, LAMA / DAMA), and no block (sealed, MLC, turned off) — so a death, an absconding or a new seal closes the
 * page at once, even before the revocation consumer runs.
 */
const FAMILY_ACTOR: Actor = { type: "system", id: "ipd-family-link" };
const HOUR_MS = 3_600_000;
const IN_BED = new Set(["admitted", "transferring", "fit_declared", "discharging"]);
const LEFT = new Set(["discharged", "transferred_out", "lama"]);

type LinkRow = typeof ipdFamilyLinks.$inferSelect;
type Open = { link: LinkRow; admission: AdmissionRow; discharged: boolean; closesAt: Date | null };

async function linkByToken(db: Db | Tx, token: string): Promise<LinkRow | undefined> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
  return (await db.select().from(ipdFamilyLinks).where(eq(ipdFamilyLinks.tokenHash, sha256(token))))[0];
}

/** The link if the page may show anything now; null when it is closed (revoked, expired, ended, blocked). */
async function openLink(db: Db | Tx, token: string, at: Date): Promise<Open | null> {
  const link = await linkByToken(db, token);
  if (link === undefined || link.status !== "active") return null;
  const a = await readAdmission(db, link.admissionId);
  if ((await familyBlockOf(db, a)) !== null) return null;
  if (IN_BED.has(a.state)) return { link, admission: a, discharged: false, closesAt: null };
  if (LEFT.has(a.state) && a.endedAt !== null) {
    const closesAt = new Date(a.endedAt.getTime() + IPD_FAMILY_LIMITS.dischargedHours * HOUR_MS);
    if (at < closesAt) return { link, admission: a, discharged: true, closesAt };
    // Past the 24 hours: the link expires (recorded the first time anyone opens it afterwards).
    await db.update(ipdFamilyLinks).set({ status: "expired", revokedAt: at, revokedReason: "discharged_24h" })
      .where(and(eq(ipdFamilyLinks.id, link.id), eq(ipdFamilyLinks.status, "active")));
  }
  return null;
}

/** Before the OTP: open or closed, and the masked phone the code would go to. No name, no ward. */
export async function familyGate(db: Db, token: string, cookies: { device?: string; session?: string }, at: Date = new Date()): Promise<IpdFamilyGate> {
  const o = await openLink(db, token, at);
  if (o === null) return { status: "closed", phoneMasked: null, purpose: IPD_FAMILY_PURPOSE };
  const s = cookies.session !== undefined && cookies.device !== undefined ? await liveSession(db, o.link.id, cookies.session, cookies.device, at) : undefined;
  return { status: s === undefined ? "needs_otp" : "verified", phoneMasked: o.link.phoneMasked, purpose: IPD_FAMILY_PURPOSE };
}

/**
 * Send an OTP to the registered phone — and only to it: the number is read from the recorded attendant reference at send
 * time and must HMAC to the phone the desk saw at issue. Nothing a caller sends chooses the number.
 *
 * Review #764: the challenge is COMMITTED first (under the admission lock, with the hourly count), then the SMS goes out
 * with no transaction and no lock held. A send that fails marks the challenge `failed_at` afterwards; a failed challenge
 * neither counts as one of the hour's sends nor verifies.
 */
export async function sendFamilyOtp(
  db: Db, token: string, deviceId: string, sender: FamilyOtpSender, opts: { at?: Date; secretKey: Buffer },
): Promise<{ phoneMasked: string; expiresAt: string }> {
  const at = opts.at ?? new Date();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const issued = await withTx(db, async (tx) => {
    const o = await openLink(tx, token, at);
    if (o === null) throw new IpdError("family_link_closed", "This link is closed. Please contact the ward desk.");
    await admissionAdvisoryLock(tx, o.admission.id);
    const [sent] = await tx.select({ n: count() }).from(ipdFamilyOtps).where(and(
      eq(ipdFamilyOtps.linkId, o.link.id), gt(ipdFamilyOtps.sentAt, new Date(at.getTime() - HOUR_MS)), isNull(ipdFamilyOtps.failedAt),
    ));
    if ((sent?.n ?? 0) >= IPD_FAMILY_LIMITS.otpSendsPerHour) {
      throw new IpdError("family_otp_limit", "Too many codes were sent in the last hour. Please try again later.", { retryAfterMinutes: 60 });
    }
    const phone = await attendantPhoneOf(tx, o.link.attendantKind as "guardian" | "deposit_payer", o.link.attendantRef);
    if (phone === null || familyPhoneDigest(opts.secretKey, phone) !== o.link.phoneHash) {
      throw new IpdError("family_phone_changed", "The registered phone has changed since this link was made. Please ask the ward desk for a new link.");
    }
    const challengeId = newId();
    const expiresAt = new Date(at.getTime() + IPD_FAMILY_LIMITS.otpTtlMinutes * 60_000);
    await tx.insert(ipdFamilyOtps).values({
      id: challengeId, linkId: o.link.id, codeHash: sha256(`${challengeId}:${code}`), deviceHash: sha256(deviceId), sentAt: at, expiresAt,
    });
    await appendEvent(tx, familyOtpSent.make({
      actor: FAMILY_ACTOR, occurredAt: at, correlationId: o.admission.id, patientId: o.admission.patientId,
      payload: { admissionId: o.admission.id, linkId: o.link.id, challengeId, provenance: "system" },
    }));
    return { challengeId, phone: normalisePhone(phone), phoneMasked: o.link.phoneMasked, expiresAt };
  });
  try {
    await sender.send(issued.phone, code);
  } catch (e) {
    await db.update(ipdFamilyOtps).set({ failedAt: new Date() }).where(eq(ipdFamilyOtps.id, issued.challengeId));
    if (e instanceof FamilyOtpUnavailable) throw new IpdError("family_otp_unavailable", "The code cannot be sent right now. Please ask the ward desk.");
    throw e;
  }
  return { phoneMasked: issued.phoneMasked, expiresAt: issued.expiresAt.toISOString() };
}

type Verdict =
  | { kind: "closed" } | { kind: "limit" } | { kind: "invalid"; message: string }
  | { kind: "ok"; sessionToken: string; expiresAt: Date };

/**
 * Check the code from the device that asked for it; answer the new session token (the controller sets the cookie).
 *
 * Review #764 — ONE TRANSACTION UNDER THE ADMISSION LOCK: the attempt is counted FIRST (`attempts = attempts + 1 …
 * returning`), the hour's wrong attempts are summed with it, and the limit is checked against that total BEFORE the code is
 * compared — so parallel guesses queue and at most five are ever compared. A right code gives its attempt back and stamps
 * `verified_at` only `where verified_at is null` (one code, one session). The verdict commits before any refusal is thrown.
 */
export async function verifyFamilyOtp(
  db: Db, token: string, deviceId: string, code: string, at: Date = new Date(),
): Promise<{ sessionToken: string; expiresAt: Date }> {
  const v = await withTx(db, async (tx): Promise<Verdict> => {
    const o = await openLink(tx, token, at);
    if (o === null) return { kind: "closed" };
    await admissionAdvisoryLock(tx, o.admission.id);
    const challenge = (await tx.select().from(ipdFamilyOtps).where(and(
      eq(ipdFamilyOtps.linkId, o.link.id), eq(ipdFamilyOtps.deviceHash, sha256(deviceId)), gt(ipdFamilyOtps.expiresAt, at),
      isNull(ipdFamilyOtps.failedAt),
    )).orderBy(desc(ipdFamilyOtps.sentAt)).limit(1))[0];
    if (challenge === undefined || challenge.verifiedAt !== null) return { kind: "invalid", message: "That code is not valid. Please ask for a new code." };
    const bumped = await tx.update(ipdFamilyOtps).set({ attempts: sql`${ipdFamilyOtps.attempts} + 1` })
      .where(eq(ipdFamilyOtps.id, challenge.id)).returning({ attempts: ipdFamilyOtps.attempts });
    if (bumped.length === 0) return { kind: "invalid", message: "That code is not valid. Please ask for a new code." };
    const [hour] = await tx.select({ n: sum(ipdFamilyOtps.attempts) }).from(ipdFamilyOtps)
      .where(and(eq(ipdFamilyOtps.linkId, o.link.id), gt(ipdFamilyOtps.sentAt, new Date(at.getTime() - HOUR_MS))));
    if (Number(hour?.n ?? 0) > IPD_FAMILY_LIMITS.otpAttemptsPerHour) return { kind: "limit" };
    const expected = Buffer.from(challenge.codeHash, "hex");
    const given = Buffer.from(sha256(`${challenge.id}:${code}`), "hex");
    if (!timingSafeEqual(expected, given)) return { kind: "invalid", message: "That code is not right. Please check the SMS and try again." };
    const used = await tx.update(ipdFamilyOtps).set({ verifiedAt: at, attempts: sql`${ipdFamilyOtps.attempts} - 1` })
      .where(and(eq(ipdFamilyOtps.id, challenge.id), isNull(ipdFamilyOtps.verifiedAt))).returning({ id: ipdFamilyOtps.id });
    if (used.length !== 1) return { kind: "invalid", message: "That code is not valid. Please ask for a new code." };
    const sessionToken = randomBytes(32).toString("base64url");
    const full = new Date(at.getTime() + IPD_FAMILY_LIMITS.sessionHours * HOUR_MS);
    const expiresAt = o.closesAt !== null && o.closesAt < full ? o.closesAt : full;
    const sessionId = newId();
    await tx.insert(ipdFamilySessions).values({
      id: sessionId, linkId: o.link.id, tokenHash: sha256(sessionToken), deviceHash: sha256(deviceId), createdAt: at, expiresAt,
    });
    await appendEvent(tx, familyVerified.make({
      actor: FAMILY_ACTOR, occurredAt: at, correlationId: o.admission.id, patientId: o.admission.patientId,
      payload: { admissionId: o.admission.id, linkId: o.link.id, sessionId, provenance: "system" },
    }));
    return { kind: "ok", sessionToken, expiresAt };
  });
  if (v.kind === "closed") throw new IpdError("family_link_closed", "This link is closed. Please contact the ward desk.");
  if (v.kind === "limit") throw new IpdError("family_otp_limit", "Too many wrong codes. Please try again after an hour.", { retryAfterMinutes: 60 });
  if (v.kind === "invalid") throw new IpdError("family_otp_invalid", v.message);
  return { sessionToken: v.sessionToken, expiresAt: v.expiresAt };
}

async function liveSession(db: Db | Tx, linkId: string, sessionToken: string, deviceId: string, at: Date) {
  return (await db.select().from(ipdFamilySessions).where(and(
    eq(ipdFamilySessions.tokenHash, sha256(sessionToken)), eq(ipdFamilySessions.linkId, linkId),
    eq(ipdFamilySessions.deviceHash, sha256(deviceId)), gt(ipdFamilySessions.expiresAt, at),
  )))[0];
}

/**
 * CN-1 (#977) — the admission a family link's VERIFIED session speaks for, or null (closed link, no session, wrong
 * device). The canteen's bed QR charges the IPD bill only through this: a photographed QR alone never can.
 */
export async function familyVerifiedAdmission(
  db: Db | Tx, token: string, cookies: { device?: string; session?: string }, at: Date = new Date(),
): Promise<string | null> {
  const o = await openLink(db, token, at);
  if (o === null || o.discharged || cookies.session === undefined || cookies.device === undefined) return null;
  return (await liveSession(db, o.link.id, cookies.session, cookies.device, at)) === undefined ? null : o.admission.id;
}

async function requireSession(db: Db | Tx, token: string, cookies: { device?: string; session?: string }, at: Date) {
  const o = await openLink(db, token, at);
  if (o === null) throw new IpdError("family_link_closed", "This link is closed. Please contact the ward desk.");
  if (cookies.session === undefined || cookies.device === undefined) throw new IpdError("family_session_required", "Please verify with the code sent to your phone.");
  const s = await liveSession(db, o.link.id, cookies.session, cookies.device, at);
  if (s === undefined) throw new IpdError("family_session_required", "Please verify with the code sent to your phone.");
  return { ...o, session: s };
}

/** The verified page (board G): name, ward, day, condition word, totals (no lines), tracker. */
export async function readFamilyView(db: Db, token: string, cookies: { device?: string; session?: string }, at: Date = new Date()): Promise<IpdFamilyView> {
  const { admission: a, discharged, session } = await requireSession(db, token, cookies, at);
  const p = (await db.select({ name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential })
    .from(patients).where(eq(patients.id, a.patientId)))[0];
  let ward: string | null = null;
  if (p !== undefined && !p.isConfidential) {
    const stay = (await db.select({ bedId: ipdBedStays.bedId }).from(ipdBedStays).where(eq(ipdBedStays.admissionId, a.id))
      .orderBy(desc(ipdBedStays.startedAt)).limit(1))[0];
    ward = stay === undefined ? null : (await bedWithWard(db, stay.bedId)).wardName;
  }
  const c = (await db.select().from(ipdAdmissionConditions).where(eq(ipdAdmissionConditions.admissionId, a.id)))[0];
  const pos = await depositPosition(db, a);
  const tr = await familyTrackerOf(db, a, at);
  const dayAt = a.endedAt !== null && a.endedAt < at ? a.endedAt : at;
  let todo: NonNullable<IpdFamilyView["tracker"]>["todo"] = "nothing";
  if (discharged) todo = "go_home";
  else if (tr !== null) {
    const now = tr.steps.find((s) => s.state === "now")?.key;
    if (now === "bill" && tr.billOwed) todo = "pay_bill";
    else if (now === "gate_pass" || now === "exit") todo = "collect_gate_pass";
    else if (now === "summary") todo = "wait_summary";
  }
  return {
    status: discharged ? "discharged" : "in_hospital",
    name: p === undefined ? "your patient" : messageNameOf(p),
    ward,
    dayOfStay: Math.max(1, dayOfStay(a.admittedAt ?? a.requestedAt, istDayString(dayAt))),
    condition: { word: (c?.word ?? null) as IpdConditionWord | null, setAt: c?.setAt?.toISOString() ?? null },
    totals: { billPaise: pos.billTotalPaise, depositPaise: pos.depositHeldPaise, balancePaise: pos.balancePaise, asOf: at.toISOString() },
    tracker: tr === null ? null : { steps: tr.steps, expectedAt: tr.expectedAt, todo },
    sessionExpiresAt: session.expiresAt.toISOString(),
    purpose: IPD_FAMILY_PURPOSE,
    todayUpdate: familyTodayProvider === null ? null : await familyTodayProvider(db, a.id, at),
  };
}

/**
 * ICU IC-1 (#984, D9) — THE "TODAY'S UPDATE" SEAM. The ICU module logs the doctor's daily word to the family; ipd cannot
 * import icu (icu imports ipd), so icu installs its reader here when it is loaded. Words only: the provider's type has no
 * room for a number from a monitor.
 */
export type FamilyTodayProvider = (db: Db, admissionId: string, at: Date) => Promise<{ summary: string; at: string; mode: string } | null>;
let familyTodayProvider: FamilyTodayProvider | null = null;
export function registerFamilyTodayProvider(fn: FamilyTodayProvider): () => void {
  familyTodayProvider = fn;
  return () => { if (familyTodayProvider === fn) familyTodayProvider = null; };
}

/** ⚖ The second, explicit step: the bill's lines (non-reversed), logged as an event every time. */
export async function readFamilyBillDetails(db: Db, token: string, cookies: { device?: string; session?: string }, at: Date = new Date()): Promise<IpdFamilyBillDetails> {
  const { admission: a, link, session } = await requireSession(db, token, cookies, at);
  const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id))
    .orderBy(asc(ipdChargeLines.serviceDate), asc(ipdChargeLines.postedAt), asc(ipdChargeLines.id));
  const reversed = new Set(lines.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  const live = lines.filter((l) => l.reversalOf === null && !reversed.has(l.id));
  await withTx(db, (tx) => appendEvent(tx, familyBillDetailsViewed.make({
    actor: FAMILY_ACTOR, occurredAt: at, correlationId: a.id, patientId: a.patientId,
    payload: { admissionId: a.id, linkId: link.id, sessionId: session.id, lines: live.length, provenance: "system" },
  })));
  return {
    lines: live.map((l) => ({ serviceDate: l.serviceDate, serviceName: l.serviceName, qty: l.qty, amountPaise: l.netPaise })),
    totalPaise: live.reduce((s, l) => s + l.netPaise, 0),
  };
}

/**
 * "Request a callback": the attendant's words go to the ward desk as a callback request — NEVER answered by a model or a
 * rule (§4.10 edge 14). The answer is only "the ward will call you".
 */
export async function requestFamilyCallback(
  db: Db, token: string, cookies: { device?: string; session?: string }, text: string, at: Date = new Date(),
): Promise<{ callbackId: string; status: "open" }> {
  return withTx(db, async (tx) => {
    const { admission: a, link } = await requireSession(tx, token, cookies, at);
    await admissionAdvisoryLock(tx, a.id);
    const [today] = await tx.select({ n: count() }).from(ipdFamilyCallbacks)
      .where(and(eq(ipdFamilyCallbacks.linkId, link.id), gt(ipdFamilyCallbacks.createdAt, new Date(at.getTime() - 24 * HOUR_MS))));
    if ((today?.n ?? 0) >= IPD_FAMILY_LIMITS.callbacksPerDay) {
      throw new IpdError("family_callback_limit", "The ward already has your requests. They will call you.");
    }
    const callbackId = newId();
    await tx.insert(ipdFamilyCallbacks).values({ id: callbackId, admissionId: a.id, linkId: link.id, text: text.trim(), status: "open", createdAt: at });
    await appendEvent(tx, familyCallbackRequested.make({
      actor: FAMILY_ACTOR, occurredAt: at, correlationId: a.id, patientId: a.patientId,
      payload: { admissionId: a.id, linkId: link.id, callbackId, provenance: "system" },
    }));
    return { callbackId, status: "open" as const };
  });
}
