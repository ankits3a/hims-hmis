import { eq } from "drizzle-orm";
import {
  opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, patients,
} from "../db/schema";
import { encounterFeeStatuses } from "../../modules/billing/fee-status";
import { LAB_DEPARTMENT_CODE } from "../../modules/opd/encounters";
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

const HOSPITAL = {
  name: "CRK MEDICAL COLLEGE &amp; HOSPITAL",
  address: "Chaurasia Chowk, Hajipur — 844101, Bihar",
  contact: "Hotline +91 77648 88189 · Emergency 1068",
};

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
  patientName: string; uhid: string; ageSex: string;
  visitNo: string; serviceDate: string;
  /** FD-24 close — the fee projection reads it; see `renderTokenSlip`'s stamp. */
  visitType: string;
  departmentName: string; departmentCode: string; doctorName: string; doctorRegistrationNo: string | null;
  tokenNo: number | null; roomCode: string | null;
};

/** `MED-4`. The same grammar the screen uses — a token printed one way and said another sends a patient to the wrong door. */
function tokenLabel(code: string, tokenNo: number | null): string {
  if (tokenNo === null) return "—";
  return code.trim() === "" ? String(tokenNo) : `${code.trim().toUpperCase()}-${String(tokenNo)}`;
}

function ageSexOf(dob: string | Date | null, gender: string | null, on: Date): string {
  const letter = (gender ?? "").toLowerCase().startsWith("f") ? "F"
    : (gender ?? "").toLowerCase().startsWith("m") ? "M" : "O";
  if (dob === null || dob === "") return letter;
  // `patients.dob` is a real date column, so drizzle may hand back a Date or the ISO string,
  // depending on the mode the column was declared with. Take both rather than assume one.
  const iso = dob instanceof Date ? dob.toISOString() : String(dob);
  const born = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return letter;
  // IST, like every other date in this system — a birthday at 02:00 IST is still a birthday.
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(on).split("-").map(Number);
  let years = p[0]! - born.getUTCFullYear();
  const bm = born.getUTCMonth() + 1;
  if (p[1]! < bm || (p[1] === bm && p[2]! < born.getUTCDate())) years -= 1;
  return `${String(Math.max(0, years))} y / ${letter}`;
}

/**
 * Resolves everything a slip says about one visit, AT RENDER TIME.
 *
 * This is why `print_jobs.params` carries an encounter id and not a name: a reprint after a
 * correction hands over the CORRECTED name, and the queue row never becomes a stale second copy of
 * the patient record.
 */
