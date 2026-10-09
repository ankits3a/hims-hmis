/**
 * ═══ THE DOCTOR'S OPD LINE — WHAT BOTH SCREENS READ THE SAME WAY (mobile plan M3, owner 2026-10-06) ═══
 *
 * ONE file, pure TypeScript, no imports, and NOT in the contracts index — the same arrangement as
 * `vitals-entry.ts` and `slip-desk.ts`. The web consult screen reads it through
 * `apps/web/src/lib/brief-history.ts` and `lib/doctor-label.ts` (which re-export it, so no web import
 * changed); the phone reads the same path through `apps/mobile/src/doctor/rules.ts`. A rule changed
 * for the counter PC changes on the phone in the same commit.
 *
 * Nothing here DECIDES anything about a patient: who is callable, who is held for the bill, who may
 * be started or completed are the server's answers (`opd/queue.ts`, `opd/consultation.ts`). This file
 * only words and orders what the server sent.
 */

// ——— the wire: `GET /opd/queues?doctorId=&serviceDate=` exactly as `listQueue` returns it ———

export type WireQueuePatient = {
  requestedId?: string; id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean;
  /** On the wire since the summary carried them (patients/registration.ts `PatientSummary`). Optional for an older server. */
  administrativeGender?: string; dob?: string | null;
};
/**
 * The reasons a token is passed over — mirrored from `apps/core/src/modules/opd/skip-reasons.ts`,
 * which the route's zod enum reads. `apps/mobile/__tests__/doctor-rules.test.ts` pins this list
 * against that file read as text.
 */
export const SKIP_REASONS = ["absent", "stepped_out", "at_billing", "at_investigation", "not_ready", "other"] as const;
export type WireSkipReason = (typeof SKIP_REASONS)[number];
export type WireFeeStatus = "free" | "settled" | "credit" | "unsettled" | null;
export type WireQueueEntryView = {
  id: string; seq: number; sessionId: string; encounterId: string; tokenNo: number;
  kind: "appointment" | "walk_in"; appointmentAt: string | null; status: string;
  danger: boolean; reEntry: boolean; perk: boolean;
  eligibleAt: string | null; calledAt: string | null; callCount: number; skips: number;
  doneAt: string | null; createdAt: string;
  parkedAt?: string | null; parkedBy?: string | null;
  skipReason?: WireSkipReason | null; skipNote?: string | null; skippedAt?: string | null;
  position: number | null; queueClass: string | null;
  /**
   * Owner 2026-10-09 — a tele-call. The doctor's line shows its slot time (`appointmentAt`) where a
   * token number sits, and a phone icon; nothing about money ever rides on such a row. Optional: an
   * older server sends none.
   */
  tele?: boolean;
  encounter: {
    id: string; patientId: string; visitType: string; dangerFlagged: boolean; status: string;
    referredFromEncounterId?: string | null; feeBypassReason?: string | null; consultFeeOverrideReason?: string | null;
    /**
     * Owner 2026-10-07 — the guardian came with the reports; the patient did not, and no vitals were
     * taken. Same shape as `WirePatientAbsent` in `patient-absent.ts` (this file imports nothing).
     * Optional: an older server sends none.
     */
    patientAbsent?: { relation: string; name: string | null; by: string; at: string } | null;
  };
  patient: WireQueuePatient | null;
  feeStatus: WireFeeStatus;
};
export type WireQueueDoctor = { id: string; userId: string; displayName: string; code: string; departmentId: string; designation?: string | null };
export type WireQueueSession = { id: string; doctorId: string; serviceDate: string; roomId: string | null; status: "not_started" | "in" | "out" | "closed" };
export type WireQueueView = {
  session: WireQueueSession; doctor: WireQueueDoctor; ordered: WireQueueEntryView[];
  current: WireQueueEntryView | null; inConsult: WireQueueEntryView[];
  left?: WireQueueEntryView[]; heldForPayment?: WireQueueEntryView[];
  waitingVitals: number;
  counts: { waiting: number; called: number; inConsult: number; done: number; left: number; heldForPayment?: number };
};

// ——— a row of the line ———

/**
 * A parked row is `in_consult` WITH a `parkedAt` the server said in words. The field is typed
 * `string | null`; a server from before the park sends none, and `!== null` would read every patient
 * in consultation as parked (the web rail's own note, opd-consult.tsx).
 */
