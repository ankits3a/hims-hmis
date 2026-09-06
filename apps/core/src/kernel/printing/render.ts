import { and, desc, eq } from "drizzle-orm";
import {
  opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdVitals, patients, users,
} from "../db/schema";
import { encounterFeeStatuses } from "../../modules/billing/fee-status";
import { LAB_DEPARTMENT_CODE } from "../../modules/opd/encounters";
/* FD-25 §14 — the ONE place a confidential patient's name is decided. See `subjectOf`.
   `resolvePatientId` is the OTHER half of that decision: it names WHOSE record this is after a
   merge, and the rule cannot be asked without that. See `canonicalPersonOf`. */
import { displayName, displayNameForRelease, listAllergies, resolvePatientId } from "../../modules/patients";
/* FD-29 — the crest as a data URI and a real QR encoder, both self-contained: `RenderedDocument`
   promises HTML with no external fetch, and the relay may be printing with the uplink down. */
import { CREST_PNG_DATA_URI } from "./crest";
import { qrSvg } from "./qr";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T3 — RENDERING, AND WHERE IT HAPPENS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE SERVER RENDERS HTML. THE RELAY TURNS HTML INTO PAPER. Three facts force that split and none
 * of them is a preference:
 *
 *   1. **The production image is `node:22-bookworm-slim` and has no browser.** Adding Chromium plus
 *      Devanagari fonts to a hospital server image costs ~400 MB, on a box that Stage 3 wants to be
 *      ordinary metal. Rendering HTML is string work; rendering PDF is not.
 *   2. **The brief's binding constraint: *"patient care must never depend on internet
 *      connectivity."*** If the server produced the PDF, an outage between claim and print would
 *      mean no paper. So the document travels WITH THE CLAIM and the relay is autonomous the moment
 *      it has one — it can print a queue of slips with the uplink down.
 *   3. **Templates must stay in this repo**, versioned with the app and reviewable in a diff. A
 *      relay that owned the layout would make "move the token 2 mm" a hospital redeployment.
 *
 * So the relay carries a headless browser (any Pi has one) and this file carries the design.
 *
 * ═══ WHAT THIS MEANS FOR PHI, STATED PLAINLY ═══
 *
 * The QUEUE ROW holds identifiers only — that property is real and `print_jobs` keeps it. But the
 * rendered document is a slip with a patient's name on it, so **the claim response carries PHI by
 * necessity**: a relay that could not learn the name could not print it. The relay is a PHI
 * processor. It is secured by an agent key stored as a SHA-256, a per-agent kill switch, and the
 * fact that it holds an outbound connection and accepts none. Pretending otherwise would be theatre.
 *
 * ═══ THE PAGE SIZES, WHICH IS THE POINT OF THE WHOLE PHASE ═══
 *
 * Before this file the application had ONE `@page` rule — a global A5 — and no 72 mm anywhere. A
 * thermal roll is **72 mm printable on 80 mm stock and CONTINUOUS**: `size: 72mm auto` is what makes
 * the slip as long as the job needs instead of padding it to a sheet. `PrinterChoice.dc.html` is
 * where that was ruled, and the reason "Next Steps" fits here and would not fit on a 4×6 label.
 */

/** A rendered document, ready for the relay to convert and print. */
export type RenderedDocument = {
  /** Self-contained HTML: inline CSS, no external fetch, no font CDN. The relay may be offline. */
  html: string;
  /** For the operator's log and the relay's own sanity check. */
  title: string;
  /**
   * ═══ THE PAGE GEOMETRY, AND WHY IT TRAVELS AS DATA RATHER THAN LIVING ONLY IN THE CSS ═══
   *
   * **MEASURED, NOT ASSUMED: Chromium SILENTLY IGNORES `@page { size: 72mm auto }`.** A first cut of
   * this phase relied on the CSS alone and produced a US-Letter PDF — 215.9 × 279.4 mm — with the
   * slip stranded in the corner of a sheet. `preferCSSPageSize: true` does not rescue it either;
   * only an EXPLICIT height is honoured (`size: 72mm 200mm` renders exactly 72.0 × 200.1 mm).
   *
   * A thermal roll is continuous, so there is no explicit height to write: the slip is as long as
   * the job needs. So the geometry travels to the relay, which has the browser, and the relay
   * MEASURES the laid-out document before printing when `heightMm` is null.
   *
   * The `@page` rules in the CSS below STAY. They are the correct declaration of intent for any
   * renderer that honours them, and they keep the template readable — but they are not what makes
   * the paper the right size, and a future reader should not believe they are.
   */
  page: { widthMm: number; heightMm: number | null };
};

/** Escapes text for HTML. Everything interpolated below goes through it — patient names included. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * THE THERMAL PAGE. 72 mm printable, continuous length, no margin of its own — a roll has no
 * gutter and every millimetre spent on one is a millimetre of paper.
 *
 * `-webkit-print-color-adjust: exact` because the UNPAID box is a filled block and a browser that
 * "saves ink" would print the stamp as an outline nobody reads across a counter.
 *
 * The font stack ends at a generic because the RELAY's fonts are not this repo's. Devanagari is
 * load-bearing on this document (`DevanagariSpec.dc.html`), so the relay machine must have a
 * Devanagari face installed — that is a deployment note, recorded in the relay's own README.
 */
const THERMAL_CSS = `
  @page { size: 72mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 72mm; padding: 3mm 3.5mm 6mm;
    font-family: "IBM Plex Sans", "Noto Sans", "Noto Sans Devanagari", sans-serif;
    font-size: 10pt; line-height: 1.35; color: #000; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .hd { text-align: center; border-bottom: 1px solid #000; padding-bottom: 2mm; }
  .hd .nm { font-weight: 700; font-size: 11pt; letter-spacing: .02em; }
  .hd .ad { font-size: 7.5pt; line-height: 1.25; margin-top: .6mm; }
  .tok { text-align: center; margin: 3mm 0 2mm; }
  .tok .lbl { font-size: 8pt; letter-spacing: .18em; text-transform: uppercase; }
  .tok .no { font-size: 30pt; font-weight: 700; line-height: 1; margin: .5mm 0 1mm; }
  .tok .dr { font-size: 10pt; font-weight: 600; }
  .tok .dept { font-size: 8.5pt; }
  .row { display: flex; justify-content: space-between; gap: 2mm; font-size: 8.5pt; padding: .5mm 0; }
  .row .k { color: #000; }
  .row .v { font-weight: 600; text-align: right; }
  .sec { border-top: 1px dashed #000; margin-top: 2mm; padding-top: 2mm; }
  .stamp { border: 1.2mm solid #000; padding: 1.5mm; text-align: center; margin-top: 2.5mm; }
  .stamp .w { font-size: 13pt; font-weight: 700; letter-spacing: .12em; }
  .stamp .hi { font-size: 9pt; margin-top: .5mm; }
  .next { font-size: 8.5pt; margin-top: 2mm; }
  .next .t { font-weight: 700; letter-spacing: .1em; text-transform: uppercase; font-size: 7.5pt; }
  .next ol { margin: 1mm 0 0; padding-left: 4.5mm; }
  .next li { margin-bottom: .8mm; }
  .next .hi { font-size: 8pt; }
  .ft { font-size: 7pt; text-align: center; margin-top: 3mm; border-top: 1px solid #000; padding-top: 1.5mm; }
  .mo { font-family: "IBM Plex Mono", "Noto Sans Mono", monospace; }
  .code { text-align: center; margin-top: 2mm; }
  .code .digits { font-size: 9pt; letter-spacing: .18em; margin-top: .8mm; }
`;

