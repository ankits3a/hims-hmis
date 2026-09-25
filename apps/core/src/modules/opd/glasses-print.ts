import { withTx } from "../../kernel/db/client";
import { CREST_PNG_DATA_URI } from "../../kernel/printing/crest";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import {
  HOSPITAL, esc, formatCalendarDay, genderLetter, registerDocumentRenderer, subjectOf,
} from "../../kernel/printing/render";
import { requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import { SECTION_DEFS, profileForDepartment, sectionRecord } from "./sections";
import type { Actor } from "@hmis/contracts";
import type { z } from "zod";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE GLASSES PRESCRIPTION, ITS OWN PRINT (board `Ophthal`, approved 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The board draws the glasses section as "GLASSES PRESCRIPTION · ITS OWN PRINT" with a "Print
 * glasses Rx" button: the patient takes this sheet to an optician, who is not the hospital and
 * reads nothing else we print. Printing is SERVER-SIDE (owner ruling 2026-09-04): the doctor asks,
 * one job is queued to the front desk's A4 laser, and the relay's claim renders it from here.
 *
 * ═══ ONE JOB PER VERSION, AND THE JOB NAMES ITS VERSION ═══
 *
 * The section is append-only (D7): an edit is a new row. The dedupe key is `glasses:<recordId>`, so
 * pressing twice for the same prescription queues ONE sheet, and an edit afterwards queues again —
 * the optician must get the lenses the doctor last wrote. `params` carries the record id, so a
 * reprint from the desk's papers list (`/print/reprint`, which copies params) prints the version
 * that was queued rather than whatever is current by then — a reprint that silently changed the
 * powers would be a second prescription nobody signed.
 *
 * ═══ THE DOCTOR ID PRINTS, AND THE DOCTOR'S NAME AND COUNCIL NUMBER DO NOT ═══
 *
 * Owner ruling, 2026-09-06, on the hospital's prescription paper: *"As a medical Institution with
 * college, there's no need of mentioning Dr. Name and their registration number. Only Dr. ID is
 * required."* The ruling is about this hospital's paper, not about one sheet, so the glasses
 * prescription follows it exactly as `renderPrescriptionSheet` does — the Doctor ID and a signature
 * line. (A first cut named the prescriber on the reasoning that this sheet leaves the building; that
 * is the owner's call, not this file's, and he had made it.)
 *
 * WHOSE NAME REACHES PAPER is the kernel's `subjectOf` — the one §14 decision every OPD document
 * asks, merge chain and break-glass included — not a second answer written here.
 */

type GlassesBody = z.infer<(typeof SECTION_DEFS)["eye.glasses_rx"]["body"]>;
type Lens = GlassesBody["od"];

const USE_LABEL: Record<string, string> = { distance: "Distance", near: "Near", bifocal: "Bifocal", progressive: "Progressive" };

/** Signed dioptres to two decimals, as the screen's `fmtPower` writes them: −1.25, +2.50, 0.00. Blank when not prescribed. */
export function fmtPower(n: number | null): string {
  if (n === null) return "";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;
}

/** An axis is whole degrees, 1–180. Blank when there is no cylinder to orient. */
function fmtAxis(n: number | null): string {
  return n === null ? "" : `${String(Math.round(n))}°`;
}

/** A power the optician grinds: SPH, CYL or ADD. An axis alone is not one. */
function hasPower(b: GlassesBody): boolean {
  return [b.od, b.os].some((e) => e.sph !== null || e.cyl !== null || e.add !== null);
}

function parseBody(body: unknown): GlassesBody | null {
  const r = SECTION_DEFS["eye.glasses_rx"].body.safeParse(body);
  return r.success ? r.data : null;
}

/**
 * The producer: `POST /opd/visits/:id/glasses-rx/print`.
 *
 * The TREATING doctor only (`requireTreatingDoctor`, the consult's own guard), and in ANY encounter
 * status — a doctor may print after completing the visit, and a sheet is not a consultation act, so
 * neither the edit lease nor `in_consultation` applies. The visit's department must show the glasses
 * section, so a general-medicine visit cannot print an eye prescription by URL.
 *
 * `{ queued: false }` is SUCCESS, the kernel's rule: this version is already coming off the printer.
 */
export async function printGlassesRx(db: Db, actor: Actor, encounterId: string): Promise<{ queued: boolean }> {
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, enc);
  const profile = await profileForDepartment(db, enc.departmentId);
  if (profile === null || !profile.sections.includes("eye.glasses_rx")) {
    throw new OpdError("section_not_in_profile", "the glasses prescription is not on this department's consult");
  }
  const rec = await sectionRecord(db, enc.id, "eye.glasses_rx");
  const body = rec === undefined ? null : parseBody(rec.body);
  if (rec === undefined || body === null || !hasPower(body)) {
    throw new OpdError("glasses_rx_empty", "no lens power is recorded on this visit's glasses prescription");
  }
  const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
    document: "opd_glasses_rx",
    params: { encounterId: enc.id, recordId: rec.id },
    dedupeKey: `glasses:${rec.id}`,
    patientId: enc.patientId,
    encounterId: enc.id,
    requestedBy: actor.id,
  }));
  return { queued: id !== null };
}