async function subjectOf(db: Db, encounterId: string, now: Date): Promise<SlipSubject | null> {
  const rows = await db
    .select({
      visitNo: opdEncounters.visitNo,
      serviceDate: opdEncounters.serviceDate,
      /* FD-24 CLOSE — the token slip's paid stamp is a projection of the ledger, and
         `encounterFeeStatuses` reads `visitType` to decide which fee service applies. */
      visitType: opdEncounters.visitType,
      patientName: patients.name,
      uhid: patients.uhid,
      dob: patients.dob,
      gender: patients.administrativeGender,
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
    .select({ name: opdDoctors.displayName, registrationNo: opdDoctors.registrationNo })
    .from(opdEncounters)
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(eq(opdEncounters.id, encounterId));

  const entry = await db
    .select({ tokenNo: opdQueueEntries.tokenNo })
    .from(opdQueueEntries)
    .where(eq(opdQueueEntries.encounterId, encounterId));

  return {
    patientName: row.patientName,
    uhid: row.uhid,
    visitType: row.visitType,
    ageSex: ageSexOf(row.dob, row.gender, now),
    visitNo: row.visitNo,
    serviceDate: row.serviceDate,
    departmentName: row.departmentName,
    departmentCode: row.departmentCode,
    doctorName: doctor[0]?.name ?? "the department",
    doctorRegistrationNo: doctor[0]?.registrationNo ?? null,
    tokenNo: entry[0]?.tokenNo ?? null,
    roomCode: null,
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
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const s = await subjectOf(db, encounterId, now);
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
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const s = await subjectOf(db, encounterId, now);
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
 * ═══ THE PRESCRIPTION SHEET — `RxPageBlank.dc.html`, A4 LASER, FRONT DESK (R2) ═══
 *
 * It prints BLANK below the header. That is the design and it is deliberate: the physician writes
 * on it. What the sheet supplies is the identity band that stops a page being matched to the wrong
 * person, the allergy band, and — owner ruling R5 — **the vitals strip, still blank, kept for manual
 * writing even though the vitals desk now prints its own slip.** The two overlap on purpose.
 */
export async function renderPrescriptionSheet(
  db: Db,
  params: { encounterId?: unknown },
  now = new Date(),
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const s = await subjectOf(db, encounterId, now);
  if (s === null) return null;

  const css = `
    @page { size: A4 portrait; margin: 12mm 14mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: "IBM Plex Sans", "Noto Sans", "Noto Sans Devanagari", sans-serif; font-size: 10pt; color: #111; }
    .crest { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #14532d; padding-bottom: 4mm; }
    .crest .nm { font-size: 15pt; font-weight: 700; color: #14532d; letter-spacing: .01em; }
    .crest .ad { font-size: 8.5pt; color: #444; margin-top: 1mm; }
    .crest .dept { text-align: right; font-size: 10pt; font-weight: 600; }
    .band { display: flex; gap: 6mm; margin-top: 4mm; font-size: 9pt; }
    .band .col { flex: 1; }
    .band .r { display: flex; gap: 2mm; padding: .7mm 0; }
    .band .k { color: #666; min-width: 26mm; }
    .band .v { font-weight: 600; }
    .vitals { margin-top: 4mm; border: 1px solid #cbd5d1; border-radius: 2mm; padding: 2.5mm 3mm; }
    .vitals .t { font-size: 7.5pt; letter-spacing: .14em; text-transform: uppercase; color: #14532d; font-weight: 700; }
    .vitals .g { display: flex; gap: 4mm; margin-top: 1.5mm; font-size: 9pt; color: #555; }
    .vitals .g span { flex: 1; border-bottom: 1px dotted #94a3a0; padding-bottom: 3mm; }
    .allergy { margin-top: 3mm; border: 1.2px solid #b91c1c; border-radius: 2mm; padding: 2mm 3mm; color: #b91c1c; font-size: 9pt; }
    .allergy .t { font-weight: 700; letter-spacing: .1em; font-size: 7.5pt; text-transform: uppercase; }
    .rx { margin-top: 5mm; min-height: 150mm; }
    .rx .sym { font-size: 20pt; color: #14532d; font-weight: 700; }
    .sign { margin-top: 6mm; border-top: 1px solid #999; width: 70mm; margin-left: auto; padding-top: 1.5mm; font-size: 8pt; color: #555; text-align: center; }
    .foot { margin-top: 6mm; border-top: 1px solid #cbd5d1; padding-top: 2mm; font-size: 7.5pt; color: #666; display: flex; justify-content: space-between; gap: 4mm; }
    .mo { font-family: "IBM Plex Mono", monospace; }
  `;
  const body = `
    <div class="crest">
      <div>
        <div class="nm">${HOSPITAL.name}</div>
        <div class="ad">${HOSPITAL.address}<br>${HOSPITAL.contact}</div>
      </div>
      <div class="dept">${esc(s.departmentName)}<div style="font-weight:400;font-size:8.5pt;color:#555">${esc(s.doctorName)}</div></div>
    </div>
    <div class="band">
      <div class="col">
        <div class="r"><span class="k">Name</span><span class="v">${esc(s.patientName)}</span></div>
        <div class="r"><span class="k">UHID</span><span class="v mo">${esc(s.uhid)}</span></div>
        <div class="r"><span class="k">Age / Sex</span><span class="v">${esc(s.ageSex)}</span></div>
      </div>
      <div class="col">
        <div class="r"><span class="k">Visit</span><span class="v mo">${esc(s.visitNo)}</span></div>
        <div class="r"><span class="k">Token</span><span class="v mo">${esc(tokenLabel(s.departmentCode, s.tokenNo))}</span></div>
        <div class="r"><span class="k">Date</span><span class="v">${esc(s.serviceDate)}</span></div>
      </div>
    </div>
    <div class="vitals">
      <div class="t">Vitals</div>
      <div class="g"><span>BP mmHg</span><span>Pulse /min</span><span>Temp °C</span><span>SpO₂ %</span><span>Wt kg</span><span>Ht cm</span></div>
    </div>
    <div class="allergy"><span class="t">Allergy</span> — to be confirmed with the patient · एलर्जी</div>
    <div class="rx"><span class="sym">℞</span></div>
    <div class="sign">${s.doctorRegistrationNo === null ? "" : `<div style="font-weight:600;color:#111">Reg. no. ${esc(s.doctorRegistrationNo)}</div>`}Signature, name &amp; registration no. of the treating physician</div>
    <div class="foot">
      <span>Letterhead is computer generated. The clinical entries above are written and signed by the treating physician.</span>
      <span class="mo">${esc(s.visitNo)}</span>
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
): Promise<RenderedDocument | null> {
  switch (document) {
    case "opd_token_slip": return await renderTokenSlip(db, params, now);
    case "opd_payment_receipt": return await renderPaymentReceipt(db, params, now);
    case "opd_prescription": return await renderPrescriptionSheet(db, params, now);
    default: return null;
  }
}