export function parkedSince(e: Pick<WireQueueEntryView, "parkedAt">): string | null {
  return typeof e.parkedAt === "string" ? e.parkedAt : null;
}

/** Whole years on `at`, the UTC calculation `modules/opd/time.ts: ageYearsAt` makes — a mirror for a list row, never the authority. */
export function ageYearsOn(dobIso: string, at: Date): number | null {
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return null;
  const years = at.getUTCFullYear() - dob.getUTCFullYear();
  const notYet = at.getUTCMonth() < dob.getUTCMonth() || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  const n = notYet ? years - 1 : years;
  return n < 0 ? null : n;
}

/**
 * "56 M" — the board's own shape (`OpdDesk`: "Suresh Prasad · 56 M"). A baby under a year reads
 * "7 mo"; the letter is the ADMINISTRATIVE gender's initial and is left out when it is neither.
 * A sealed record says nothing: if the name is hidden, the age and the letter are hidden with it.
 */
export function ageSexOf(p: WireQueuePatient | null, at: Date): string | null {
  if (p === null || p.restricted) return null;
  const g = (p.administrativeGender ?? "").toLowerCase();
  const letter = g === "male" ? "M" : g === "female" ? "F" : "";
  let age = "";
  if (typeof p.dob === "string" && p.dob !== "") {
    const years = ageYearsOn(p.dob, at);
    if (years !== null) {
      if (years >= 1) age = String(years);
      else {
        const dob = new Date(p.dob);
        const months = Math.max(0, (at.getUTCFullYear() - dob.getUTCFullYear()) * 12 + at.getUTCMonth() - dob.getUTCMonth() - (at.getUTCDate() < dob.getUTCDate() ? 1 : 0));
        age = `${months} mo`;
      }
    }
  }
  const out = [age, letter].filter((x) => x !== "").join(" ");
  return out === "" ? null : out;
}

/** The name a row shows: a sealed record shows its alias and never a name; a row with no summary shows nothing invented. */
export function rowName(p: WireQueuePatient | null): { text: string | null; sealed: boolean } {
  if (p === null) return { text: null, sealed: false };
  if (p.restricted) return { text: p.alias, sealed: true };
  return { text: p.name ?? p.uhid, sealed: false };
}

/**
 * Minutes this token has been waiting FOR THE DOCTOR at `now`. The clock starts where the queue
 * engine starts it — `eligibleAt`, the moment vitals were done and the row became callable — and
 * falls back to the row's creation for a server that sent none. Never negative.
 */
export function waitMinutes(e: Pick<WireQueueEntryView, "eligibleAt" | "createdAt">, now: Date): number {
  const from = new Date(e.eligibleAt ?? e.createdAt).getTime();
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((now.getTime() - from) / 60_000));
}
/** The board's line: "31 booked · 12 seen · 9 waiting · longest wait 41 min" needs the longest. */
export function longestWait(rows: readonly Pick<WireQueueEntryView, "eligibleAt" | "createdAt">[], now: Date): number | null {
  return rows.length === 0 ? null : Math.max(...rows.map((r) => waitMinutes(r, now)));
}
/** A wait the doctor should SEE: the board paints 41 min red among 14–36 min rows. Forty minutes is the line. */
export const LONG_WAIT_MINUTES = 40;

/** What kind of visit the row is, as the rail's badge words it (`VisitTypeBadge`): an internal referral says REFERRAL, not NEW. */
export function visitKind(e: Pick<WireQueueEntryView, "encounter">): "new" | "revisit" | "renewal" | "referral" {
  if (typeof e.encounter.referredFromEncounterId === "string" && e.encounter.referredFromEncounterId !== "") return "referral";
  const v = e.encounter.visitType;
  return v === "revisit" || v === "renewal" ? v : "new";
}

/**
 * UNPAID is said only when the server said `unsettled`. `null` is "no status to report" and is not
 * unpaid (the wire's own note): a row the server declined to characterise is never stamped.
 */
export function isUnpaid(e: Pick<WireQueueEntryView, "feeStatus">): boolean {
  return e.feeStatus === "unsettled";
}

// ——— completing from a phone ———