/**
 * A Code-128-looking bar field drawn with divs.
 *
 * HONESTLY LABELLED: this is a VISUAL bar field, deterministic from the payload, and it is NOT a
 * scannable Code 128 — that needs a real encoder with its own check digit, and shipping a
 * bar-shaped picture that a scanner refuses is worse than shipping none. The human-readable digits
 * beneath it are what the counter actually keys today, and they are printed at full size for that
 * reason. Replacing this with a real encoder is a contained change: same box, same payload.
 */
function barField(payload: string): string {
  let seed = 0;
  for (const ch of payload) seed = (seed * 31 + ch.charCodeAt(0)) % 100_000;
  const bars: string[] = [];
  for (let i = 0; i < 44; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const w = 1 + (seed % 3);
    const gap = 1 + ((seed >> 8) % 2);
    bars.push(`<span style="display:inline-block;width:${String(w)}px;height:11mm;background:#000"></span>`);
    bars.push(`<span style="display:inline-block;width:${String(gap)}px;height:11mm"></span>`);
  }
  return `<div class="code"><div>${bars.join("")}</div><div class="digits mo">${esc(payload)}</div></div>`;
}

/**
 * ═══ EVERY FIELD HERE IS PRE-ESCAPED AND INTERPOLATED RAW ═══
 *
 * `name` and `nameTitleCase` carry `&amp;` as an ENTITY, so putting them through `esc()` prints the
 * literal `&amp;` on the paper. That is a trap the next reader will step in exactly once; it is
 * written down here rather than discovered on a printed sheet.
 */
const HOSPITAL = {
  name: "CRK MEDICAL COLLEGE &amp; HOSPITAL",
  /**
   * The SAME establishment, title-cased, for the prescription letterhead's footer.
   *
   * NOT a unification of the line above, and deliberately so: the thermal slips print the name in
   * caps, and a SECOND, unescaped copy of the same string lives at `modules/opd/config.ts` behind
   * seven tests across four modules. Folding three spellings into one is a cross-module change with
   * its own review — it is not something a layout change may quietly do on the way past.
   */
  nameTitleCase: "CRK Medical College &amp; Hospital",
  address: "Chaurasia Chowk, Hajipur — 844101, Bihar",
  contact: "Hotline +91 77648 88189 · Emergency 1068",
  /* FD-29 — split out of `contact` for the prescription footer, which labels them separately. */
  hotline: "+91 77648 88189",
  emergency: "1068",
  email: "info@crkmch.com",
  website: "www.crkmch.com",
};

/**
 * ═══ THE HOSPITAL'S CLOCK, ONE MECHANISM, IN THE ONE SPELLING THIS FILE ALREADY USED ═══
 *
 * `Intl` with the IANA zone rather than the `5.5 * 60 * 60 * 1000` the twelve sites in
 * `test/ist-clock-parity.test.ts` carry — this file was already on the `Asia/Kolkata` side of that
 * line (`ageYearsIST` below is the original) and adding a fourteenth numeric copy to render a date
 * on a letterhead would be a worse answer than reusing the one already here.
 *
 * A DATE COLUMN IS NOT AN INSTANT and the two must not share a path. `opd_encounters.service_date`
 * is already an IST calendar day; pushing it through a zone would move it. `formatCalendarDay`
 * therefore does no arithmetic at all, and only `formatIstDay`/`formatIstTime` — which take a real
 * instant, like the moment a sheet is printed — go through the zone.
 */
const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});
const IST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `2026-08-29` → `29-Aug-2026`, the form the letterhead prints everywhere. */
function dayFromIso(iso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const abbr = MONTH_ABBR[Number(iso.slice(5, 7)) - 1];
  return abbr === undefined ? null : `${iso.slice(8, 10)}-${abbr}-${iso.slice(0, 4)}`;
}

/**
 * A DATE column — `service_date`, `dob` — which is already a calendar day and must not be shifted.
 * Drizzle hands back a `Date` or the ISO string depending on the column's declared mode, so both
 * are taken rather than one assumed (the same care `ageYearsIST` takes, for the same reason).
 */
