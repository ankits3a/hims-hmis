import { withTx } from "../../kernel/db/client";
import { CREST_PNG_DATA_URI } from "../../kernel/printing/crest";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { relayServes } from "../../kernel/printing/served";
import { qrSvg } from "../../kernel/printing/qr";
import { HOSPITAL, esc, registerDocumentRenderer } from "../../kernel/printing/document-kit";
import { RosterError } from "./errors";
import { dutyEvidence } from "./evidence";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/document-kit";
import type { DutyEvidence, EvidenceDay } from "./evidence";

/**
 * ═══ 20-U U8 — THE DUTY-EVIDENCE SHEET, ON PAPER ═══
 *
 * A4 portrait on the hospital's letterhead, with a QR that carries the sheet's reference. Printing is
 * SERVER-SIDE (owner ruling 2026-09-04): the screen asks, ONE job is queued to the office's A4 laser,
 * and the relay's claim renders it from here. The screen's preview is THIS function's HTML, so what
 * the head of department reads before pressing Print is what comes off the printer.
 *
 * ═══ A JOB CARRIES IDENTIFIERS, AND THE CLAIM RE-ASKS ═══
 *
 * `params` holds the people, the days and the requester's id — no name, no duty. At claim time the
 * renderer calls `dutyEvidence` AS THE REQUESTER, so the act is asked again: a head of department
 * whose publish grant was withdrawn between the click and the claim prints nothing (the job is
 * reported failed — advisory, R7) rather than a sheet they may no longer certify.
 *
 * ═══ THE WORDS ═══
 *
 * Every sentence on the sheet states what a record holds — "rostered", "wheeled in", "approved leave
 * or deputation on record", "no other record held". None says what the facts MEAN. `evidence.test.ts`
 * reads the rendered sheet for the words that would.
 */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const IST_STAMP = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** `2026-10-04` → `Sun 04 Oct 2026` — spelled here, not by `Intl` (whose en-GB writes "Sept"). A calendar day, so no zone arithmetic. */
const dayText = (istDate: string): string =>
  `${WEEKDAY[new Date(`${istDate}T12:00:00Z`).getUTCDay()]!} ${istDate.slice(8, 10)} ${MONTH[Number(istDate.slice(5, 7)) - 1]!} ${istDate.slice(0, 4)}`;
/** `2026-10-04` → `04-10-2026`, the form the owner asked for (2026-10-03). */
const ddmmyyyy = (istDate: string): string => `${istDate.slice(8, 10)}-${istDate.slice(5, 7)}-${istDate.slice(0, 4)}`;
const hhmm = (at: Date): string => IST_TIME.format(at);

const GRADE: Record<string, string> = {
  professor: "Professor", associate_professor: "Associate Professor", assistant_professor: "Assistant Professor",
  senior_resident: "Senior Resident", jr1: "Junior Resident (1st year)", jr2: "Junior Resident (2nd year)",
  jr3: "Junior Resident (3rd year)", intern: "Intern", medical_officer: "Medical Officer",
  nursing_superintendent: "Nursing Superintendent", ward_sister: "Ward Sister", staff_nurse: "Staff Nurse",
  technician: "Technician", pharmacist: "Pharmacist", admin: "Administration", support: "Support staff",
};

const HOLIDAY: Record<string, string> = {
  gazetted: "gazetted holiday", restricted: "restricted holiday", declared: "holiday declared by the medical superintendent", local: "local holiday",
};

/** What the roster said, as one cell. */
export function rosteredText(d: EvidenceDay): string {
  if (d.rostered.length === 0) return "No duty rostered";
  return d.rostered.map((r) => (r.off
    ? "Rostered off"
    : `${r.positionLabel}${r.teamName === null ? "" : ` · ${r.teamName}`} · ${hhmm(r.startsAt)}\u2060–\u2060${hhmm(r.endsAt)}${r.mode === "call" ? " (on call)" : ""}`)).join("; ");
}

