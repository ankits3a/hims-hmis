import { esc } from "../../kernel/printing/render";
import { loadOpdConfig } from "../opd";
import { getAdr } from "./adr";
import { istDateOf } from "./config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";
import type { AdrDetail } from "./adr";

/**
 * ═══ PHARMACY STAGE D1 — THE PvPI SUSPECTED ADVERSE DRUG REACTION REPORTING FORM, FILLED FROM THE ROW ═══
 *
 * A4, printed by the browser (the controlled registers' path: `GET` returns a `RenderedDocument`). The
 * sections and item numbers are the form's own (IPC, PvPI, v1.4): A patient, B the reaction, C the
 * suspected medicines, D the reporter. PvPI has no API; the pharmacist posts, uploads or e-mails this
 * page and records the send as an event.
 *
 * What this paper carries and does not, and why:
 *   - the patient is INITIALS, age, gender and weight — the form asks for no more (and so a sealed patient
 *     needs no redaction beyond the initials, which are left blank for a reader who may not see the name);
 *   - the reporter is the STAFF ID (owner ruling 2026-09-06: hospital paper prints the Doctor/staff ID,
 *     never a clinician's name or council number), with the hospital's address as the professional
 *     address, and a signature line for the pen.
 */
const CSS = `@page{size:210mm 297mm;margin:12mm}body{font-family:"Segoe UI",Arial,"Nirmala UI",sans-serif;font-size:10px;color:#111;margin:0}
header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px}
.nm{font-size:14px;font-weight:700}.ad{font-size:9px}.t{text-align:right}.t h1{margin:0;font-size:14px}.t div{font-size:9px}
h2{font-size:11px;margin:10px 0 4px;background:#eee;padding:3px 4px}table{width:100%;border-collapse:collapse;margin-bottom:6px}
th,td{border:1px solid #999;padding:3px;text-align:left;vertical-align:top}th{background:#f7f7f7;width:28%}.small{font-size:8px;color:#444}
.box{display:inline-block;min-width:10px;border:1px solid #111;padding:0 3px;margin-right:4px}.on{background:#111;color:#fff}
footer{display:flex;justify-content:space-between;margin-top:24px;font-size:10px}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const day = (d: string | null): string => (d === null ? "" : `${d.slice(8, 10)}-${MONTHS[Number(d.slice(5, 7)) - 1] ?? ""}-${d.slice(0, 4)}`);

/** "Asha Devi Kumari" → "A. D. K." — the form's "patient initials". */
export function initialsOf(name: string | null): string {
  if (name === null) return "";
  return name.trim().split(/\s+/).filter((w) => w !== "").map((w) => `${w[0]!.toUpperCase()}.`).join(" ");
}

function ageAt(dob: string | null, on: string): string {
  if (dob === null) return "";
  const [y, m, d] = [Number(on.slice(0, 4)) - Number(dob.slice(0, 4)), Number(on.slice(5, 7)) - Number(dob.slice(5, 7)), Number(on.slice(8, 10)) - Number(dob.slice(8, 10))];
  const years = y - (m < 0 || (m === 0 && d < 0) ? 1 : 0);
  return `${String(Math.max(0, years))} y`;
}

const SERIOUSNESS: Record<string, string> = {
  death: "Death", life_threatening: "Life threatening", hospitalisation: "Hospitalisation — initial or prolonged", disability: "Disability",
  congenital_anomaly: "Congenital anomaly", other_medically_important: "Other medically important (required intervention)", not_serious: "Not serious",
};
const OUTCOME: Record<string, string> = { recovered: "Recovered", recovering: "Recovering", not_recovered: "Continuing (not recovered)", fatal: "Fatal", unknown: "Unknown" };
const CHALLENGE: Record<string, string> = { yes: "Yes", no: "No", unknown: "Unknown", na: "Not applicable" };
const CHANNEL: Record<string, string> = { amc: "AMC", pvpi_app: "ADR PvPI app", email: "E-mail" };

const ticks = (all: Record<string, string>, on: string): string =>
  Object.entries(all).map(([k, v]) => `<span class="box${k === on ? " on" : ""}">${k === on ? "✓" : "&nbsp;"}</span>${esc(v)}`).join(" &nbsp; ");

export function renderAdrForm(a: AdrDetail, lh: { name: string; legalName?: string; addressLines: string[] }): RenderedDocument {
  const p = a.patient;
  const suspects = a.suspectLines.map((s) => `<tr><td>${String(s.position)}</td><td>${esc(s.name)}</td><td>${esc(s.manufacturer ?? "")}</td><td>${esc(s.batchNo ?? "")}</td>
    <td>${esc(s.dose ?? "")}</td><td>${esc(s.route ?? "")}</td><td>${esc(s.frequency ?? "")}</td><td>${day(s.startDate)}</td><td>${day(s.stopDate)}</td><td>${esc(s.indication ?? "")}</td></tr>`).join("");
  const conc = a.concomitants.length === 0 ? `<tr><td colspan="5">None reported</td></tr>`
    : a.concomitants.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.dose ?? "")}</td><td>${esc(c.route ?? "")}</td><td>${day(c.startDate)} – ${day(c.stopDate)}</td><td>${esc(c.indication ?? "")}</td></tr>`).join("");
  const sent = a.state.sentOn === null ? "" : `<div>Sent ${day(a.state.sentOn)} by ${esc(CHANNEL[a.state.channel ?? ""] ?? a.state.channel ?? "")}${a.state.pvpiRef === null ? "" : ` · ref ${esc(a.state.pvpiRef)}`}</div>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(a.no)}</title><style>${CSS}</style></head><body>
<header><div><div class="nm">${esc(lh.name)}</div><div class="ad">${lh.legalName === undefined ? "" : `A unit of ${esc(lh.legalName)}<br>`}${lh.addressLines.map(esc).join("<br>")}</div></div>
<div class="t"><h1>Suspected Adverse Drug Reaction Reporting Form</h1><div>Pharmacovigilance Programme of India (PvPI) · IPC, Ghaziabad</div>
<div>Hospital ref ${esc(a.no)}${a.state.causality === null ? "" : ` · WHO-UMC: ${esc(a.state.causality)}`}</div>${sent}</div></header>
<h2>A. Patient information</h2>
<table><tbody>
<tr><th>1. Patient initials</th><td>${esc(p === null || p.restricted ? "" : initialsOf(p.name))}</td><th>2. Age at time of event</th><td>${esc(p === null ? "" : ageAt(p.dob, a.onsetDate))}</td></tr>
<tr><th>3. Gender</th><td>${esc(p?.gender ?? "")}</td><th>4. Weight</th><td>${a.weightKg === null ? "" : `${esc(a.weightKg)} kg`}</td></tr>
</tbody></table>
<h2>B. Suspected adverse reaction</h2>
<table><tbody>
<tr><th>5. Date of reaction started</th><td>${day(a.onsetDate)}</td><th>6. Date of recovery</th><td>${day(a.recoveryDate)}</td></tr>
<tr><th>7. Describe reaction or problem</th><td colspan="3">${esc(a.reaction)}</td></tr>
</tbody></table>
<h2>C. Suspected medication(s)</h2>
<table><thead><tr><th style="width:3%">8.</th><th>Name (brand / generic)</th><th>Manufacturer</th><th>Batch / lot</th><th>Dose</th><th>Route</th><th>Frequency</th><th>Started</th><th>Stopped</th><th>Reason for use</th></tr></thead>
<tbody>${suspects}</tbody></table>
<table><tbody>
<tr><th>9. Reaction abated after the drug was stopped or the dose reduced</th><td>${ticks(CHALLENGE, a.dechallenge)}</td></tr>
<tr><th>10. Reaction reappeared after reintroduction</th><td>${ticks(CHALLENGE, a.rechallenge)}</td></tr>
</tbody></table>
<table><thead><tr><th colspan="5">11. Concomitant medical products, including self-medication and herbal remedies (exclude those used to treat the reaction)</th></tr>
<tr><th>Name</th><th>Dose</th><th>Route</th><th>Therapy dates</th><th>Reason for use</th></tr></thead><tbody>${conc}</tbody></table>
<table><tbody>
<tr><th>12. Relevant tests / laboratory data with dates</th><td>${esc(a.relevantTests ?? "")}</td></tr>
<tr><th>13. Relevant medical / medication history</th><td>${esc(a.relevantHistory ?? "")}</td></tr>
<tr><th>14. Seriousness of the reaction</th><td>${ticks(SERIOUSNESS, a.seriousness)}</td></tr>
<tr><th>15. Outcome</th><td>${ticks(OUTCOME, a.outcome)}</td></tr>
</tbody></table>
<h2>D. Reporter details</h2>
<table><tbody>
<tr><th>16. Reporter ID</th><td>${esc(a.reportedByCode)}</td><th>Professional address</th><td>${esc(lh.name)}, ${lh.addressLines.map(esc).join(", ")}</td></tr>
<tr><th>Occupation</th><td></td><th>17. Date of this report</th><td>${day(istDateOf(new Date(a.createdAt)))}</td></tr>
</tbody></table>
<footer><div class="small">Confidential: the patient's identity is held in trust by the programme.</div><div>Signature: ____________________</div></footer>
</body></html>`;
  return { title: `PvPI ADR form — ${a.no}`, page: { widthMm: 210, heightMm: 297 }, html };
}

export async function adrDocument(db: Db, actor: Actor, reportId: string): Promise<RenderedDocument> {
  const a = await getAdr(db, actor, reportId);
  const lh = (await loadOpdConfig(db)).letterhead;
  return renderAdrForm(a, lh);
}