function formatCalendarDay(value: string | Date | null): string | null {
  if (value === null || value === "") return null;
  return dayFromIso(value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
}

/** An INSTANT, on the hospital's clock. */
function formatIstDay(at: Date): string {
  return dayFromIso(IST_DAY.format(at)) ?? IST_DAY.format(at);
}

/** An INSTANT as `HH:MM`, on the hospital's clock. */
function formatIstTime(at: Date): string {
  return IST_TIME.format(at);
}

/**
 * `F` / `M` / `O` — and `—` for `unknown`, which is the whole reason this is not inlined.
 *
 * `administrativeGender` is a four-value column and `unknown` is one of the four. Folding it into
 * `O` prints a clinical fact the record does not hold: "other" is an answer, "not recorded" is not.
 * The compact `ageSexOf` on the thermal slips keeps its old three-way fold — a 72 mm token slip has
 * no room for the distinction and nobody prescribes off one.
 */
function genderLetter(gender: string | null): string {
  const g = (gender ?? "").toLowerCase();
  if (g.startsWith("f")) return "F";
  if (g.startsWith("m")) return "M";
  return g.startsWith("o") ? "O" : "—";
}

function thermalPage(title: string, body: string): RenderedDocument {
  return {
    title,
    // 72 mm wide, and `null` height means CONTINUOUS: the relay measures the laid-out document.
    page: { widthMm: 72, heightMm: null },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${THERMAL_CSS}</style></head><body>${body}</body></html>`,
  };
}

/** The identity every document repeats, because a slip that cannot be matched to a person is litter. */
type SlipSubject = {
  /**
   * FD-25 — the name that may be PRINTED, which for a §14 patient is not the name in the record.
   * `subjectOf` resolves it through the patients module; nothing downstream re-reads `patients.name`.
   */
  patientName: string; uhid: string; ageSex: string;
  visitNo: string; serviceDate: string;
  /** FD-24 close — the fee projection reads it; see `renderTokenSlip`'s stamp. */
  visitType: string;
  departmentName: string; departmentCode: string; doctorName: string; doctorRegistrationNo: string | null;
  tokenNo: number | null; roomCode: string | null;
  /**
   * ═══ FD-29 — WHAT THE A4 LETTERHEAD NEEDS AND A 72 mm SLIP DOES NOT ═══
   *
   * The prescription's identity band is five rows deep on each side, where the thermal slips carry
   * a compacted `ageSex`. These fields are the difference. THREE OF THEM WERE ALREADY SELECTED by
   * `subjectOf` and thrown away on the way out — `dob`, `gender` and the canonical `patientId` — so
   * carrying them costs no query at all.
   *
   * `patientId` is the CANONICAL id, resolved through `canonicalPersonOf`, and the allergy and
   * carried-height reads key on it. Keying them on `opd_encounters.patient_id` instead would read
   * the frozen duplicate after a merge — the exact bug the §14 comment above this type exists to
   * describe, one level down, on clinical data rather than on a name.
   */
  patientId: string;
  dob: string | Date | null;
  /** True when the date of birth was derived from an entered age, so the DAY is not a fact. */
  dobEstimated: boolean;
  gender: string;
  ageYears: number | null;
  /** `opd_doctors.specialty` — nullable free text; the sheet falls back to the department. */
  doctorSpecialty: string | null;
};

/** `MED-4`. The same grammar the screen uses — a token printed one way and said another sends a patient to the wrong door. */
function tokenLabel(code: string, tokenNo: number | null): string {
  if (tokenNo === null) return "—";
  return code.trim() === "" ? String(tokenNo) : `${code.trim().toUpperCase()}-${String(tokenNo)}`;
}

/**
 * Whole years on the hospital's calendar, or `null` when the record has no date of birth.
 *
 * Extracted from `ageSexOf` — it was the only IST rule in this file and now has two callers, and a
 * second copy is how the token slip and the prescription start disagreeing about whether a patient
 * is eighteen. The carried-height rule turns on exactly that boundary.
 */
function ageYearsIST(dob: string | Date | null, on: Date): number | null {
  if (dob === null || dob === "") return null;
  // `patients.dob` is a real date column, so drizzle may hand back a Date or the ISO string,
  // depending on the mode the column was declared with. Take both rather than assume one.
  const iso = dob instanceof Date ? dob.toISOString() : String(dob);
  const born = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  // IST, like every other date in this system — a birthday at 02:00 IST is still a birthday.
  const p = IST_DAY.format(on).split("-").map(Number);
  let years = p[0]! - born.getUTCFullYear();
  const bm = born.getUTCMonth() + 1;
  if (p[1]! < bm || (p[1] === bm && p[2]! < born.getUTCDate())) years -= 1;
  return Math.max(0, years);
}

function ageSexOf(dob: string | Date | null, gender: string | null, on: Date): string {
  const letter = (gender ?? "").toLowerCase().startsWith("f") ? "F"
    : (gender ?? "").toLowerCase().startsWith("m") ? "M" : "O";
  const years = ageYearsIST(dob, on);
  return years === null ? letter : `${String(years)} y / ${letter}`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 CLOSE — THE PERSON A SLIP IS ABOUT IS THE CANONICAL RECORD, NOT THE ROW IT JOINS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `executeMerge` moves allergies and guardians to the winner and then FREEZES the loser
 * (`status = 'merged'`, `merged_into_patient_id`). **It never repoints `opd_encounters.patient_id`,
 * and `updatePatient` refuses to touch a frozen row** (`patient_not_active`) — so a merged-away
 * duplicate keeps its own `name`, `alias` and `is_confidential` for ever while its encounters go on
 * pointing at it. A printer that reads the §14 decision off the joined row therefore asks the rule
 * about a record that has stopped being the patient, and gets it wrong in BOTH directions: a
 * duplicate registered before anyone knew who the patient was prints the LEGAL NAME of someone the
 * hospital has since sealed, and a break-glass grant — written against the id `getPatient` matched,
 * which is the CANONICAL one — fails to open the paper for the clinician who took it.
 *
 * Every other §14 and PHI decision in this tree resolves the chain first: `getPatient` walks it
 * before it asks about the permission or the grant, and `lab`, `aerb` and `membership` all call
 * `resolvePatientId` before they key anything on a patient. This is that call.
 *
 * ═══ THE WHOLE IDENTITY BAND MOVES, NOT ONLY THE NAME ═══
 *
 * A slip carrying the survivor's NAME beside the duplicate's retired UHID would match no record at
 * any counter in the building — a second way to hand paper to the wrong person, invented while
 * fixing the first. `getPatient` hands a reader the surviving row entire, and the paper must not
 * disagree with the screen it is printed beside.
 *
 * ═══ AND IT COSTS NOTHING ON THE PATH THAT MATTERS ═══
 *
 * `status` comes back on the join that was already running, so an ordinary slip — every slip, on
 * every ordinary day — walks no chain and issues no extra query. Only a merged row pays, and only
 * a merged row has anything to pay for.
 */
type SlipPerson = {
  id: string; name: string; alias: string | null; isConfidential: boolean;
  uhid: string; dob: Date | null; gender: string; dobEstimated: boolean;
};

async function canonicalPersonOf(db: Db, patientId: string): Promise<SlipPerson | null> {
  const canonicalId = await resolvePatientId(db, patientId);
  if (canonicalId === null) return null;
  const rows = await db
    .select({
      id: patients.id, name: patients.name, alias: patients.alias,
      isConfidential: patients.isConfidential, uhid: patients.uhid,
      dob: patients.dob, gender: patients.administrativeGender,
      dobEstimated: patients.dobEstimated,
    })
    .from(patients)
    .where(eq(patients.id, canonicalId));
  return rows[0] ?? null;
}

/**
 * Resolves everything a slip says about one visit, AT RENDER TIME.
 *
 * This is why `print_jobs.params` carries an encounter id and not a name: a reprint after a
 * correction hands over the CORRECTED name, and the queue row never becomes a stale second copy of
 * the patient record.
 */
async function subjectOf(
  db: Db, encounterId: string, now: Date, requester: Actor | null,
): Promise<SlipSubject | null> {
  const rows = await db
    .select({
      visitNo: opdEncounters.visitNo,
      serviceDate: opdEncounters.serviceDate,
      /* FD-24 CLOSE — the token slip's paid stamp is a projection of the ledger, and
         `encounterFeeStatuses` reads `visitType` to decide which fee service applies. */
      visitType: opdEncounters.visitType,
      patientName: patients.name,
      /* FD-25 — `alias` and `is_confidential` travel because `displayNameForRelease` needs all three
         to answer. `billing/worklist.ts` selects exactly these beside the name for the same reason.
         The ID travels too: a break-glass grant is scoped to ONE patient, so the rule cannot be
         asked without naming whose record this is.

         **AND THIS ROW IS NOT NECESSARILY THAT RECORD.** An earlier draft of this comment argued
         that `patients.id` and `opd_encounters.patient_id` "are the join condition and therefore
         equal", which is true of the join and beside the point: after a merge the encounter still
         points at the FROZEN DUPLICATE, and the seal, the alias and the grant all live on the
         survivor. `canonicalPersonOf` below resolves that before the rule is asked. */
      patientId: patients.id,
      alias: patients.alias,
      isConfidential: patients.isConfidential,
      /* FD-25 CLOSE — the one column that says the joined row is not the person any more. See
         `canonicalPersonOf`: it costs nothing to select and saves a chain walk on every ordinary slip. */
      patientStatus: patients.status,
      uhid: patients.uhid,
      dob: patients.dob,
      gender: patients.administrativeGender,
      /* FD-29 — the prescription prints the DAY, so it must know whether the day is a fact. */
      dobEstimated: patients.dobEstimated,
      departmentName: opdDepartments.name,
      departmentCode: opdDepartments.code,
    })
    .from(opdEncounters)
    .innerJoin(patients, eq(patients.id, opdEncounters.patientId))
    .innerJoin(opdDepartments, eq(opdDepartments.id, opdEncounters.departmentId))
    .where(eq(opdEncounters.id, encounterId));
  const row = rows[0];
  if (row === undefined) return null;

  /*
    `opd_doctors.display_name`, NOT `users.full_name`, and the column's own comment says why:
    "shown on displays, slips, e-Rx". `users.full_name` is the login identity — the first draft of
    this file joined it and the slip printed `dr-render`, the USERNAME, where the doctor's name
    belongs. `opd_doctors.user_id` is plain text and carries no FK, so that join was wrong twice.
    `queue.ts` reads `displayName` for the board; a slip and a board must not disagree about a name.
  */
  const doctor = await db
    .select({
      name: opdDoctors.displayName, registrationNo: opdDoctors.registrationNo,
      /* FD-29 — the A4 letterhead prints a Speciality row. Nullable free text with no master
         behind it, so the sheet falls back to the department rather than printing a dash. */
      specialty: opdDoctors.specialty,
    })
    .from(opdEncounters)
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(eq(opdEncounters.id, encounterId));

  const entry = await db
    .select({ tokenNo: opdQueueEntries.tokenNo })
    .from(opdQueueEntries)
    .where(eq(opdQueueEntries.encounterId, encounterId));

  /*
    ═══ FD-25, OWNER RULING 2026-09-05 — WHOSE NAME REACHES PAPER IS A §14 DECISION ═══

    This file printed `patients.name` — the LEGAL name — on every document, for every patient, on the
    first print and on every reprint. `kernel/printing` contained no reference to §14 at all. The
    reprint route grew a gate this session (`getPatient` decides who may ASK for a second copy) and
    the paper it produced still said the name the seal exists to withhold: a gate on the REQUEST with
    none on the DOCUMENT is a seal with a hole one level down.

    THE RULE IS NOT RE-ANSWERED HERE. `display-name.ts` is the ONE place a confidential patient's
    name is decided — keyed on `patients.confidential.read` rather than on a role, because a role is
    what the permission is granted TO, and a dash rather than the legal name when a sealed row has
    no alias. `billing/worklist.ts` and `kernel/orders/read.ts` are the precedents for a reader
    calling it. A second implementation inside the printer is how the two start disagreeing about a
    VIP.

    ═══ AND IT IS THE `Release` SIBLING, WHICH IS THE OTHER HALF OF THE OWNER'S RULING ═══

    The ruling reads: *"alias by default; the LEGAL NAME prints only when the operator goes through
    the existing break-glass grant, which is already logged."* `displayNameFor` answers only the
    first clause — it decides on `patients.confidential.read`, and break-glass does not confer that
    permission; it writes `break_glass_grants`, a table `hasPermission` has never read. Asking it
    here handed the 2 a.m. clinician who had just opened the sealed record through break-glass — and
    who is reading the legal name off `GET /patients/:id` at that moment — a slip saying "Patient A".
    Paper that disagrees with the screen beside it is settled by a pen, and a pen logs nothing.

    `displayNameForRelease` is that second clause, and it lives BESIDE the rule rather than here:
    this file reading `break_glass_grants` itself would be the second authority the patients module
    exists to prevent. It is NOT a general widening — every screen still asks `displayNameFor`, and
    who may see a sealed name on the BILLING WORKLIST is a decision nobody has taken.

    ═══ NO REQUESTER MEANS THE ALIAS, AND THAT IS THE SAFE DIRECTION ═══

    `print_jobs.requested_by` is NULLABLE, and a row without one is the shape most likely to be a
    background producer — the case with no human to answer for the disclosure. So an unattributed
    print gets the same answer `displayNameFor` gives a `system` actor: the alias. The relay's own
    agent credential gets it too; claiming a job is not a clearance.

    ═══ AND IT IS RESOLVED AT RENDER TIME, LIKE EVERY OTHER FACT ON THESE DOCUMENTS ═══

    The clerk who queued the slip may have been through break-glass when they asked; a grant expires
    and a role is revoked. Printing is asynchronous by design — the relay may claim minutes later —
    and the moment the clearance has to be true is the moment paper comes out. That cuts the safe way
    round: a lapsed grant prints the alias, never the reverse.
  */
  /*
    THE ROW THE ENCOUNTER JOINS IS ONLY THE STARTING POINT — see `canonicalPersonOf` for why, and
    for why the ordinary slip pays nothing for this. A chain that ends nowhere renders NOTHING
    rather than falling back to the frozen row: `followMergeChain` returning null means the record
    this paper is about cannot be identified, and a slip naming a record the system cannot resolve
    is worse than no slip — printing is advisory (R7) and the screen reports the failure.
  */
  const person = row.patientStatus === "merged"
    ? await canonicalPersonOf(db, row.patientId)
    : {
      id: row.patientId, name: row.patientName, alias: row.alias,
      isConfidential: row.isConfidential, uhid: row.uhid, dob: row.dob, gender: row.gender,
      dobEstimated: row.dobEstimated,
    };
  if (person === null) return null;

  return {
    patientName: requester === null
      ? displayName(person, false)
      : await displayNameForRelease(db, requester, person, person.id),
    uhid: person.uhid,
    visitType: row.visitType,
    ageSex: ageSexOf(person.dob, person.gender, now),
    visitNo: row.visitNo,
    serviceDate: row.serviceDate,
    departmentName: row.departmentName,
    departmentCode: row.departmentCode,
    doctorName: doctor[0]?.name ?? "the department",
    doctorRegistrationNo: doctor[0]?.registrationNo ?? null,
    doctorSpecialty: doctor[0]?.specialty ?? null,
    tokenNo: entry[0]?.tokenNo ?? null,
    roomCode: null,
    /* FD-29 — the canonical id, NOT `opd_encounters.patient_id`: see the field's own comment. */
    patientId: person.id,
    dob: person.dob,
    dobEstimated: person.dobEstimated,
    gender: person.gender,
    ageYears: ageYearsIST(person.dob, now),
  };
}

/**
 * ═══ THE OPD TOKEN SLIP — `TokenSlip72.dc.html` ═══
 *
 * The bilingual "Go next to" block and the Devanagari under the UNPAID stamp are not decoration:
 * they are the half of this slip a patient can actually read. The design carries them and so does
 * this.
 */
export async function renderTokenSlip(
  db: Db,
  params: { encounterId?: unknown; unpaid?: unknown },
  now = new Date(),
  /* FD-25 — who asked for this paper. `null` DEFAULTS TO THE ALIAS for a §14 patient: a caller that
     forgets to thread the requester leaks nothing, which is the only safe way round for a default. */
  requester: Actor | null = null,
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const s = await subjectOf(db, encounterId, now, requester);
  if (s === null) return null;

  /*
    ═══ FD-24 CLOSE — THE PAID STAMP IS RESOLVED HERE, NOT CARRIED IN `params` ═══

    It used to arrive as `params.unpaid`, written at the call site as the literal `true`. That was
    wrong twice, and the second way is the one a patient met:

      1. `queueFeeStatusHook` calls `joinQueueInTx` EXACTLY WHEN THE MONEY IS DONE — it returns
         early on `unsettled`. So every bill-first, scheme, credit and free-revisit patient was
         handed a slip stamped UNPAID and directed to the billing counter they had just left.
      2. A REPRINT COPIED THE PARAM VERBATIM, so a slip reprinted an hour after the patient paid
         repeated the same instruction.

    Both disappear when the stamp is resolved at RENDER TIME, and render time is also the only
    correct moment: printing is asynchronous by design — the relay may claim a job minutes after it
    was queued, and the patient may have paid in between. A stamp written at enqueue is a claim
    about the past printed onto paper handed over in the present.

    `encounterFeeStatuses` is the ONE projection of the invoice ledger — the same one the queue view
    and the fee gate read — imported directly rather than through the billing module's index, which
    is the shape `kernel/orders/read.ts` already uses for `displayName`. Nothing is re-derived here.

    UNKNOWN IS NOT UNPAID. An unconfigured billing module returns an empty map, and a hospital that
    has not configured billing has no fee for a stamp to be a fact about; painting every token amber
    on day one of commissioning is the failure that reasoning exists to prevent.

    `params.unpaid` is still READ, and only as a fallback for rows queued before this change — they
    exist in the outbox on the deployed system and their slips must still print something sane.
  */
  const status = (await encounterFeeStatuses(db, [{ id: encounterId, visitType: s.visitType }])).get(encounterId);
  const unpaid = status === undefined ? params.unpaid === true : status === "unsettled";

  /*
    ═══ FD-25 — A LAB WALK-IN IS NOT AN OPD VISIT, AND ITS SLIP MUST NOT PRETEND TO BE ═══

    `openLabWalkinInTx` opens a real visit through `openVisitInTx`, so the two print jobs fire for a
    lab patient too. The paper was then written entirely for the OPD road: an UNPAID stamp pointing
    at the billing counter the patient has just left, and directions to a vitals desk expecting
    nobody and a consulting room they are not going to.

    So the LAB DEPARTMENT gets its own onward line and no stamp. What it does NOT get is a decision
    about money: whether a lab walk-in carries an OPD consult-fee obligation at all is the owner's
    question, and suppressing the slip entirely — or printing the lab invoice on it — would answer
    it in code. Dropping the stamp and the two wrong directions is reversible whichever way he
    rules; the slip still says who the patient is, what their token is, and where to sit.

    `departmentCode` is already selected by `subjectOf`, so this costs no query.
  */
  const isLab = s.departmentCode.trim().toUpperCase() === LAB_DEPARTMENT_CODE;
  const stampHtml = isLab || !unpaid
    ? ""
    : `<div class="stamp"><div class="w">UNPAID</div><div class="hi">भुगतान शेष — बिलिंग काउंटर</div></div>`;
  const onwardHtml = isLab
    ? `<li>Sample collection — ${esc(s.departmentName)}<div class="hi">नमूना संग्रह</div></li>`
    : `${unpaid ? `<li>Billing counter — ground floor<div class="hi">बिलिंग काउंटर, भूतल</div></li>` : ""}
        <li>Vitals desk — 1st floor<div class="hi">प्राथमिक जाँच डेस्क, प्रथम तल</div></li>
        <li>${esc(s.doctorName)} — ${esc(s.departmentName)}<div class="hi">डॉक्टर का कक्ष</div></li>`;

  const body = `
    <div class="hd">
      <div class="nm">${HOSPITAL.name}</div>
      <div class="ad">${HOSPITAL.address}<br>${HOSPITAL.contact}</div>
    </div>
    ${barField(s.visitNo)}
    <div class="tok">
      <div class="lbl">Token</div>
      <div class="no mo">${esc(tokenLabel(s.departmentCode, s.tokenNo))}</div>
      ${isLab ? "" : `<div class="dr">${esc(s.doctorName)}</div>`}
      <div class="dept">${esc(s.departmentName)}</div>
    </div>
    <div class="sec">
      <div class="row"><span class="k">Patient</span><span class="v">${esc(s.patientName)}</span></div>
      <div class="row"><span class="k">Age / Sex</span><span class="v">${esc(s.ageSex)}</span></div>
      <div class="row"><span class="k">UHID</span><span class="v mo">${esc(s.uhid)}</span></div>
      <div class="row"><span class="k">Visit</span><span class="v mo">${esc(s.visitNo)}</span></div>
      <div class="row"><span class="k">Date</span><span class="v">${esc(s.serviceDate)}</span></div>
    </div>
    ${stampHtml}
    <div class="next sec">
      <div class="t">Go next to</div>
      <ol>
        ${onwardHtml}
      </ol>
    </div>
    <div class="ft">${esc(s.serviceDate)} · ${esc(s.visitNo)}</div>
  `;
  return thermalPage(`Token ${tokenLabel(s.departmentCode, s.tokenNo)} — ${s.patientName}`, body);
}

/**
 * ═══ THE OPD PAYMENT RECEIPT — `PaymentReceipt.dc.html` ═══
 *
 * Same roll, same printer as the token slip, which is the whole reason `PrinterChoice` ruled a
 * label printer off the billing desk. Consultation is GST-exempt, so this is a RECEIPT and not a tax
 * invoice — it says so, because a document that looks like a tax invoice and is not one is worse
 * than a plain one.
 */
export async function renderPaymentReceipt(
  db: Db,
  params: { encounterId?: unknown; amountPaise?: unknown; mode?: unknown; receiptNo?: unknown },
  now = new Date(),
  /** FD-25 — see `renderTokenSlip`. A receipt names the patient exactly as the slip does. */
  requester: Actor | null = null,
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const s = await subjectOf(db, encounterId, now, requester);
  if (s === null) return null;
  const paise = typeof params.amountPaise === "number" ? params.amountPaise : 0;
  const rupees = `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const body = `
    <div class="hd">
      <div class="nm">${HOSPITAL.name}</div>
      <div class="ad">${HOSPITAL.address}<br>${HOSPITAL.contact}</div>
    </div>
    <div class="tok"><div class="lbl">Payment received</div><div class="no mo" style="font-size:20pt">${esc(rupees)}</div></div>
    <div class="sec">
      <div class="row"><span class="k">Patient</span><span class="v">${esc(s.patientName)}</span></div>
      <div class="row"><span class="k">UHID</span><span class="v mo">${esc(s.uhid)}</span></div>
      <div class="row"><span class="k">Visit</span><span class="v mo">${esc(s.visitNo)}</span></div>
      <div class="row"><span class="k">Token</span><span class="v mo">${esc(tokenLabel(s.departmentCode, s.tokenNo))}</span></div>
      <div class="row"><span class="k">Mode</span><span class="v">${esc(typeof params.mode === "string" ? params.mode : "cash")}</span></div>
      ${typeof params.receiptNo === "string" ? `<div class="row"><span class="k">Receipt</span><span class="v mo">${esc(params.receiptNo)}</span></div>` : ""}
      <div class="row"><span class="k">Date</span><span class="v">${esc(s.serviceDate)}</span></div>
    </div>
    <div class="ft">
      OPD consultation is exempt from GST — this is a receipt, not a tax invoice.<br>
      शुल्क प्राप्त हुआ · ${esc(s.serviceDate)}
    </div>
  `;
  return thermalPage(`Receipt ${rupees} — ${s.patientName}`, body);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRESCRIPTION SHEET — `RxPageBlank.dc.html`, A4 LASER, FRONT DESK (R2)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It prints BLANK below the vitals strip. That is the design and it is deliberate: the physician
 * writes on it. What the sheet supplies is the identity band that stops a page being matched to the
 * wrong person, the allergy band, and — owner ruling R5 — **the vitals strip, kept for manual
 * writing even though the vitals desk now prints its own slip.** The two overlap on purpose.
 *
 * ═══ FD-29, OWNER 2026-09-06: *"the prescription design needs to be changed"* ═══
 *
 * The owner sent the A4 sheet exported from this repo's OWN artboard and the crest as a separate
 * file. What that revealed is that the renderer had never matched the artboard it names: no crest,
 * no date of birth, no encounter identifiers, a placeholder allergy line that asserted nothing had
 * been checked even when three allergies were on file, and the hospital's name across the top in a
 * green that appears nowhere in the design. This rewrite is the artboard, with four departures,
 * every one of them written down here rather than left for a reader to find:
 *
 *   1. **THE ARTBOARD IN GIT IS STALE — the exported PDF is newer and wins.** It puts the ALLERGY
 *      band ABOVE the vitals strip (the artboard's own comments say allergy comes first while its
 *      markup puts it second, which is what a moved block leaves behind), and it adds the
 *      carried-height caption under the strip. Both are followed here; `render.test.ts` pins the
 *      order, because the artboard AND the shipped renderer were both wrong about it.
 *   2. **The token stays, as a sixth row.** The design drops it. Nothing else the patient carries
 *      out of the building names the token, the counter reads it off this sheet, and the owner
 *      raised token visibility as a defect four days ago. One row against that is a cheap trade —
 *      but it IS a departure from the design and reversing it is one line.
 *   3. **`Doctor ID: DR-0114` becomes `Doctor: <name> · Reg. <no>`.** There is no doctor code in
 *      this system — `opd_doctors` has no such column and the string occurs only in design canvases.
 *      An opaque internal code would also satisfy neither half of NMC Code of Ethics reg. 1.4.2,
 *      which wants the treating physician's NAME and council registration number on a prescription.
 *      Printing what the row actually holds recovers both, and recovers two of the four things the
 *      new design would otherwise have lost.
 *   4. **The QR carries the visit number, and the "password to access" line is not printed.**
 *      Owner ruling, 2026-09-06, when asked: *a real QR of the encounter, no password.* The design's
 *      8-digit access code has nothing behind it — no minting, no store, no verifier, no portal —
 *      and a code on paper that either unlocks nothing or unlocks something is a decision, not a
 *      footer line. The QR itself is REAL (`qr.ts`, pinned against an independent encoder and read
 *      back by an independent decoder); the artboard's hand-drawn 9 × 9 grid of `<div>`s is a
 *      picture of a QR and `barField`'s comment already rules against shipping one of those.
 *
 * ═══ AND ONE THING THAT IS NOT A DEPARTURE, BUT IS A DECISION ═══
 *
 * A §14 SEALED PATIENT GETS THE FULL SHEET EXCEPT THE NAME. Date of birth, gender, the allergy band
 * and the carried height all print. That is this subsystem's existing rule, not a new one:
 * `getPatientSummaries` emits `dob` and `administrativeGender` beside a nulled name and
 * `registration.test.ts` pins it with the words "uhid/administrative gender/dob **always**"; the
 * only non-name identifier withheld anywhere in this tree is the UHID on the AERB dose register,
 * for a reason specific to the UHID. It is worth knowing that `preStage` pulls the other way —
 * `sealed ? [] : …`, "Sealed: no history at all" — because the BAY's concern is a clerk browsing
 * cross-visit history, where this sheet is the patient's own document, already carrying their UHID.
 * An allergen withheld from a prescription is a safety defect. Recorded so it reads as decided.
 */
export async function renderPrescriptionSheet(
  db: Db,
  params: { encounterId?: unknown },
  now = new Date(),
  /** FD-25 — see `renderTokenSlip`. This is the sheet the patient CARRIES out of the building. */
  requester: Actor | null = null,
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const s = await subjectOf(db, encounterId, now, requester);
  if (s === null) return null;

  /*
    ═══ THE THREE READS THIS DOCUMENT MAKES AND THE OTHER TWO DO NOT ═══

    They live here rather than in `subjectOf` on purpose. `subjectOf` runs for every token slip —
    that is the counter's hot path, one per registration, all day — and neither the token slip nor
    the payment receipt has an allergy band, a vitals strip or a printed-by line. Three queries
    moved up into the shared resolver would be three queries added to the busiest document in the
    building to serve the rarest.
  */

  /*
    ACTIVE ONLY, and this is the safety-critical line on the page. `listAllergies` returns EVERY
    row newest-first, `entered_in_error` included — the table is append-only (E-8) and a correction
    is a status, not a delete. The two shipped callers (`opd/prescriptions.ts`,
    `radiology/gates.ts`) both filter exactly this way. Dropping the filter prints an allergen the
    hospital has formally retracted onto the sheet a pharmacist dispenses from.
  */
  const allergies = (await listAllergies(db, s.patientId)).filter((a) => a.status === "active");

  /*
    ONLY HEIGHT CARRIES, AND ONLY FOR AN ADULT — the bay's rule (`opd/prestage.ts`), applied to the
    paper so the two cannot disagree. A weight carried forward is the entire point of the weighing
    scale and a child's height changing IS the clinical finding, so the other five slots print
    blank even when the last chart holds them.

    The date shown is the ENCOUNTER's `service_date`, not `opd_vitals.recorded_at`: a service date
    is already an IST calendar day and needs no timezone arithmetic, and the two genuinely differ
    for a chart recorded after midnight. Same query shape as `preStage`, for the same reason.
  */
  const carried = s.ageYears !== null && s.ageYears >= 18
    ? await db
      .select({ heightCm: opdVitals.heightCm, serviceDate: opdEncounters.serviceDate })
      .from(opdVitals)
      .innerJoin(opdEncounters, eq(opdEncounters.id, opdVitals.encounterId))
      .where(and(eq(opdVitals.patientId, s.patientId), eq(opdVitals.status, "active")))
      .orderBy(desc(opdVitals.recordedAt))
      .limit(1)
    : [];
  const carriedHeight = carried[0]?.heightCm ?? null;
  const carriedOn = carriedHeight === null ? null : formatCalendarDay(carried[0]?.serviceDate ?? null);

  /*
    WHO ASKED, as a LOGIN NAME. `users.username` and not `full_name`, and the inversion of the rule
    twenty lines up is deliberate: a DOCTOR's name belongs on a slip and this file records what it
    cost to print `dr-render` there once. "Printed by" is the opposite question — it identifies the
    operator for an audit, and the operator is a login. A system, agent or unknown actor prints no
    "by" clause at all rather than a ULID nobody can look up.
  */
  const operator = requester !== null && requester.type === "user"
    ? (await db.select({ username: users.username }).from(users).where(eq(users.id, requester.id)))[0]?.username ?? null
    : null;

  const dobDay = formatCalendarDay(s.dob);
  const ageSuffix = s.ageYears === null ? "" : ` (${s.dobEstimated ? "≈" : ""}${String(s.ageYears)} years)`;
  /* An ESTIMATED date of birth is an entered age wearing a date's clothes — print the age alone. */
  const dobCell = s.dobEstimated || dobDay === null
    ? (s.ageYears === null ? "—" : `${s.dobEstimated ? "≈" : ""}${String(s.ageYears)} years`)
    : `${dobDay}${ageSuffix}`;
  const doctorCell = s.doctorRegistrationNo === null
    ? esc(s.doctorName)
    : `${esc(s.doctorName)} · Reg. ${esc(s.doctorRegistrationNo)}`;

  const css = `
    /* The geometry is the artboard's: a 794 x 1123 px page at 96 dpi is exactly A4, so the layout
       is authored in the integer pixels it was drawn in and the SHEET is stated in millimetres.
       296.8mm rather than 297: a full-height box at margin 0 rounds into a phantom second page. */
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body {
      font-family: "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      font-size: 13px; line-height: 17px; color: #000;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    /* The Devanagari stack names the two faces a WINDOWS front desk has, because the Save-as-PDF
       path writes this HTML into a blank popup with none of the app's own fonts behind it. The
       relay installs fonts-noto-devanagari; a clerk's PC installs neither. Without these two the
       allergy band's Hindi word prints as boxes on the browser path only. */
    .hi { font-family: "Noto Sans Devanagari", "Nirmala UI", Mangal, sans-serif; }
    .num { font-variant-numeric: tabular-nums; }
    .lb { color: #333; font-weight: 400; }
    .vl { color: #000; font-weight: 700; }
    .sheet { width: 210mm; height: 296.8mm; padding: 26px 30px 20px; display: flex; flex-direction: column; overflow: hidden; }
    .hd { display: flex; gap: 20px; flex-shrink: 0; }
    .hd .crest { width: 150px; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; }
    .hd .crest img { width: 78px; height: auto; display: block; }
    .hd .dept { font-size: 12px; font-weight: 700; color: #55064f; margin-top: 5px; line-height: 14px; }
    .hd .l { width: 298px; display: flex; flex-direction: column; gap: 1px; }
    .hd .r { flex-grow: 1; display: flex; flex-direction: column; gap: 1px; }
    .hd .row { display: flex; align-items: baseline; gap: 5px; min-height: 19px; }
    .hd .r .row { justify-content: flex-end; }
    .rule { height: 1px; background: #000; }
    .thin { height: 1px; background: #9a9a9a; }
    .body { flex-grow: 1; padding-top: 12px; display: flex; flex-direction: column; min-height: 0; }
    .alg { display: flex; align-items: center; gap: 9px; border: 1px solid #d92230; padding: 5px 11px; flex-shrink: 0; }
    .alg .t { font-size: 10.5px; font-weight: 700; letter-spacing: .08em; color: #d92230; text-transform: uppercase; }
    .alg .bar { width: 1px; height: 12px; background: #d92230; }
    .alg .sub { font-size: 13.5px; font-weight: 700; color: #d92230; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .alg .note { font-size: 11.5px; color: #333; white-space: nowrap; }
    .alg .hi { font-size: 11px; font-weight: 600; color: #d92230; }
    /* NO KNOWN ALLERGIES is the same band in grey. It must still be a BAND: a red frame that simply
       vanishes is indistinguishable from one that failed to render, and "nothing recorded" is a
       clinical statement a prescriber acts on. */
    .alg.none, .alg.none .t, .alg.none .sub, .alg.none .hi { border-color: #9a9a9a; color: #333; }
    .alg.none .bar { background: #9a9a9a; }
    .vit { border-top: 1px solid #9a9a9a; border-bottom: 1px solid #9a9a9a; padding: 7px 0; margin-top: 11px; flex-shrink: 0; }
    .vit .g { display: flex; align-items: baseline; gap: 0; }
    .vit .lab { font-size: 11px; color: #333; width: 52px; flex-shrink: 0; }
    .vit .slots { display: flex; gap: 12px; flex-grow: 1; }
    .vit .s { display: flex; align-items: baseline; gap: 4px; flex-grow: 1; }
    .vit .ht { display: flex; align-items: baseline; gap: 4px; width: 86px; }
    /* Scoped to the STRIP, not to the slot class, so the Ht slot gets them too. It is a .ht not a
       .s because it is fixed-width, and while these three were written ".vit .s .led" an
       uncarried height printed "Ht    cm" with no dotted line for the nurse to write on. */
    .vit .k { font-size: 10.5px; color: #666; }
    .vit .led { flex-grow: 1; border-bottom: 1px dotted #999; height: 13px; }
    .vit .u { font-size: 9.5px; color: #999; }
    .vit .cap { font-size: 9.5px; color: #777; margin-top: 4px; line-height: 17px; }
    .sig { display: flex; justify-content: flex-end; flex-shrink: 0; }
    .sig .b { width: 280px; }
    .sig .c { font-size: 9.5px; color: #8a8a8a; margin-top: 4px; text-align: right; letter-spacing: .02em; }
    .ft { flex-shrink: 0; padding-top: 12px; }
    .ft .dis { font-size: 10.5px; padding: 4px 0 5px; }
    .ft .grid { display: flex; gap: 14px; padding-top: 6px; }
    .ft .cols { flex-grow: 1; display: flex; flex-direction: column; gap: 3px; }
    .ft .line { display: flex; gap: 22px; }
    .ft .line > div, .ft .addr { font-size: 11.5px; white-space: nowrap; }
    /* The one spacer, used by the allergy band and by both footer rows. Scoped to .ft it left
       एलर्जी floating mid-band, which is the sort of thing only a rendered page shows you. */
    .sp { flex-grow: 1; }
    .ft .site { font-weight: 700; color: #d92230; }
    .ft .qr { width: 62px; height: 62px; flex-shrink: 0; }
    .ft .qr svg { display: block; }
    .ft .by { display: flex; align-items: baseline; padding-top: 4px; font-size: 10.5px; color: #333; }
  `;

  const idRow = (label: string, value: string): string =>
    `<div class="row"><span class="lb">${esc(label)}</span><span class="vl">${value}</span></div>`;
  const slot = (key: string, unit: string): string =>
    `<div class="s"><span class="k">${key}</span><span class="led"></span><span class="u">${unit}</span></div>`;

  /* Every active allergen is named. Truncating to the first would hide the one that matters, so the
     substance slot carries them all and the note says how many rows are behind the newest one. */
  const newest = allergies[0];
  const substances = allergies.map((a) => a.substance.toUpperCase()).join(", ");
  const reaction = newest === undefined || newest.reaction === null || newest.reaction.trim() === ""
    ? ""
    : `${esc(newest.reaction)}, `;
  const more = allergies.length > 1 ? ` · +${String(allergies.length - 1)} more on file` : "";
  const allergyBand = newest === undefined
    ? `<div class="alg none"><span class="t">Allergy</span><span class="bar"></span>`
      + `<span class="sub">NO KNOWN ALLERGIES</span>`
      + `<span class="note">— none recorded against this patient</span>`
      + `<div class="sp"></div><span class="hi">कोई ज्ञात एलर्जी नहीं</span></div>`
    : `<div class="alg"><span class="t">Allergy</span><span class="bar"></span>`
      + `<span class="sub">${esc(substances)}</span>`
      + `<span class="note">— ${reaction}recorded ${esc(formatCalendarDay(newest.recordedAt) ?? "—")}${more}</span>`
      + `<div class="sp"></div><span class="hi">एलर्जी</span></div>`;

  const body = `
    <div class="sheet">
      <div class="hd">
        <div class="crest">
          <img src="${CREST_PNG_DATA_URI}" alt="${HOSPITAL.nameTitleCase}">
          <div class="dept">${esc(s.departmentName)}</div>
        </div>
        <div class="l">
          ${idRow("Name:", esc(s.patientName))}
          ${idRow("UHID:", `<span class="num">${esc(s.uhid)}</span>`)}
          ${idRow("Gender:", esc(genderLetter(s.gender)))}
          ${idRow("DOB:", `<span class="num">${esc(dobCell)}</span>`)}
          ${idRow("Doctor:", doctorCell)}
        </div>
        <div class="r">
          ${idRow("Encounter ID:", `<span class="num">${esc(s.visitNo)}</span>`)}
          ${idRow("Encounter Type:", "Outpatient")}
          ${idRow("Visit/Admn Date:", `<span class="num">${esc(formatCalendarDay(s.serviceDate) ?? s.serviceDate)}</span>`)}
          ${idRow("Department:", esc(s.departmentName))}
          ${idRow("Speciality:", esc(s.doctorSpecialty ?? s.departmentName))}
          ${idRow("Token:", `<span class="num">${esc(tokenLabel(s.departmentCode, s.tokenNo))}</span>`)}
        </div>
      </div>
      <div class="rule" style="margin-top:10px;flex-shrink:0"></div>
      <div class="body">
        ${allergyBand}
        <div class="vit">
          <div class="g">
            <span class="lab">Vitals</span>
            <div class="slots">
              ${slot("BP", "mmHg")}${slot("Pulse", "/min")}${slot("Temp", "°C")}
              ${slot("SpO₂", "%")}${slot("Wt", "kg")}
              <div class="ht"><span class="k">Ht</span>${
                carriedHeight === null
                  ? `<span class="led"></span><span class="u">cm</span>`
                  : `<span class="num vl">${esc(String(carriedHeight))} cm</span>`
              }</div>
            </div>
          </div>
          ${carriedOn === null ? "" : `<div class="cap">Height carried forward from ${esc(carriedOn)} · the rest are filled at the vitals desk</div>`}
        </div>
        <div style="flex-grow:1"></div>
        <div class="sig">
          <div class="b">
            <div class="thin"></div>
            <div class="c">Signature, name &amp; registration no. of the treating physician</div>
          </div>
        </div>
      </div>
      <div class="ft">
        <div class="rule"></div>
        <div class="dis">Letterhead is computer generated. The clinical entries above are written and signed by the treating physician.</div>
        <div class="thin"></div>
        <div class="grid">
          <div class="cols">
            <div class="addr"><span class="lb">Address:</span> <span class="vl">${HOSPITAL.nameTitleCase},</span> ${HOSPITAL.address}</div>
            <div class="line">
              <div><span class="lb">24×7 Hotline:</span> <span class="vl num">${HOSPITAL.hotline}</span></div>
              <div><span class="lb">Emergency:</span> <span class="vl num">${HOSPITAL.emergency}</span></div>
              <div class="sp"></div>
              <div><span class="lb">Scan to enter the visit number</span></div>
            </div>
            <div class="line">
              <div><span class="lb">Email:</span> <span class="vl">${HOSPITAL.email}</span></div>
              <div><span class="site">${HOSPITAL.website}</span></div>
              <div class="sp"></div>
              <div><span class="lb num">${esc(s.visitNo)}</span></div>
            </div>
          </div>
          <div class="qr">${qrSvg(s.visitNo, 62)}</div>
        </div>
        <div class="thin" style="margin-top:6px"></div>
        <div class="by">
          <span class="num">${operator === null
            ? `Printed on ${esc(formatIstDay(now))} at ${esc(formatIstTime(now))}`
            : `Printed by <strong>${esc(operator)}</strong> on ${esc(formatIstDay(now))} at ${esc(formatIstTime(now))}`}</span>
          <div class="sp"></div>
          <span class="num">Page 1 of 1</span>
        </div>
      </div>
    </div>
  `;
  return {
    title: `Prescription — ${s.patientName} (${s.visitNo})`,
    // A4 is a SHEET and its height is known, so it is stated rather than measured — a prescription
    // that shrank to fit its content would stop being a letterhead.
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Prescription</title><style>${css}</style></head><body>${body}</body></html>`,
  };
}

/**
 * The one dispatcher the relay's claim goes through.
 *
 * `vitals_slip` returns null DELIBERATELY and is not an oversight: owner ruling R3 created that
 * document this session and it is the only one of the four with NO ARTBOARD. Improvising a layout
 * in code for a document the owner has not seen is how a counter ends up with a slip nobody
 * designed. A null here means the job is reported failed and the screen says so — advisory, per R7.
 */
export async function renderDocument(
  db: Db,
  document: string,
  params: Record<string, unknown>,
  now = new Date(),
  /**
   * FD-25 — the print job's `requested_by`, as an actor. It travels to EVERY document rather than to
   * the token slip alone: a fix aimed at one instance closes one instance, and the prescription is
   * the sheet that leaves the building in the patient's hand.
   */
  requester: Actor | null = null,
): Promise<RenderedDocument | null> {
  switch (document) {
    case "opd_token_slip": return await renderTokenSlip(db, params, now, requester);
    case "opd_payment_receipt": return await renderPaymentReceipt(db, params, now, requester);
    case "opd_prescription": return await renderPrescriptionSheet(db, params, now, requester);
    default: return null;
  }
}