/** What the records hold, as lines. Never a conclusion; "no other record held" when there is none. */
export function recordLines(d: EvidenceDay): string[] {
  const lines: string[] = [];
  for (const t of d.theatre) {
    lines.push(`${t.theatreName} · ${t.role}: wheeled in ${hhmm(t.wheelIn)}${t.wheelOut === null ? ", no wheel-out recorded" : `, wheeled out ${hhmm(t.wheelOut)}`}`);
  }
  if (d.approvedLeave) lines.push("Approved leave or deputation on record");
  if (d.holiday !== null) lines.push(`Hospital ${HOLIDAY[d.holiday] ?? "holiday"}`);
  if (lines.length === 0) lines.push("No other record held for this day");
  return lines;
}

const CSS = `
  @page { size: A4 portrait; margin: 12mm 12mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 11.5px; line-height: 15px; color: #000;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .num { font-variant-numeric: tabular-nums; }
  .hd { display: flex; gap: 16px; align-items: flex-start; }
  .hd .crest img { width: 64px; height: auto; display: block; }
  .hd .nm { font-size: 16px; font-weight: 700; line-height: 21px; }
  .hd .ad { font-size: 10.5px; color: #333; margin-top: 2px; }
  .hd .grow { flex-grow: 1; }
  .hd .qr { text-align: center; font-size: 9px; color: #333; }
  .hd .qr svg { display: block; }
  .rule { height: 1px; background: #000; margin: 8px 0 0; }
  h1 { font-size: 15px; letter-spacing: .06em; text-transform: uppercase; margin: 10px 0 2px; }
  .sub { font-size: 11px; color: #333; margin-bottom: 8px; }
  .person { margin-top: 12px; }
  .person + .person { break-before: page; page-break-before: always; }
  .who { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 20px; margin-bottom: 6px; }
  .who .lb { color: #333; }
  .who .vl { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #777; padding: 4px 6px; vertical-align: top; text-align: left; }
  th { font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; background: #f0f0f0; }
  td.day { width: 18%; white-space: nowrap; }
  td.ros { width: 38%; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .none { color: #555; }
  /* Repeated at the top of every printed page, so a continuation page still names its person. */
  td.cont { border: none; padding: 0 0 4px; font-size: 9.5px; color: #333; }
  .ft, .sig { break-inside: avoid; page-break-inside: avoid; }
  .ft { margin-top: 12px; font-size: 10px; color: #222; border-top: 1px solid #000; padding-top: 6px; }
  .sig { margin-top: 28px; display: flex; justify-content: flex-end; }
  .sig div { width: 280px; border-top: 1px solid #555; padding-top: 3px; font-size: 10px; text-align: right; }
`;

const SOURCE_TEXT: Record<string, string> = {
  roster: "the duty the published roster gave",
  theatre: "theatre wheel-in and wheel-out times where the person is recorded as surgeon or anaesthetist",
  leave: "approved leave or deputation",
  holidays: "declared holidays",
};
/** The records read, as one sentence — so a source that was not read is visibly not on the sheet. */
function sourcesText(sources: readonly string[]): string {
  const parts = ["roster", "theatre", "leave", "holidays"].filter((k) => sources.includes(k)).map((k) => SOURCE_TEXT[k]!);
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
}