export type WireFollowUpConfig = { followUpDefaultDays: number; followUpExtensionDays: number[] };
/**
 * The follow-up choices: the default FIRST and sent as `null` — the key must be ABSENT from the
 * completion body so the server's own default applies (K49) — then each configured extension, sent
 * as its number. No config (a seat that may not read it) offers the default alone.
 */
export function followUpChoices(cfg: WireFollowUpConfig | null): { days: number | null; isDefault: boolean; send: number | null }[] {
  if (cfg === null) return [{ days: null, isDefault: true, send: null }];
  const ext = [...new Set(cfg.followUpExtensionDays)].filter((d) => d !== cfg.followUpDefaultDays).sort((a, b) => a - b);
  return [{ days: cfg.followUpDefaultDays, isDefault: true, send: null }, ...ext.map((d) => ({ days: d, isDefault: false, send: d }))];
}
/** The body `POST /opd/visits/:id/consult/complete` takes from a phone: no note (the phone writes none), so nothing typed on the computer is touched. */
export function completionBody(testsOrderedReturnToday: boolean, followUpSend: number | null): { testsOrderedReturnToday: boolean; followUpDays?: number } {
  return testsOrderedReturnToday || followUpSend === null ? { testsOrderedReturnToday } : { testsOrderedReturnToday, followUpDays: followUpSend };
}

/**
 * ═══ A PRESCRIPTION TYPED ON THE COMPUTER AND NOT ISSUED BLOCKS A PHONE'S COMPLETE ═══
 *
 * Production 2026-09-23 (opd-consult.tsx `complete`): a doctor typed medicines, pressed Complete,
 * and no prescription was ever issued — the pharmacy never got a ticket. The web closes that by
 * issuing first. The phone cannot issue (it runs none of the allergy / interaction / duplicate
 * checks' dialogs), so it REFUSES to complete while the server holds unissued rows that name a
 * drug, and says where to finish them. A blank editor row is not a prescription.
 */
export function unissuedRxRows(rxDraft: readonly { drug?: unknown }[] | null | undefined): number {
  if (!Array.isArray(rxDraft)) return 0;
  return rxDraft.filter((r) => typeof r?.drug === "string" && r.drug.trim() !== "").length;
}

// ——— the brief: what the lab, radiology and the pharmacy recorded (Consult v2, board `Main`) ———

export type WirePatientResult = {
  orderableName: string; analyteName: string; value: string; unit: string | null; flag: string | null; verifiedAt: string;
};
export type WirePatientImaging = { studyName: string; impression: string | null; criticalCategory: string | null; signedAt: string };
export type WirePatientDispense = {
  prescriptionId: string; handedOverAt: string;
  lines: { drug: string; durationDays: number | null; qtyBase: number | null }[];
};

/** The IST calendar day of an instant, `YYYY-MM-DD` — the same day the timeline's `serviceDate` names. */
export function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "19 Sep", as the board prints it — spelled here, because ICU's short month for September varies ("Sept"). */
export function shortDay(isoOrDay: string): string {
  const [, m, d] = (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDay) ? isoOrDay : istDay(isoOrDay)).split("-");
  return `${String(Number(d))} ${MONTHS[Number(m) - 1] ?? ""}`;
}

export type BriefResultLine = { what: string; kind: "lab" | "radiology"; day: string; abnormal: boolean };
export const BRIEF_RESULT_LINES = 6;

/**
 * The board's rule for the "since then" list:
 *  · results on or after the last consultation's day, newest first (the board lists an ECG taken on
 *    the day of the last visit under "since then"; a same-day result is part of what came after it);
 *  · none since, but something on file → the most recent one, marked `noneSince` ("HbA1c 8.1 · lab
 *    3 Jun · none since");
 *  · a first visit (no last consultation) → the most recent on file;
 *  · nothing at all → an empty list, and the screen says "No results on file".
 * A lab flag is abnormal whenever the bench set one (anything but `N`); an imaging report is when it
 * carries a critical category.
 */
