import { and, desc, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { assertNotSodPair, SodViolationError } from "../../kernel/auth/sod";
import { hasPermission } from "../../kernel/auth/permissions";
import { verifyPinByUsername } from "../../kernel/auth/identity";
import { clearThrottle, recordThrottleFailure, throttleRetryAt } from "../../kernel/auth/throttle";
import { withTx } from "../../kernel/db/client";
import { pharmacyControlledLicences, pharmacyEndPrescribers, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { findStoreByCode, isControlledStore } from "../materials";
import { getDoctor, listDoctors } from "../opd";
import { CONTROLLED_STORE_CODE, LICENCE_RENEWAL_NOTICE_DAYS, isIsoDate, istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { controlledLicenceRecorded, endPrescriberEnded, endPrescriberRecorded } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { StoreRow } from "../materials";

/**
 * ═══ PHARMACY P6 — NARCOTIC, PSYCHOTROPIC AND SCHEDULE X DRUGS UNDER THE LAW ═══
 *
 * Brief: `docs/superpowers/plans/2026-09-26-pharmacy-p6-ndps-schedule-x-law.md`. This file holds what the
 * counter and the office both ask:
 *
 *   - **Which lines are controlled** (`controlOf`): Schedule X (`schedule_flag = 'X'`), or an NDPS class
 *     on the medicine's moieties (`formulary/ndps.ts`). A controlled line is picked from the cabinet
 *     (`PHARM-NDPS`) and handed over under two keys.
 *   - **The licences** (`pharmacy_controlled_licences`): RMI recognition (Form 3G) covers the narcotic
 *     drugs, the Form 20F retail licence covers Schedule X. No current licence → the line is refused, and
 *     the refusal names the licence (`assertControlledLinesAllowed`).
 *   - **The trained prescribers** (`pharmacy_end_prescribers`, NDPS Rules r.2(ib)).
 *   - **The second key** (`verifyWitness`): a witness proves they are present with their own username and
 *     PIN at the same terminal (the shared-terminal switch's credential, throttled by the same counter),
 *     holds `pharmacy.ndps.witness`, and is never the holder (`narcotics_issuer_witness`, SoD engine).
 */
export const CUSTODY_PERMISSION = "pharmacy.ndps.custody";
export const WITNESS_PERMISSION = "pharmacy.ndps.witness";
export const LICENCES_PERMISSION = "pharmacy.licences.manage";

export const CONTROLLED_LICENCE_KINDS = ["ndps_rmi", "schedule_x"] as const;
export type ControlledLicenceKind = (typeof CONTROLLED_LICENCE_KINDS)[number];

/** How each licence is named in a refusal and on the screen — the words on the certificate. */
export const LICENCE_NAMES: Record<ControlledLicenceKind, string> = {
  ndps_rmi: "recognition as a Recognised Medical Institution (NDPS Rules r.52-O, Form 3G)",
  schedule_x: "the Schedule X retail drug licence (D&C Rules r.61(3), Form 20F)",
};

export type LineControl = {
  controlled: boolean;
  scheduleX: boolean;
  ndpsClass: "narcotic" | "psychotropic" | null;
};

/** The one definition of "controlled": Schedule X, or any NDPS class. */
export function controlOf(scheduleFlag: string | null | undefined, ndpsClass: string | null | undefined): LineControl {
  const cls = ndpsClass === "narcotic" || ndpsClass === "psychotropic" ? ndpsClass : null;
  const scheduleX = scheduleFlag === "X";
  return { controlled: scheduleX || cls !== null, scheduleX, ndpsClass: cls };
}

export function requirePerson(actor: Actor, what: string): string {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", `${what} is a person's act`);
  return actor.id;
}

async function requireGrant(db: Db | Tx, actor: Actor, permission: string, what: string): Promise<string> {
  const id = requirePerson(actor, what);
  if (!(await hasPermission(db as Db, id, permission, "hospital"))) {
    throw new PharmacyError(permission === CUSTODY_PERMISSION ? "custody_not_permitted" : "permission_denied", `${what} needs ${permission}`);
  }
  return id;
}

/** The holder of a cabinet key: a person with `pharmacy.ndps.custody`. */
export async function requireCustodian(db: Db | Tx, actor: Actor, what: string): Promise<string> {
  return requireGrant(db, actor, CUSTODY_PERMISSION, what);
}

// ═══════════════════════════════════ THE CABINET ═══════════════════════════════════

export async function controlledStore(db: Db | Tx): Promise<StoreRow | undefined> {
  const store = await findStoreByCode(db, CONTROLLED_STORE_CODE);
  return store !== undefined && isControlledStore(store) ? store : undefined;
}

export async function requireControlledStore(db: Db | Tx): Promise<StoreRow> {
  const store = await controlledStore(db);
  if (store === undefined) {
    throw new PharmacyError(
      "controlled_store_missing",
      `there is no controlled-drug cabinet "${CONTROLLED_STORE_CODE}" — seed:pharmacy creates it on deploy; until then no narcotic or Schedule X drug moves`,
    );
  }
  return store;
}

// ═══════════════════════════════════ THE LICENCES ═══════════════════════════════════

export type ControlledLicenceView = {
  id: string; kind: ControlledLicenceKind; licenceNo: string; form: string; issuingAuthority: string; holderName: string;
  responsiblePerson: string; validFrom: string; validUntil: string; documentRef: string | null; note: string | null;
  recordedBy: string; recordedAt: string;
};
export type ControlledLicenceState = {
  kind: ControlledLicenceKind;
  name: string;
  /** `current` is the only state in which the drugs it covers are dispensed. */
  state: "missing" | "not_yet_valid" | "lapsed" | "current";
  licence: ControlledLicenceView | null;
  daysLeft: number | null;
  /** Inside the last `LICENCE_RENEWAL_NOTICE_DAYS` (r.52-O: renewal is applied for 60 days ahead). */
  renewalDue: boolean;
};

type LicenceRow = typeof pharmacyControlledLicences.$inferSelect;
function licenceView(r: LicenceRow): ControlledLicenceView {
  return {
    id: r.id, kind: r.kind as ControlledLicenceKind, licenceNo: r.licenceNo, form: r.form, issuingAuthority: r.issuingAuthority,
    holderName: r.holderName, responsiblePerson: r.responsiblePerson, validFrom: r.validFrom, validUntil: r.validUntil,
    documentRef: r.documentRef, note: r.note, recordedBy: r.recordedBy, recordedAt: r.recordedAt.toISOString(),
  };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

async function latestLicence(db: Db | Tx, kind: ControlledLicenceKind): Promise<LicenceRow | undefined> {
  const [row] = await db.select().from(pharmacyControlledLicences)
    .where(eq(pharmacyControlledLicences.kind, kind))
    .orderBy(desc(pharmacyControlledLicences.recordedAt), desc(pharmacyControlledLicences.id))
    .limit(1);
  return row;
}

/** Each licence as the counter, the office and the census read it. Never refuses. */
export async function controlledLicenceStates(db: Db | Tx, now: Date): Promise<Record<ControlledLicenceKind, ControlledLicenceState>> {
  const today = istDateOf(now);
  const out = {} as Record<ControlledLicenceKind, ControlledLicenceState>;
  for (const kind of CONTROLLED_LICENCE_KINDS) {
    const row = await latestLicence(db, kind);
    if (row === undefined) {
      out[kind] = { kind, name: LICENCE_NAMES[kind], state: "missing", licence: null, daysLeft: null, renewalDue: false };
      continue;
    }
    const state = today < row.validFrom ? "not_yet_valid" : today > row.validUntil ? "lapsed" : "current";
    const daysLeft = daysBetween(today, row.validUntil);
    out[kind] = {
      kind, name: LICENCE_NAMES[kind], state, licence: licenceView(row), daysLeft,
      renewalDue: state === "current" && daysLeft <= LICENCE_RENEWAL_NOTICE_DAYS,
    };
  }
  return out;
}

export async function listControlledLicences(db: Db, actor: Actor): Promise<ControlledLicenceView[]> {
  await requireAnyGrant(db, actor, [LICENCES_PERMISSION, CUSTODY_PERMISSION], "reading the controlled-drug licences");
  const rows = await db.select().from(pharmacyControlledLicences)
    .orderBy(desc(pharmacyControlledLicences.recordedAt), desc(pharmacyControlledLicences.id)).limit(100);
  return rows.map(licenceView);
}

async function requireAnyGrant(db: Db | Tx, actor: Actor, permissions: readonly string[], what: string): Promise<string> {
  const id = requirePerson(actor, what);
  for (const p of permissions) if (await hasPermission(db as Db, id, p, "hospital")) return id;
  throw new PharmacyError("permission_denied", `${what} needs ${permissions.join(" or ")}`);
}

export type RecordControlledLicenceInput = {
  kind: ControlledLicenceKind; licenceNo: string; form: string; issuingAuthority: string; holderName: string; responsiblePerson: string;
  validFrom: string; validUntil: string; documentRef?: string | null; note?: string | null;
};

/** A new licence row: a renewal or a correction is another row, and the latest of a kind is the licence. */
export async function recordControlledLicence(db: Db, actor: Actor, input: RecordControlledLicenceInput, now: Date): Promise<ControlledLicenceView> {
  const userId = await requireGrant(db, actor, LICENCES_PERMISSION, "recording a controlled-drug licence");
  if (!(CONTROLLED_LICENCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new PharmacyError("invalid_controlled_licence", `"${String(input.kind)}" is not a controlled-drug licence this pharmacy keeps`);
  }
  const text = {
    licenceNo: input.licenceNo.trim(), form: input.form.trim(), issuingAuthority: input.issuingAuthority.trim(),
    holderName: input.holderName.trim(), responsiblePerson: input.responsiblePerson.trim(),
  };
  const blank = Object.entries(text).filter(([, v]) => v === "").map(([k]) => k);
  if (blank.length > 0) {
    throw new PharmacyError("invalid_controlled_licence", `the licence number, its form, the issuing authority, the holder and the responsible person are all required — missing: ${blank.join(", ")}`, { missing: blank });
  }
  if (!isIsoDate(input.validFrom) || !isIsoDate(input.validUntil) || input.validUntil < input.validFrom) {
    throw new PharmacyError("invalid_controlled_licence", "the licence needs a valid-from and a valid-until date, the second not before the first");
  }
  // r.52-O: recognition is granted "for a period not exceeding three years at a time".
  if (input.kind === "ndps_rmi" && daysBetween(input.validFrom, input.validUntil) > 3 * 366) {
    throw new PharmacyError("invalid_controlled_licence", "RMI recognition runs at most three years at a time (NDPS Rules r.52-O) — check the dates on Form 3G");
  }
  const clean = (s: string | null | undefined): string | null => (s === undefined || s === null || s.trim() === "" ? null : s.trim());
  const id = newId();
  await withTx(db, async (tx) => {
    await tx.insert(pharmacyControlledLicences).values({
      id, kind: input.kind, ...text, validFrom: input.validFrom, validUntil: input.validUntil,
      documentRef: clean(input.documentRef), note: clean(input.note), recordedBy: userId, recordedAt: now,
    });
    await appendEvent(tx, controlledLicenceRecorded.make({
      occurredAt: now, actor,
      payload: { licenceId: id, kind: input.kind, licenceNo: text.licenceNo, form: text.form, validFrom: input.validFrom, validUntil: input.validUntil },
    }));
  });
  return licenceView((await latestLicence(db, input.kind))!);
}

// ═══════════════════════════════ THE TRAINED PRESCRIBERS (r.2(ib)) ═══════════════════════════════

export type EndPrescriberView = {
  id: string; doctorId: string; doctorName: string; registrationNo: string | null; training: string;
  recordedBy: string; recordedAt: string; endedAt: string | null; endReason: string | null;
};

export async function listEndPrescribers(db: Db, actor: Actor): Promise<{ current: EndPrescriberView[]; doctors: { id: string; name: string; registrationNo: string | null }[] }> {
  await requireAnyGrant(db, actor, [LICENCES_PERMISSION, CUSTODY_PERMISSION], "reading the trained prescribers");
  const rows = await db.select().from(pharmacyEndPrescribers).where(isNull(pharmacyEndPrescribers.endedAt));
  const doctors = await listDoctors(db, { activeOnly: true });
  const byId = new Map(doctors.map((d) => [d.id, d]));
  return {
    current: rows.map((r) => ({
      id: r.id, doctorId: r.doctorId, doctorName: byId.get(r.doctorId)?.displayName ?? r.doctorId,
      registrationNo: byId.get(r.doctorId)?.registrationNo ?? null, training: r.training, recordedBy: r.recordedBy,
      recordedAt: r.recordedAt.toISOString(), endedAt: null, endReason: null,
    })).sort((a, b) => a.doctorName.localeCompare(b.doctorName)),
    doctors: doctors.map((d) => ({ id: d.id, name: d.displayName, registrationNo: d.registrationNo ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function recordEndPrescriber(db: Db, actor: Actor, input: { doctorId: string; training: string }, now: Date): Promise<{ id: string }> {
  const userId = await requireGrant(db, actor, LICENCES_PERMISSION, "recording a trained prescriber");
  const training = input.training.trim();
  if (training === "") throw new PharmacyError("invalid_end_prescriber", "name the training (the course, who ran it, the year) as the certificate says");
  const doctor = await getDoctor(db, input.doctorId);
  if (doctor === null) throw new PharmacyError("invalid_end_prescriber", `doctor ${input.doctorId} is not a doctor of this hospital`);
  const id = newId();
  await withTx(db, async (tx) => {
    const [open] = await tx.select({ id: pharmacyEndPrescribers.id }).from(pharmacyEndPrescribers)
      .where(and(eq(pharmacyEndPrescribers.doctorId, input.doctorId), isNull(pharmacyEndPrescribers.endedAt)));
    if (open !== undefined) throw new PharmacyError("invalid_end_prescriber", `${doctor.displayName}'s training is already on file — end that entry to replace it`);
    await tx.insert(pharmacyEndPrescribers).values({ id, doctorId: input.doctorId, training, recordedBy: userId, recordedAt: now });
    await appendEvent(tx, endPrescriberRecorded.make({ occurredAt: now, actor, payload: { entryId: id, doctorId: input.doctorId, training } }));
  });
  return { id };
}

export async function endEndPrescriber(db: Db, actor: Actor, entryId: string, reason: string, now: Date): Promise<void> {
  const userId = await requireGrant(db, actor, LICENCES_PERMISSION, "ending a trained-prescriber entry");
  const why = reason.trim();
  if (why.length < 3) throw new PharmacyError("invalid_end_prescriber", "say why the entry ends (the doctor left, recorded in error …)");
  await withTx(db, async (tx) => {
    const won = await tx.update(pharmacyEndPrescribers).set({ endedAt: now, endedBy: userId, endReason: why })
      .where(and(eq(pharmacyEndPrescribers.id, entryId), isNull(pharmacyEndPrescribers.endedAt)))
      .returning({ doctorId: pharmacyEndPrescribers.doctorId });
    if (won.length === 0) throw new PharmacyError("unknown_end_prescriber", `no current trained-prescriber entry ${entryId}`);
    await appendEvent(tx, endPrescriberEnded.make({ occurredAt: now, actor, payload: { entryId, doctorId: won[0]!.doctorId, reason: why } }));
  });
}

/** The census's question: is any doctor's r.2(ib) training on file? */
export async function anyEndPrescriber(db: Db | Tx): Promise<boolean> {
  const rows = await db.select({ id: pharmacyEndPrescribers.id }).from(pharmacyEndPrescribers).where(isNull(pharmacyEndPrescribers.endedAt)).limit(1);
  return rows.length > 0;
}

export async function isEndPrescriber(db: Db | Tx, doctorId: string): Promise<boolean> {
  const [row] = await db.select({ id: pharmacyEndPrescribers.id }).from(pharmacyEndPrescribers)
    .where(and(eq(pharmacyEndPrescribers.doctorId, doctorId), isNull(pharmacyEndPrescribers.endedAt)));
  return row !== undefined;
}

// ═══════════════════════════════════ THE GATE ═══════════════════════════════════

export type ControlledLine = { lineIdx: number; drug: string; scheduleFlag: string | null; ndpsClass: string | null };

function stateSentence(s: ControlledLicenceState): string {
  if (s.state === "missing") return "none is on file";
  if (s.state === "not_yet_valid") return `licence ${s.licence!.licenceNo} is valid only from ${s.licence!.validFrom}`;
  return `licence ${s.licence!.licenceNo} lapsed on ${s.licence!.validUntil}`;
}

/**
 * THE EXISTING REFUSAL STAYS WHERE THE LICENCE IS MISSING. A Schedule X line is refused
 * (`schedule_x_not_dispensed_here`) unless the Form 20F licence covers today; a narcotic line
 * (`ndps_not_dispensed_here`) unless the RMI recognition does. Asked at the claim, at the verify and at
 * the hand-over — every gate that can name a medicine (the R-3 rule). A psychotropic line needs no NDPS
 * licence (r.66: the hospital's drug licence covers it) but is still handed over under two keys. The
 * `detail` is the one R-3 always carried; the sentence names the licence and why it does not cover today.
 */
export async function assertControlledLinesAllowed(db: Db | Tx, lines: readonly ControlledLine[], now: Date): Promise<void> {
  const controlled = lines.filter((l) => controlOf(l.scheduleFlag, l.ndpsClass).controlled);
  if (controlled.length === 0) return;
  const states = await controlledLicenceStates(db, now);
  for (const l of controlled) {
    const c = controlOf(l.scheduleFlag, l.ndpsClass);
    const n = String(l.lineIdx + 1);
    if (c.scheduleX && states.schedule_x.state !== "current") {
      throw new PharmacyError(
        "schedule_x_not_dispensed_here",
        `line ${n} (${l.drug}) is Schedule X, dispensed only under a current Schedule X retail drug licence (Form 20F, D&C Rules r.61(3)) — ${stateSentence(states.schedule_x)}; the pharmacist in charge records it at the pharmacy office → Controlled`,
        { lineIdx: l.lineIdx, scheduleFlag: l.scheduleFlag },
      );
    }
    if (c.ndpsClass === "narcotic" && states.ndps_rmi.state !== "current") {
      throw new PharmacyError(
        "ndps_not_dispensed_here",
        `line ${n} (${l.drug}) is a narcotic drug under the NDPS Act, dispensed only by a hospital holding current recognition as a Recognised Medical Institution (Form 3G, NDPS Rules r.52-O) — ${stateSentence(states.ndps_rmi)}; the pharmacist in charge records it at the pharmacy office → Controlled`,
        { lineIdx: l.lineIdx, ndpsClass: c.ndpsClass },
      );
    }
  }
}

// ═══════════════════════════════════ THE SECOND KEY ═══════════════════════════════════

export type WitnessInput = { username: string; pin: string };

/**
 * The witness proves presence with THEIR username and PIN at the holder's terminal. Throttled on the
 * shared-terminal PIN counter (`kernel/auth/throttle`, kind `pin`): a guessed PIN costs the same here as
 * at the switch. A wrong PIN and an unknown username read the same, as they do at login.
 */
export async function verifyWitness(db: Db, actor: Actor, input: WitnessInput, now: Date): Promise<{ userId: string; name: string }> {
  const holder = requirePerson(actor, "a controlled-drug movement");
  const username = input.username.trim();
  if (username === "" || input.pin === "") {
    throw new PharmacyError("witness_not_confirmed", "the witness types their own username and PIN");
  }
  const retryAt = await throttleRetryAt(db, "pin", username, now);
  if (retryAt !== null) {
    throw new PharmacyError("witness_throttled", `too many wrong PINs for ${username} — the witness may try again after ${retryAt.toISOString()}`, { retryAt: retryAt.toISOString() });
  }
  // `verifyPinByUsername` pays one argon2 verify on every miss — unknown, inactive, pinless — so the
  // witness field answers a real name's wrong PIN and a name that does not exist in the same time (WASA L-02).
  const verified = await verifyPinByUsername(db, username, input.pin);
  const [user] = verified === null ? [] : await db.select({ id: users.id, fullName: users.fullName }).from(users).where(eq(users.id, verified.userId));
  if (user === undefined) {
    await recordThrottleFailure(db, "pin", username, now);
    throw new PharmacyError("witness_not_confirmed", "that username and PIN do not match an active member of staff — the witness types their own");
  }
  await clearThrottle(db, "pin", username);
  if (user.id === holder) {
    // The SoD engine records the attempt (`sod.violation_blocked`); the refusal below is the answer either way.
    await assertNotSodPair(db, "narcotics_issuer_witness", actor, { type: "user", id: user.id }).catch((e: unknown) => {
      if (!(e instanceof SodViolationError) && !(e instanceof Error && e.message.startsWith("unknown SoD pair key"))) throw e;
    });
    throw new PharmacyError("custody_same_person", "the witness is somebody other than the person holding the cabinet — one person cannot be two keys");
  }
  if (!(await hasPermission(db, user.id, WITNESS_PERMISSION, "hospital"))) {
    throw new PharmacyError("witness_not_permitted", `${user.fullName} does not hold ${WITNESS_PERMISSION} — ask a pharmacist, the pharmacist in charge or the medical superintendent to witness`);
  }
  return { userId: user.id, name: user.fullName };
}