/** The sheet's HTML, from the report. Pure: no clock, no database. */
export function renderEvidenceHtml(r: DutyEvidence): RenderedDocument {
  const qrPayload = `CRKMCH HMIS duty evidence ${r.ref} ${r.from}..${r.to}`;
  const range = r.from === r.to ? ddmmyyyy(r.from) : `${ddmmyyyy(r.from)} to ${ddmmyyyy(r.to)}`;
  const people = r.people.map((p) => {
    const who = (label: string, value: string): string => `<div><span class="lb">${esc(label)}</span> <span class="vl">${value}</span></div>`;
    const rows = p.days.map((d) => {
      const lines = recordLines(d);
      const none = lines.length === 1 && lines[0]!.startsWith("No other record");
      return `<tr data-day="${esc(d.istDate)}"><td class="day num">${esc(dayText(d.istDate))}</td>`
        + `<td class="ros${d.rostered.length === 0 ? " none" : ""}">${esc(rosteredText(d))}</td>`
        + `<td class="${none ? "none" : ""}">${lines.map((l) => esc(l)).join("<br>")}</td></tr>`;
    }).join("");
    return `<section class="person" data-person="${esc(p.userId)}">
      <div class="who">
        ${who("Name:", esc(p.name))}
        ${who("Staff code:", `<span class="num">${esc(p.staffCode)}</span>`)}
        ${who("Department:", esc(p.departmentName ?? "—"))}
        ${who("Unit / grade:", esc([p.unitName, p.grade === null ? null : (GRADE[p.grade] ?? p.grade)].filter((x) => x !== null).join(" · ") || "—"))}
      </div>
      <table>
        <thead>
          <tr><td colspan="3" class="cont">${esc(p.name)} · <span class="num">${esc(p.staffCode)}</span> · ${esc(range)} · ref <span class="num">${esc(r.ref)}</span></td></tr>
          <tr><th>Day</th><th>Rostered duty</th><th>What the hospital's records show</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ft">
        This sheet states what the hospital's records hold for each day: ${esc(sourcesText(r.sources))}.
        It draws no conclusion from them. Times are IST. Reference <span class="num">${esc(r.ref)}</span>.
      </div>
      <div class="sig"><div>Signature and seal of the certifying officer</div></div>
    </section>`;
  }).join("");

  const body = `
    <div class="hd">
      <div class="crest"><img src="${CREST_PNG_DATA_URI}" alt="${HOSPITAL.nameTitleCase}"></div>
      <div class="grow">
        <div class="nm">${HOSPITAL.nameTitleCase}</div>
        <div class="ad">${HOSPITAL.address} · ${HOSPITAL.contact}</div>
      </div>
      <div class="qr">${qrSvg(qrPayload, 72)}<span class="num">${esc(r.ref)}</span></div>
    </div>
    <div class="rule"></div>
    <h1>Duty evidence</h1>
    <div class="sub num">${esc(range)} · prepared from HMIS records on ${esc(IST_STAMP.format(r.generatedAt).replace(",", ""))} by ${esc(r.generatedBy)}</div>
    ${people}
  `;
  return {
    title: `Duty evidence ${range}`,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Duty evidence</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}

function askFrom(params: Record<string, unknown>): { userIds: string[]; from: string; to: string } | null {
  const { userIds, from, to } = params;
  if (!Array.isArray(userIds) || !userIds.every((u) => typeof u === "string") || typeof from !== "string" || typeof to !== "string") return null;
  return { userIds: userIds as string[], from, to };
}

/**
 * The renderer, registered for `roster_duty_evidence`. Re-asks the act as the requester (see the
 * header); a refusal or a malformed job renders null, which the relay reports failed.
 */
export async function renderDutyEvidence(
  db: Db, params: Record<string, unknown>, now: Date, requester: Actor | null,
): Promise<RenderedDocument | null> {
  const ask = askFrom(params);
  if (ask === null || requester === null) return null;
  const at = typeof params.at === "string" && !Number.isNaN(Date.parse(params.at)) ? new Date(params.at) : now;
  try {
    return renderEvidenceHtml(await dutyEvidence(db, requester, ask, at));
  } catch (e) {
    if (e instanceof RosterError) return null;
    throw e;
  }
}

/**
 * The producer: `POST /roster/evidence/print`. The report is built FIRST, as the actor, so a refusal
 * is the screen's answer now rather than a failed job later. The dedupe key is the sheet's reference
 * (requester, people, days, the IST day it was asked): pressing twice queues one sheet.
 *
 * `served` — whether any relay has claimed for the office's A4 recently. A queued job no relay serves
 * is paper that will not come, and the screen says so instead of letting a person wait at a printer.
 */
export async function printDutyEvidence(
  db: Db, actor: Actor, ask: { userIds: string[]; from: string; to: string }, now: Date,
): Promise<{ queued: boolean; ref: string; served: boolean }> {
  const report = await dutyEvidence(db, actor, ask, now);
  const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
    document: "roster_duty_evidence",
    params: { userIds: [...new Set(ask.userIds)], from: ask.from, to: ask.to, at: now.toISOString() },
    dedupeKey: `evidence:${report.ref}`,
    requestedBy: actor.type === "user" ? actor.id : null,
  }));
  return { queued: id !== null, ref: report.ref, served: await relayServes(db, "office_a4", now) };
}

/** Registers the renderer with the kernel's dispatcher (`RosterModule.onModuleInit`). Returns the unregister. */
export function registerRosterEvidencePrinting(): () => void {
  return registerDocumentRenderer("roster_duty_evidence", renderDutyEvidence);
}