const CSS = `
  /* A4, stated in millimetres like the prescription sheet; 296.8mm so a full-height box at margin 0
     does not round into a phantom second page. */
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font-family: "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 13px; line-height: 17px; color: #000;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .num { font-variant-numeric: tabular-nums; }
  .lb { color: #333; font-weight: 400; }
  .vl { color: #000; font-weight: 700; }
  .sheet { width: 210mm; height: 296.8mm; padding: 26px 30px 20px; display: flex; flex-direction: column; overflow: hidden; }
  .hd { display: flex; gap: 20px; align-items: flex-start; flex-shrink: 0; }
  .hd .crest img { width: 78px; height: auto; display: block; }
  .hd .nm { font-size: 17px; font-weight: 700; line-height: 22px; }
  .hd .ad { font-size: 11.5px; color: #333; margin-top: 2px; }
  .hd .dept { font-size: 12px; font-weight: 700; color: #55064f; margin-top: 5px; }
  .rule { height: 1px; background: #000; }
  .thin { height: 1px; background: #9a9a9a; }
  h1 { font-size: 18px; letter-spacing: .06em; text-transform: uppercase; margin: 14px 0 10px; }
  .id { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 24px; }
  .id .row { display: flex; gap: 6px; align-items: baseline; }
  table.rx { width: 100%; border-collapse: collapse; margin-top: 16px; }
  table.rx th, table.rx td { border: 1px solid #000; padding: 8px 10px; text-align: center; font-size: 15px; height: 40px; }
  table.rx th { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; background: #f2f2f2; }
  table.rx td.eye { font-weight: 700; text-align: left; width: 22%; }
  table.rx td.eye .sub { display: block; font-size: 10.5px; font-weight: 400; color: #333; }
  .more { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; }
  .more .row { display: flex; gap: 8px; align-items: baseline; }
  .sp { flex-grow: 1; }
  .sig { display: flex; justify-content: flex-end; flex-shrink: 0; }
  .sig .b { width: 300px; text-align: right; }
  .sig .who { font-weight: 700; margin-top: 4px; }
  .sig .c { font-size: 10.5px; color: #333; }
  .ft { flex-shrink: 0; padding-top: 12px; font-size: 11px; }
  .ft .dis { padding: 4px 0 5px; }
`;

/**
 * The renderer, registered for `opd_glasses_rx` by `registerOpdGlassesPrinting`. PURE of the clock:
 * `now` arrives as an argument (the age on the sheet is the render moment's) and nothing here reads
 * `Date.now()` or a random number.
 *
 * A record id that is not this visit's glasses row renders NOTHING rather than another visit's
 * lenses; a job with no id prints the current row (a row queued before ids travelled, or a direct
 * caller). Null is an advisory failure the relay reports (R7).
 */