export function briefResults(
  lab: WirePatientResult[], imaging: WirePatientImaging[], lastVisitDay: string | null,
): { lines: BriefResultLine[]; noneSince: boolean } {
  const all: (BriefResultLine & { at: string })[] = [
    ...lab.map((r) => ({
      what: `${r.analyteName} ${r.value}${r.unit === null || r.unit === "" ? "" : ` ${r.unit}`}`,
      kind: "lab" as const, at: r.verifiedAt, day: istDay(r.verifiedAt),
      abnormal: r.flag !== null && r.flag !== "" && r.flag.toUpperCase() !== "N",
    })),
    ...imaging.map((r) => ({
      what: r.impression === null || r.impression.trim() === "" ? r.studyName : `${r.studyName}: ${r.impression.trim()}`,
      kind: "radiology" as const, at: r.signedAt, day: istDay(r.signedAt), abnormal: r.criticalCategory !== null,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const strip = (l: BriefResultLine & { at: string }): BriefResultLine => ({ what: l.what, kind: l.kind, day: l.day, abnormal: l.abnormal });
  if (all.length === 0) return { lines: [], noneSince: false };
  if (lastVisitDay === null) return { lines: all.slice(0, BRIEF_RESULT_LINES).map(strip), noneSince: false };
  const since = all.filter((l) => l.day >= lastVisitDay);
  if (since.length === 0) return { lines: [strip(all[0]!)], noneSince: true };
  return { lines: since.slice(0, BRIEF_RESULT_LINES).map(strip), noneSince: false };
}

export type BriefRefill =
  | { kind: "none" }
  | { kind: "bought"; times: number; lastDay: string; days: number | null; dueDay: string | null };

/**
 * The refill record for the prescription the brief shows under "ON NOW": how many times the
 * pharmacy handed it over, the last time, and — when the Rx lines carry a duration — how many days
 * that covered and the day it runs out. The longest line's duration is the purchase's cover: a
 * 30-day antihypertensive and a 5-day antibiotic bought together last until the 30 days are up.
 */
export function briefRefill(prescriptionId: string, dispenses: WirePatientDispense[]): BriefRefill {
  const mine = dispenses.filter((d) => d.prescriptionId === prescriptionId).sort((a, b) => (a.handedOverAt < b.handedOverAt ? 1 : -1));
  const last = mine[0];
  if (last === undefined) return { kind: "none" };
  const durations = last.lines.map((l) => l.durationDays).filter((d): d is number => d !== null && d > 0);
  const days = durations.length === 0 ? null : Math.max(...durations);
  const lastDay = istDay(last.handedOverAt);
  const dueDay = days === null ? null : istDay(new Date(new Date(`${lastDay}T06:30:00.000Z`).getTime() + days * 86_400_000).toISOString());
  return { kind: "bought", times: mine.length, lastDay, days, dueDay };
}

// ——— beside the doctor's name ———

/**
 * 2026-10-04 (owner) — WHAT A STAFF OPD SCREEN SAYS BESIDE A DOCTOR'S NAME.
 *
 * "Dr. Chandan · Unit I", "Dr. S.I Raza · Guest Faculty", "Dr. Yash Vardhan · Unit I · Sr. Resident".
 * The unit (from the roster, that day's membership) comes first because that is what the owner asked
 * to see; the designation follows, shortened so a row stays one quiet line. A doctor in no unit and
 * with no designation gets nothing: the name alone.
 */
const SHORT: readonly [RegExp, string][] = [
  [/\bAssistant Professor\b/gi, "Asst. Prof."],
  [/\bAssociate Professor\b/gi, "Assoc. Prof."],
  [/\bDeputy Superintendent\b/gi, "Dy. Supdt."],
  [/\bMedical Superintendent\b/gi, "MS"],
  [/\bSenior Resident\b/gi, "Sr. Resident"],
  [/\bJunior Resident\b/gi, "Jr. Resident"],
];

export function shortDesignation(designation: string | null | undefined): string | null {
  const d = designation?.trim() ?? "";
  if (d === "") return null;
  return SHORT.reduce((s, [re, to]) => s.replace(re, to), d);
}

export function besideName(opts: { unit?: string | null; designation?: string | null }): string | null {
  const parts = [opts.unit ?? null, shortDesignation(opts.designation)].filter((x): x is string => x !== null && x !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A tele-call's slot on the IST clock — "11:20" — the figure the doctor's line prints where a token sits. */
export function teleSlotClock(iso: string | null | undefined): string {
  if (iso == null) return "";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
