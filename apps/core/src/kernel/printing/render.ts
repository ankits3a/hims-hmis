import { and, asc, desc, eq } from "drizzle-orm";
import {
  opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdVitals, patientGuardians, patients, users,
} from "../db/schema";
import { encounterFeeStatuses } from "../../modules/billing/fee-status";
/* The FREE branch only — it returns before `previewInvoice`, so a revisit is cheap and a paying
   visit never reaches it. Imported directly, the shape this file already uses for `encounterFeeStatuses`. */
import { feeQuote } from "../../modules/billing/charge-rules";
import { LAB_DEPARTMENT_CODE } from "../../modules/opd/encounters";
/* FD-25 §14 — the ONE place a confidential patient's name is decided. See `subjectOf`.
   `resolvePatientId` is the OTHER half of that decision: it names WHOSE record this is after a
   merge, and the rule cannot be asked without that. See `canonicalPersonOf`. */
import { displayName, displayNameForRelease, listAllergies, resolvePatientId } from "../../modules/patients";
/* FD-29 — the crest as a data URI and a real QR encoder, both self-contained: `RenderedDocument`
   promises HTML with no external fetch, and the relay may be printing with the uplink down. */
import { CREST_PNG_DATA_URI } from "./crest";
// 2026-10-04 (owner) — the prescriber line. Imported from the file, not the roster index: the index
// reaches the board printer, which reaches this renderer, and a load cycle resolves to `undefined`.
import { prescriberPrint } from "../../modules/roster/doctor-units";
import { qrSvg } from "./qr";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import { HOSPITAL, esc, registerDocumentRenderer, registeredRenderer } from "./document-kit";
import type { DocumentRenderer, RenderedDocument } from "./document-kit";
export { HOSPITAL, esc, registerDocumentRenderer };
export type { DocumentRenderer, RenderedDocument };

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
export function formatCalendarDay(value: string | Date | null): string | null {
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
export function genderLetter(gender: string | null): string {
  const g = (gender ?? "").toLowerCase();
  if (g.startsWith("f")) return "F";
  if (g.startsWith("m")) return "M";
  return g.startsWith("o") ? "O" : "—";
}

/**
 * `extraCss` — PHARMACY P1: a document registered by a module (the pharmacy's bill and labels)
 * adds its own rules to the roll's, rather than growing this file's stylesheet for a layout it does
 * not own. The OPD documents pass none and print byte-for-byte as before.
 */
export function thermalPage(title: string, body: string, extraCss = ""): RenderedDocument {
  return {
    title,
    // 72 mm wide, and `null` height means CONTINUOUS: the relay measures the laid-out document.
    page: { widthMm: 72, heightMm: null },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${THERMAL_CSS}${extraCss}</style></head><body>${body}</body></html>`,
  };
}

/**
 * ═══ THE 4 × 6 INCH BILL PAGE (owner, 2026-10-02) ═══
 *
 * *"The invoice bill should be in 4 x 6 inch print page. I will be using dot matrix printer."* A cut
 * sheet, not a roll: 101.6 × 152.4 mm, and BOTH dimensions are explicit, so Chromium honours the
 * `@page` rule and paginates a long bill onto further 4 × 6 pages by itself — the relay has nothing
 * to measure.
 *
 * It keeps the roll's classes (`.hd`, `.row`, `.sec`, `.ft`) so a module's body prints on either
 * stock, and overrides what a dot-matrix head needs: pure black, no hairline thinner than 1px, a
 * larger body size than the roll's, and no row split across a page.
 */
export const BILL_PAGE_MM = { widthMm: 101.6, heightMm: 152.4 } as const;
const BILL_4X6_CSS = `
  @page { size: 4in 6in; margin: 0; }
  body { width: 4in; padding: 4mm 4.5mm 5mm; font-size: 10pt; line-height: 1.3; }
  .hd .nm { font-size: 12pt; }
  .hd .ad { font-size: 8.5pt; }
  .row { font-size: 9.5pt; }
  .ft { font-size: 8pt; }
  tr, .row, .lab { break-inside: avoid; page-break-inside: avoid; }
  .newpage { break-before: page; page-break-before: always; }
`;
export function billPage(title: string, body: string, extraCss = ""): RenderedDocument {
  return {
    title,
    page: { ...BILL_PAGE_MM },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${THERMAL_CSS}${extraCss}${BILL_4X6_CSS}</style></head><body>${body}</body></html>`,
  };
}

/** The identity every document repeats, because a slip that cannot be matched to a person is litter. */
export type SlipSubject = {
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
  /**
   * FD-29 — `opd_doctors.code`, the DOCTOR ID the A4 letterhead prints. NOT NULL on the column, so
   * the `—` fallback below can only be reached by an encounter with no doctor at all.
   */
  doctorCode: string | null;
  /** 2026-10-04 — the prescriber's user, so the prescription can print their UNIT instead of any id. */
  doctorUserId: string | null;
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
 *
 * EXPORTED for a module-registered OPD document (the glasses prescription, `modules/opd/
 * glasses-print.ts`): a second resolver of "whose name may reach paper" in the module would be the
 * second authority the §14 comment below exists to prevent. `HOSPITAL`, `formatCalendarDay` and
 * `genderLetter` are exported for the same sheet, for the same reason.
 */
export async function subjectOf(
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
      name: opdDoctors.displayName, registrationNo: opdDoctors.registrationNo, code: opdDoctors.code, userId: opdDoctors.userId,
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
    doctorCode: doctor[0]?.code ?? null,
    doctorUserId: doctor[0]?.userId ?? null,
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

/** Owner, 2026-10-01 — how a fee waived as the hospital's social service prints, on every paper. */
export const SAMAJ_SEVA_AMOUNT = "₹0 (समाज सेवा छूट)";

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
    ═══ FD-33 — WHY THERE IS NO BILL AGAINST THIS TOKEN (OWNER, 2026-09-13) ═══

    Owner: *"when a patient is revisiting, I can't find a bill against the token. The reason of no
    bill is because revisit is free in a certain period of time. But when auditing, I am unable to
    see why there's no bill against that token."*

    The owner's proposal was to print the VISIT TYPE, and that is printed below. But a type answers
    only one of the four reasons a token legitimately carries no bill, and one of the other three
    landed this morning:

      · REVISIT inside the review window  — free, and there is no charge to be missing
      · PANEL / TPA / corporate           — billed, just not to the patient
      · FEE BYPASS (FD-32)                — owed, deferred by a named clerk at the front desk
      · genuinely unbilled                — the leak the daily close's orphan scan exists to find

    So the slip prints the LEDGER'S VERDICT beside the type, which subsumes it. `status` is the same
    projection the stamp above reads — no second derivation, no second chance to disagree.

    THE WINDOW DATE IS FETCHED ONLY ON THE FREE BRANCH, and that is what makes it affordable:
    `feeQuote` returns EARLY for a visit with no fee service (`charge-rules.ts`), before
    `previewInvoice` runs, so a revisit costs one config read and the anchor lookup and a paying
    visit costs nothing at all. An auditor holding the slip then reads the window end rather than
    computing it from a policy they have to remember.
  */
  /*
    WHO PRINTED IT, and the owner's other half of the same report: *"There's no staff username and
    time of the print visible on token."* The footer used to repeat `serviceDate · visitNo` — both
    already in the body two rows up — so the one line a thermal roll can spare said nothing new.

    `username` and not `full_name`, and the reason is `renderPrescriptionSheet`'s, which has printed
    this line since FD-29: "Printed by" identifies an OPERATOR for an audit, and an operator is a
    login. A system, agent or unknown actor prints no "by" clause rather than a ULID nobody can look
    up — the token slip is enqueued by the desk and claimed by a relay, so that case is real here.
  */
  const slipOperator = requester !== null && requester.type === "user"
    ? (await db.select({ username: users.username }).from(users).where(eq(users.id, requester.id)))[0]?.username ?? null
    : null;

  const VISIT_TYPE_LABEL: Record<string, string> = { new: "NEW", revisit: "REVISIT", renewal: "RENEWAL" };
  const typeLabel = VISIT_TYPE_LABEL[s.visitType] ?? s.visitType.toUpperCase();
  let moneyLine: string;
  if (status === "free") {
    let until: string | null = null;
    let feesOff = false;
    try {
      const quote = await feeQuote(db, encounterId, now);
      until = quote.freeReason === null ? null : formatCalendarDay(quote.freeReason.windowEndsOn);
      feesOff = quote.feesOff;
    } catch {
      /* An unconfigured or unpriceable visit still prints the TYPE; it simply cannot name a window.
         A slip that failed to render because the fee policy moved would be far worse than one
         missing a date. */
    }
    /*
      OWNER, 2026-10-01: *"On the bill and receipt, clearly mention amount ₹0 (Samaj Seva Chhoot) in
      Hindi."* A visit that is free because the consultation fee is switched off has no bill and no
      receipt — this slip is the only paper it prints — so the amount and its reason are said here.
    */
    moneyLine = feesOff
      ? SAMAJ_SEVA_AMOUNT
      : until === null
      ? "FREE — review visit, no consultation fee"
      : `FREE — review visit, no fee until ${until}`;
  } else if (status === "settled") moneyLine = "PAID";
  else if (status === "credit") moneyLine = "ON CREDIT — amount owed";
  else if (status === "unsettled") moneyLine = "UNPAID — pay at the billing counter";
  /* UNKNOWN IS NOT A CLAIM. An unconfigured hospital has no fee policy, so the slip says the type
     and nothing about money — the same rule the stamp above follows. */
  else moneyLine = "";

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
      <div class="row"><span class="k">Visit type</span><span class="v">${esc(typeLabel)}</span></div>
      ${moneyLine === "" ? "" : `<div class="row"><span class="k">Fee</span><span class="v">${esc(moneyLine)}</span></div>`}
    </div>
    ${stampHtml}
    <div class="next sec">
      <div class="t">Go next to</div>
      <ol>
        ${onwardHtml}
      </ol>
    </div>
    <div class="ft">${slipOperator === null
      ? `Printed ${esc(formatIstDay(now))} at ${esc(formatIstTime(now))}`
      : `Printed by ${esc(slipOperator)} · ${esc(formatIstDay(now))} at ${esc(formatIstTime(now))}`}</div>
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

  // Owner, 2026-10-01 — a ₹0 receipt says why it is ₹0, in Hindi, under the amount.
  const sevaHtml = paise === 0 ? `<div class="hi" style="font-size:11pt;font-weight:700">${SAMAJ_SEVA_AMOUNT}</div>` : "";
  const body = `
    <div class="hd">
      <div class="nm">${HOSPITAL.name}</div>
      <div class="ad">${HOSPITAL.address}<br>${HOSPITAL.contact}</div>
    </div>
    <div class="tok"><div class="lbl">Payment received</div><div class="no mo" style="font-size:20pt">${esc(rupees)}</div>${sevaHtml}</div>
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
 *   2. ~~**The token stays, as a sixth row.**~~ **WITHDRAWN 2026-09-12 on the owner's instruction:**
 *      *"I would like you to remove 'Token:' field from the prescription."* The identity band is now
 *      the artboard's five rows on the right and this renderer no longer departs from the design
 *      here.
 *
 *      The trade this departure was made on has since been paid off elsewhere, which is why the
 *      withdrawal costs nothing. It was kept because "nothing else the patient carries out of the
 *      building names the token, the counter reads it off this sheet, and the owner raised token
 *      visibility as a defect four days ago" — but that report was about the BILLING COUNTER, where
 *      a cashier had no token on screen to match against the patient's slip, and FD-28 answered it
 *      there: the counter's rail draws `visit-token` from the quote. The token also still prints on
 *      `renderTokenSlip`, which is the paper the patient is actually holding when they present at a
 *      counter. So the token is on the cashier's screen and on the patient's slip; what it is no
 *      longer on is the clinical sheet the doctor writes on, which is what the design always said.
 *   3. **`Doctor ID` prints, and the doctor's name and council number do NOT** — owner, 2026-09-06,
 *      overruling this file's first answer: *"As a medical Institution with college, there's no need
 *      of mentioning Dr. Name and their registration number. Only Dr. ID is required."* The first cut
 *      substituted the name because `DR-0114` existed in five design canvases and in NO COLUMN;
 *      `opd_doctors.code` was added for this (migration `0074_opd_doctor_code`, minted `DR-nnnn`,
 *      overridable by a college that issues its own faculty numbers). See `doctorCell` for why the
 *      regulator's requirement is met by the signature block rather than by the letterhead.
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

  /*
    HISTORY. The header printed DOB (an estimated date as the age alone) and a "Doctor ID" row: owner
    2026-09-06 *"Only Dr. ID is required"*, 2026-09-28 *"Prescription print: Doctor ID only"*. Both are
    superseded for this sheet by the owner's header of 2026-10-04 below (Age; Unit Number; Dept. Regn).
  */
  /*
    ═══ OWNER, 2026-10-04 — THE HEADER, FIELD BY FIELD (supersedes the "Doctor ID only" rulings above) ═══

    In this order: Name · Guardian Name (2026-10-07) · UHID · Gender · Age · Address · Unit Number | Encounter ID · Encounter Type ·
    Visit Date · Dept. Regn. The department NAME prints under the crest. NO doctor's name anywhere:
      · Unit Number — the prescriber's unit that day ("Unit I"); a doctor in no unit (Guest Faculty,
        and DECIDED: anyone else in none, e.g. Community Medicine) prints the Doctor ID here instead.
        The words "Guest Faculty" never print.
      · Dept. Regn — ONE field (owner correction, same day): the DEPARTMENT registration number, i.e.
        the council number of that day's head of the unit concerned (officiating head counts) — the
        prescriber's own unit, or for a doctor in no unit the unit holding the department's OPD that
        day; blank when the department has no unit or the head has no number on file. The OPD admin
        screen lists unit heads with none, so the gap is seen.
      · Encounter ID — `visit_no`, the spelling the house prints and a clerk types back.
      · Encounter Type — OPD (the same field will carry IPD / Emergency).
      · Visit Date — the OPD visit day (the admission date, once IPD exists).
      · Address — as registered; the row is left out when there is none, and for a sealed patient
        (§14: the seal covers where they live as much as who they are).
  */
  const visitDay = String(s.serviceDate).slice(0, 10);
  const clinic = (await db.select({ d: opdEncounters.departmentId }).from(opdEncounters).where(eq(opdEncounters.id, encounterId)))[0]?.d ?? null;
  const prescriber = s.doctorUserId === null
    ? { unitNumber: "—", deptRegn: null as string | null }
    : await prescriberPrint(db, { userId: s.doctorUserId, code: s.doctorCode }, { istDate: visitDay, opdDepartmentId: clinic });
  const home = (await db.select({ addressLine: patients.addressLine, district: patients.district, stateName: patients.stateName, pincode: patients.pincode, sealed: patients.isConfidential, fatherHusbandName: patients.fatherHusbandName })
    .from(patients).where(eq(patients.id, s.patientId)))[0];
  const addressText = home === undefined || home.sealed ? "" : [home.addressLine, home.district, home.stateName, home.pincode]
    .map((x) => x?.trim() ?? "").filter((x) => x !== "").join(", ");
  /*
    ═══ GUARDIAN NAME — owner, 2026-10-07 ═══
    *"Add 'Guardian Name' label & field in the prescription slip print along with name, age and other
    fields."* It sits under Name. The value is the guardian whose authority stands on the visit day
    (the oldest link first — the one registration made), with the relation written the way an Indian
    record writes it: a father or mother is S/o or D/o by the patient's gender, a husband W/o, anyone
    else C/o. With no guardian linked it falls back to the registered father's / husband's name —
    S/o for a man; a woman's may be either, so the sheet does not guess and prints C/o.
    Nothing recorded prints the label and a blank value (the Dept. Regn rule), and a sealed patient's
    is blank too: §14 covers who stands beside them as much as where they live.
  */
  const guardianText = home === undefined || home.sealed ? "" : await (async (): Promise<string> => {
    const male = s.gender.toLowerCase().startsWith("m");
    const female = s.gender.toLowerCase().startsWith("f");
    const links = await db.select({ name: patientGuardians.name, relationship: patientGuardians.relationship, validTo: patientGuardians.validTo })
      .from(patientGuardians)
      .where(and(eq(patientGuardians.patientId, s.patientId), eq(patientGuardians.status, "active")))
      .orderBy(asc(patientGuardians.createdAt));
    const standing = links.find((g) => g.name.trim() !== "" && (g.validTo === null || g.validTo.getTime() > now.getTime()));
    if (standing !== undefined) {
      const parent = standing.relationship === "father" || standing.relationship === "mother";
      const prefix = parent && male ? "S/o" : parent && female ? "D/o"
        : standing.relationship === "spouse" && female ? "W/o" : "C/o";
      return `${prefix} ${standing.name.trim()}`;
    }
    const registered = home.fatherHusbandName?.trim() ?? "";
    return registered === "" ? "" : `${male ? "S/o" : "C/o"} ${registered}`;
  })();
  const ageCell = s.ageYears === null ? "—" : `${s.dobEstimated ? "≈" : ""}${String(s.ageYears)} years`;
  const signatureCaption = "Signature of the treating physician";
  /** Past this many characters the header's address steps down to 10px (two lines at 10.5px hold about 190). */
  const ADDRESS_LONG_CHARS = 170;

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
    .hd { display: flex; gap: 18px; flex-shrink: 0; }
    .hd .crest { width: 132px; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; }
    .hd .crest img { width: 78px; height: auto; display: block; }
    .hd .dept { font-size: 10.5px; font-weight: 700; color: #55064f; margin-top: 4px; line-height: 12px; }
    /* Owner 2026-10-05: "the fields could not hold many information … the address field looks
       awkward". The fields were two flex columns, the left one 298px wide, so a real address wrapped
       into six lines while the right column stood half empty. They are now ONE grid over the full
       width beside the crest, placed by the c-* classes (the DOM keeps the owner's order):
         Name          | Encounter ID
         Guardian Name | Encounter Type    (owner 2026-10-07 — one line, clipped with an ellipsis)
         UHID          | Visit Date
         Gender  Age   |
         Address — the whole width, at most two lines
         Unit Number   | Dept. Regn        (the unit and its head's number, side by side)
       Owner, same day, on staging: "every text in the header should be small so that more
       information can fit in". Values 10.5px semibold (600 stays crisp at that size where 700
       fills in on a laser), labels 10px, the long address 10px. */
    .hd .f { flex-grow: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      column-gap: 18px; row-gap: 1px; align-content: start; font-size: 10.5px; line-height: 13px; }
    .hd .f > div { min-width: 0; }
    .hd .row { display: flex; align-items: baseline; gap: 4px; min-height: 14px; }
    .hd .row .lb { font-size: 10px; flex-shrink: 0; }
    .hd .row .vl { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
    .hd .c-name { grid-area: 1 / 1; } .hd .c-guard { grid-area: 2 / 1; } .hd .c-uhid { grid-area: 3 / 1; } .hd .c-ga { grid-area: 4 / 1; display: flex; gap: 22px; }
    .hd .c-addr { grid-area: 5 / 1 / 6 / 3; } .hd .c-unit { grid-area: 6 / 1; }
    .hd .c-enc { grid-area: 1 / 2; } .hd .c-type { grid-area: 2 / 2; } .hd .c-date { grid-area: 3 / 2; } .hd .c-regn { grid-area: 6 / 2; }
    .hd .c-guard .vl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; overflow-wrap: normal; }
    /* A name wraps to a second line at most; an address too, and a very long one steps down to 10px
       before it is clipped — the pincode is at its END and is the part a clerk needs. */
    .hd .c-name .vl, .hd .c-addr .vl { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
    .hd .c-addr.long .vl { font-size: 10px; }
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
    /* Owner 2026-09-12 — the empty band is a WRITING STRIP; a pen needs more than a text line. */
    .alg.blank { min-height: 9mm; }
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
  /*
    ═══ NOTHING RECORDED PRINTS A BLANK STRIP, NOT A CLAIM ═══

    Owner, 2026-09-12: *"If there's no allergy is recorded then do not print 'NO KNOWN ALLERGIES' —
    keep it blank for the staff to write it using pen if any allergy is found later."*

    It used to print NO KNOWN ALLERGIES over an empty register, which is a clinical assertion the
    hospital had not made: nobody had asked. "None" and "not asked" are different facts and this
    sheet could only ever say the first. A blank strip says the true thing — there is nothing on
    file — and leaves the doctor somewhere to write what they learn in the room.

    THE LABEL AND THE BOX STAY. A band that vanished when empty would leave no writing space, and a
    reader could not tell "no allergy section on this form" from "nothing to report"; the empty
    outline IS the instruction. It is also taller than the populated band for exactly one reason:
    a pen needs room.
  */
  const allergyBand = newest === undefined
    ? `<div class="alg none blank"><span class="t">Allergy</span><span class="bar"></span>`
      + `<div class="sp"></div><span class="hi">एलर्जी</span></div>`
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
        <div class="f">
          <div class="c-name">${idRow("Name:", esc(s.patientName))}</div>
          <div class="c-guard">${idRow("Guardian Name:", esc(guardianText))}</div>
          <div class="c-uhid">${idRow("UHID:", `<span class="num">${esc(s.uhid)}</span>`)}</div>
          <div class="c-ga">${idRow("Gender:", esc(genderLetter(s.gender)))}${idRow("Age:", `<span class="num">${esc(ageCell)}</span>`)}</div>
          ${addressText === "" ? "" : `<div class="c-addr${addressText.length > ADDRESS_LONG_CHARS ? " long" : ""}">${idRow("Address:", esc(addressText))}</div>`}
          <div class="c-unit">${idRow("Unit Number:", `<span class="num">${esc(prescriber.unitNumber)}</span>`)}</div>
          <div class="c-enc">${idRow("Encounter ID:", `<span class="num">${esc(s.visitNo)}</span>`)}</div>
          <div class="c-type">${idRow("Encounter Type:", "OPD")}</div>
          <div class="c-date">${idRow("Visit Date:", `<span class="num">${esc(formatCalendarDay(s.serviceDate) ?? s.serviceDate)}</span>`)}</div>
          <div class="c-regn">${idRow("Dept. Regn:", prescriber.deptRegn === null ? "" : `<span class="num">${esc(prescriber.deptRegn)}</span>`)}</div>
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
            <div class="c">${signatureCaption}</div>
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
    default: {
      const registered = registeredRenderer(document);
      return registered === undefined ? null : await registered(db, params, now, requester);
    }
  }
}