export async function renderGlassesRx(
  db: Db, params: Record<string, unknown>, now: Date, requester: Actor | null,
): Promise<RenderedDocument | null> {
  const encounterId = typeof params.encounterId === "string" ? params.encounterId : null;
  if (encounterId === null) return null;
  const recordId = typeof params.recordId === "string" ? params.recordId : null;
  const rec = await sectionRecord(db, encounterId, "eye.glasses_rx", recordId);
  const b = rec === undefined ? null : parseBody(rec.body);
  if (b === null) return null;
  const s = await subjectOf(db, encounterId, now, requester);
  if (s === null) return null;

  const idRow = (label: string, value: string): string =>
    `<div class="row"><span class="lb">${esc(label)}</span><span class="vl">${value}</span></div>`;
  const cell = (eye: "od" | "os", f: keyof Lens, text: string): string =>
    `<td class="num" data-cell="${eye}-${f}">${esc(text)}</td>`;
  const eyeRow = (eye: "od" | "os", name: string, sub: string): string => {
    const e = b[eye];
    return `<tr><td class="eye">${esc(name)}<span class="sub">${esc(sub)}</span></td>`
      + `${cell(eye, "sph", fmtPower(e.sph))}${cell(eye, "cyl", fmtPower(e.cyl))}${cell(eye, "axis", fmtAxis(e.axis))}${cell(eye, "add", fmtPower(e.add))}</tr>`;
  };
  const age = s.ageYears === null ? "—" : `${s.dobEstimated ? "≈" : ""}${String(s.ageYears)} y`;

  const body = `
    <div class="sheet">
      <div class="hd">
        <div class="crest"><img src="${CREST_PNG_DATA_URI}" alt="${HOSPITAL.nameTitleCase}"></div>
        <div>
          <div class="nm">${HOSPITAL.nameTitleCase}</div>
          <div class="ad">${HOSPITAL.address} · ${HOSPITAL.contact}</div>
          <div class="dept">${esc(s.departmentName)}</div>
        </div>
      </div>
      <div class="rule" style="margin-top:10px;flex-shrink:0"></div>
      <h1>Spectacle prescription</h1>
      <div class="id">
        ${idRow("Name:", esc(s.patientName))}
        ${idRow("Visit No:", `<span class="num">${esc(s.visitNo)}</span>`)}
        ${idRow("UHID:", `<span class="num">${esc(s.uhid)}</span>`)}
        ${idRow("Date:", `<span class="num">${esc(formatCalendarDay(s.serviceDate) ?? s.serviceDate)}</span>`)}
        ${idRow("Age / Sex:", `<span class="num">${esc(`${age} / ${genderLetter(s.gender)}`)}</span>`)}
      </div>
      <table class="rx">
        <thead><tr><th></th><th>SPH</th><th>CYL</th><th>AXIS</th><th>ADD</th></tr></thead>
        <tbody>
          ${eyeRow("od", "OD", "Right eye")}
          ${eyeRow("os", "OS", "Left eye")}
        </tbody>
      </table>
      <div class="more">
        ${idRow("Use:", esc(b.use === null ? "—" : USE_LABEL[b.use] ?? b.use))}
        ${b.note === "" ? "" : idRow("Note:", esc(b.note))}
      </div>
      <div class="sp"></div>
      <div class="sig">
        <div class="b">
          <div class="thin"></div>
          <div class="c">Doctor ID <span class="num">${esc(s.doctorCode ?? "—")}</span> · Signature of the prescribing ophthalmologist</div>
        </div>
      </div>
      <div class="ft">
        <div class="rule"></div>
        <div class="dis">Powers in dioptres. Printed from the visit record; valid with the prescriber's signature.</div>
      </div>
    </div>
  `;
  return {
    title: `Spectacle prescription — ${s.patientName} (${s.visitNo})`,
    // A4 is a SHEET: its height is stated, not measured — the prescription sheet's reasoning.
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Spectacle prescription</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}

/**
 * Registers the renderer with the kernel's dispatcher. `OpdModule.onModuleInit` is the production
 * path; exported so a suite can register it without booting Nest (`registerPharmacyPrinting`'s
 * reasoning). Keyed, so a second init replaces. Returns the unregister.
 */
export function registerOpdGlassesPrinting(): () => void {
  return registerDocumentRenderer("opd_glasses_rx", renderGlassesRx);
}
