import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { agents } from "../../kernel/db/schema/auth";
import { printJobs } from "../../kernel/db/schema/printing";
import { rosterBoardPrints } from "../../kernel/db/schema/roster";
import { CREST_PNG_DATA_URI } from "../../kernel/printing/crest";
import { DESTINATION_OF, enqueuePrintJob } from "../../kernel/printing/enqueue";
import { HOSPITAL, esc, registerDocumentRenderer } from "../../kernel/printing/render";
import { onNowBoard } from "./board";
import { addIstDays, istDateOfInstant, istMidnightUtc } from "./calendar";
import type { Db, Tx } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";
import type { RosterBoardPrintOutcome } from "../../kernel/db/schema/roster";
import type { BoardDepartment, OnNowBoard } from "./board";

/**
 * ═══ 20-U infra (owner 2026-10-04) — THE BOARD PRINTS ITSELF AT 20:00 AND 08:00 IST ═══
 *
 * Board "When the screens are dark" (`OnNow.dc.html`, plan D5): *"This board prints itself … at
 * 20:00 and 08:00, with phone numbers. Power cut, network down, server down — the paper on the wall
 * is never more than twelve hours old."* Printing is SERVER-SIDE (owner ruling 2026-09-04): the
 * server draws the sheet and puts a job on the house print rail; the site's relay turns it into paper.
 *
 * ═══ WHAT IS RECORDED, AND WHAT THE CARD MAY THEREFORE SAY ═══
 *
 * Every print instant is one `roster_board_prints` row holding the sheet exactly as drawn. When a
 * relay is GRANTED the board's destination (`duty_board_a4`) the row names the print job(s) queued,
 * and "N copies" is read off those jobs' own `printed` status — never off the number queued. When no
 * relay is granted it, nothing is queued (a job nobody can claim would sit and print a stale rota the
 * day a relay appears) and the row says `no_printer`; the card then says the sheet was GENERATED and
 * offers it for download. Per-ward destinations need printer master data that does not exist: today
 * it is one destination, and `destinations` is an array so the day it is several needs no migration.
 *
 * ═══ STALENESS IS REFUSED AT THE PRINTER, TOO ═══
 *
 * A board job claimed more than twelve hours after its instant renders nothing, which the relay
 * reports failed (advisory, R7). The paper on the wall must never be OLDER than the board promises.
 *
 * Phones: D6 exactly as the screen — a number only for a person IN THE BUILDING at the instant.
 */

export const BOARD_PRINT_SLOTS_IST: readonly string[] = ["08:00", "20:00"];
/** A worker down at 20:00 that comes back at 21:30 still prints the 20:00 sheet; at 22:01 it does not. */
export const BOARD_PRINT_CATCH_UP_MS = 2 * 3_600_000;
/** The board's own promise: the paper is never more than twelve hours old. */
export const BOARD_PRINT_STALE_MS = 12 * 3_600_000;
export const BOARD_PRINT_DESTINATION = DESTINATION_OF.roster_board;
const BOARD_PRINT_BY = "roster-board-print";
const BOARD_PRINT_LOCK = "roster.board_print";
/** A4 landscape, stated: the sheet's size is known, so the relay measures nothing. */
const A4_LANDSCAPE = { widthMm: 297, heightMm: 210 } as const;

/** The database's clock, as every other stamp in this module (V6). */
async function dbNow(exec: Db | Tx): Promise<Date> {
  const raw = ((await (exec as Db).execute(sql`select now() as "now"`)).rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The latest scheduled print instant at or before `now` (yesterday's 20:00 at 03:00 IST). */
export function boardSlotAtOrBefore(now: Date): Date {
  const today = istDateOfInstant(now);
  const slots = [addIstDays(today, -1), today].flatMap((d) => BOARD_PRINT_SLOTS_IST
    .map((hm) => new Date(istMidnightUtc(d).getTime() + minutesOf(hm) * 60_000)));
  return slots.filter((s) => s.getTime() <= now.getTime()).sort((a, b) => b.getTime() - a.getTime())[0]!;
}

/** The next scheduled instant strictly after `now` — what the card names before the first print. */
export function nextBoardSlot(now: Date): Date {
  const today = istDateOfInstant(now);
  return [today, addIstDays(today, 1)].flatMap((d) => BOARD_PRINT_SLOTS_IST
    .map((hm) => new Date(istMidnightUtc(d).getTime() + minutesOf(hm) * 60_000)))
    .filter((s) => s.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime())[0]!;
}

/** Is any live relay (kill switch off) granted the board's destination? Asked, not assumed. */
export async function boardPrinterGranted(exec: Db | Tx): Promise<boolean> {
  const rows = await (exec as Db).select({ id: agents.id }).from(agents).where(and(
    eq(agents.killSwitch, false),
    sql`${agents.printDestinations} @> array[${BOARD_PRINT_DESTINATION}]::text[]`,
  )).limit(1);
  return rows.length > 0;
}

/* ═══════════════════════════════ the sheet ═══════════════════════════════ */

const IST_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** `Sun 04-Oct-2026` — the house paper's DD-Mon-YYYY, with the weekday a night nurse reads first. */
function istDay(at: Date): string {
  const p = Object.fromEntries(IST_DAY.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day}-${p.month}-${p.year}`;
}
const istTime = (at: Date): string => IST_TIME.format(at);

const GRADE: Record<string, string> = { intern: "Int", junior_resident: "JR", senior_resident: "SR" };

/** The unit's own name without the department's ("Medicine Unit II" → "Unit II"), as the screen does. */
function shortUnit(unit: string, dept: string): string {
  return unit.startsWith(`${dept} `) ? unit.slice(dept.length + 1) : unit;
}

function backupLine(d: BoardDepartment, b: OnNowBoard): string {
  if (d.backupUnit !== null) return `${esc(shortUnit(d.backupUnit.name, d.name))} is the backup unit`;
  if (d.units === 1) {
    const med = b.departments.find((x) => x.code === "MED" && x.departmentId !== d.departmentId && x.unitOnTake !== null);
    return med !== undefined ? `${esc(med.name)}'s unit on take covers` : "No second unit — the duty manager decides";
  }
  return "No backup unit is named";
}

const CSS = `
  @page { size: A4 landscape; margin: 8mm 9mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5px; line-height: 13.5px; color: #000;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .hi { font-family: "Noto Sans Devanagari", "Nirmala UI", Mangal, sans-serif; }
  .num { font-variant-numeric: tabular-nums; }
  .hd { display: flex; align-items: center; gap: 14px; padding-bottom: 6px; border-bottom: 1.5px solid #000; }
  .hd img { width: 52px; height: auto; display: block; }
  .hd .who { flex-grow: 1; }
  .hd .nm { font-size: 15px; font-weight: 700; line-height: 18px; }
  .hd .ad { font-size: 10px; color: #333; }
  .hd .t { text-align: right; }
  .hd .t .big { font-size: 18px; font-weight: 800; letter-spacing: .02em; line-height: 22px; }
  .hd .t .at { font-size: 12.5px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 7px; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: #333; border-bottom: 1px solid #000; padding: 3px 5px; }
  td { vertical-align: top; padding: 3px 5px; border-bottom: 1px solid #c8c8c8; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td.d { font-weight: 700; width: 17%; }
  td.u { width: 15%; }
  td.b { width: 33%; }
  td.f { width: 17%; }
  .p { white-space: nowrap; }
  .p .g { display: inline-block; min-width: 20px; font-weight: 700; }
  .p .ph { font-weight: 700; }
  .none { color: #555; font-style: italic; }
  .sk { font-size: 9px; font-weight: 700; border: 1px solid #000; padding: 0 3px; margin-left: 4px; }
  .sv { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 7px; padding-top: 5px; border-top: 1px solid #000; }
  .holes { margin-top: 6px; }
  .holes .h { font-weight: 700; }
  .ft { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; padding-top: 4px; border-top: 1px solid #9a9a9a; font-size: 9.5px; color: #333; }
`;

/**
 * Draws the board AS AT `at` — the same `onNowBoard` the screen reads, so the paper and the screen
 * cannot disagree about who was on. `renderedAt` is the instant the sheet says it was printed.
 */
export async function renderBoardSheet(
  exec: Db | Tx, at: Date, renderedAt: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<RenderedDocument> {
  const b = await onNowBoard(exec, at, env);
  const noCycle = (id: string): boolean => b.holes.some((h) => h.kind === "no_take_cycle" && h.departmentId === id);

  const rows = b.departments.map((d) => {
    const unit = d.unitOnTake === null
      ? `<span class="none">${noCycle(d.departmentId) ? "No take cycle" : "No unit on take"}</span>`
      : `${esc(shortUnit(d.unitOnTake.name, d.name))} <span class="num">till ${esc(istTime(d.unitOnTake.endsAt))}</span>`;
    const building = d.source !== "published"
      ? `<span class="none">No published roster</span>`
      : d.inTheBuilding.length === 0
        ? `<span class="none">Nobody rostered in the building</span>`
        : d.inTheBuilding.map((p) => `<div class="p"><span class="g">${esc(GRADE[p.cadre] ?? p.positionLabel)}</span> ${esc(p.name)}`
          + `${p.phone !== null && p.phone !== "" ? ` · <span class="ph num">${esc(p.phone)}</span>` : ""}</div>`).join("");
    const faculty = d.source !== "published" ? "" : d.facultyOnCall.map((r) => esc(r.name ?? "Vacant")).join(", ");
    return `<tr><td class="d">${esc(d.name)}${d.skeleton ? '<span class="sk">SKELETON</span>' : ""}</td><td class="u">${unit}</td>`
      + `<td class="b">${building}</td><td class="f">${faculty}</td><td>${d.source !== "published" ? "" : backupLine(d, b)}</td></tr>`;
  }).join("");

  const services = b.services.map((s) => `<span><strong>${esc(s.positionLabel)}:</strong> ${s.source !== "published"
    ? '<span class="none">no published roster</span>'
    : s.people.length === 0 ? '<span class="none">nobody on</span>' : esc(s.people.map((p) => p.name).join(", "))}</span>`).join("");

  const holes = b.holes.filter((h) => h.kind !== "no_take_cycle").slice(0, 8);
  const holeLines = holes.length === 0 ? "" : `<div class="holes"><span class="h">Holes in the next 24 hours:</span> ${holes.map((h) =>
    `${esc(h.departmentName)} — ${esc(h.positionLabel ?? h.kind.replace(/_/g, " "))}${h.name === null ? "" : ` (${esc(h.name)})`} from <span class="num">${esc(istTime(h.from))}</span>`).join(" · ")}`
    + `${b.holes.filter((h) => h.kind !== "no_take_cycle").length > holes.length ? " · and more on the screen" : ""}</div>`;

  const next = nextBoardSlot(at);
  const title = `Who is on duty — ${istDay(at)} ${istTime(at)} IST`;
  const body = `
    <div class="hd">
      <img src="${CREST_PNG_DATA_URI}" alt="${HOSPITAL.nameTitleCase}">
      <div class="who"><div class="nm">${HOSPITAL.name}</div><div class="ad">${HOSPITAL.address} · ${HOSPITAL.contact}</div></div>
      <div class="t"><div class="big">WHO IS ON DUTY <span class="hi">· ड्यूटी पर कौन</span></div>
        <div class="at num">as at ${esc(istTime(at))} IST · ${esc(istDay(at))}</div></div>
    </div>
    ${b.resolverEnabled ? "" : '<div class="holes"><span class="h">Rosters are not yet live in this hospital</span> — no names are drawn from them; ask the duty manager.</div>'}
    <table>
      <thead><tr><th>Department</th><th>Unit on take</th><th>In the building · phone</th><th>Faculty on call</th><th>If it overflows</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="sv">${services}</div>
    ${holeLines}
    <div class="ft">
      <span class="num">Printed ${esc(istDay(renderedAt))} ${esc(istTime(renderedAt))} IST by the HMIS · replaced at ${esc(istTime(next))} · phone numbers only for those in the building now</span>
      <span>If this sheet and the screen differ, the screen is right.</span>
    </div>`;
  return {
    title,
    page: { ...A4_LANDSCAPE },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`,
  };
}

/* ═══════════════════════════════ the scheduled print ═══════════════════════════════ */

export interface BoardPrintResult { printId: string; slotAt: Date; outcome: RosterBoardPrintOutcome; printJobIds: string[] }

/**
 * The worker's job, every minute: if a print instant has passed within the catch-up window and has
 * no row yet, draw the sheet, queue it when a relay is granted the destination, and record what was
 * done. Serialised by an advisory lock and keyed by the instant, so a double tick writes ONE row.
 */
export async function printBoardIfDue(
  db: Db, now: Date, env: NodeJS.ProcessEnv = process.env,
): Promise<BoardPrintResult | null> {
  const slotAt = boardSlotAtOrBefore(now);
  if (now.getTime() - slotAt.getTime() > BOARD_PRINT_CATCH_UP_MS) return null;
  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${BOARD_PRINT_LOCK}))`);
    const done = await (tx as unknown as Db).select({ id: rosterBoardPrints.id }).from(rosterBoardPrints).where(eq(rosterBoardPrints.slotAt, slotAt));
    if (done.length > 0) return null;

    // The sheet's "Printed" and the row's stamp are the DATABASE's clock (V6); `now` only chose the instant.
    const renderedAt = await dbNow(tx);
    const doc = await renderBoardSheet(tx, slotAt, renderedAt, env);
    const printId = newId();
    const printJobIds: string[] = [];
    if (await boardPrinterGranted(tx)) {
      const jobId = await enqueuePrintJob(tx, {
        document: "roster_board", params: { printId }, dedupeKey: `roster-board:${slotAt.toISOString()}`, requestedBy: null,
      });
      if (jobId !== null) printJobIds.push(jobId);
    }
    const outcome: RosterBoardPrintOutcome = printJobIds.length > 0 ? "queued" : "no_printer";
    await tx.insert(rosterBoardPrints).values({
      id: printId, slotAt, renderedAt, title: doc.title, html: doc.html, outcome,
      destinations: printJobIds.length > 0 ? [BOARD_PRINT_DESTINATION] : [], printJobIds,
      createdBy: BOARD_PRINT_BY, updatedBy: BOARD_PRINT_BY,
    });
    return { printId, slotAt, outcome, printJobIds };
  });
}

/**
 * The relay's claim renders through here: the STORED sheet, never a fresh one — the paper is what
 * was true at its instant. Null (reported failed, advisory) for an unknown row or a stale one.
 */
export async function renderBoardPrintJob(db: Db, params: Record<string, unknown>, now: Date): Promise<RenderedDocument | null> {
  const id = typeof params.printId === "string" ? params.printId : null;
  if (id === null) return null;
  const row = (await db.select().from(rosterBoardPrints).where(eq(rosterBoardPrints.id, id)))[0];
  if (row === undefined) return null;
  if (now.getTime() - row.slotAt.getTime() > BOARD_PRINT_STALE_MS) return null;
  return { title: row.title, html: row.html, page: { ...A4_LANDSCAPE } };
}

/** Registered from the roster module's `onModuleInit` (the pharmacy precedent). Returns the unregister. */
export function registerRosterPrinting(): () => void {
  return registerDocumentRenderer("roster_board", (db, params, now) => renderBoardPrintJob(db, params, now));
}

/* ═══════════════════════════════ what the card reads ═══════════════════════════════ */

export interface BoardPrintView {
  printId: string;
  slotAt: Date;
  renderedAt: Date;
  outcome: RosterBoardPrintOutcome;
  destinations: string[];
  /** Read off the print jobs' own status; `printed` is paper a relay SAID came out. */
  copies: { queued: number; printed: number; waiting: number; failed: number };
  lastPrintedAt: Date | null;
  /** The next scheduled instant after now. */
  nextAt: Date;
}

export async function lastBoardPrint(exec: Db | Tx, now: Date = new Date()): Promise<BoardPrintView | null> {
  const row = (await (exec as Db).select({
    id: rosterBoardPrints.id, slotAt: rosterBoardPrints.slotAt, renderedAt: rosterBoardPrints.renderedAt,
    outcome: rosterBoardPrints.outcome, destinations: rosterBoardPrints.destinations, printJobIds: rosterBoardPrints.printJobIds,
  }).from(rosterBoardPrints).orderBy(desc(rosterBoardPrints.slotAt)).limit(1))[0];
  if (row === undefined) return null;
  const jobs = row.printJobIds.length === 0 ? [] : await (exec as Db)
    .select({ status: printJobs.status, printedAt: printJobs.printedAt }).from(printJobs).where(inArray(printJobs.id, row.printJobIds));
  const printed = jobs.filter((j) => j.status === "printed");
  const stamps = printed.flatMap((j) => (j.printedAt === null ? [] : [j.printedAt.getTime()]));
  return {
    printId: row.id, slotAt: row.slotAt, renderedAt: row.renderedAt,
    outcome: row.outcome as RosterBoardPrintOutcome, destinations: row.destinations,
    copies: {
      queued: row.printJobIds.length,
      printed: printed.length,
      waiting: jobs.filter((j) => j.status === "queued" || j.status === "claimed").length,
      failed: jobs.filter((j) => j.status === "failed" || j.status === "cancelled").length,
    },
    lastPrintedAt: stamps.length === 0 ? null : new Date(Math.max(...stamps)),
    nextAt: nextBoardSlot(now),
  };
}

/** One recorded sheet, for download (the browser's Save as PDF). Null for an unknown id. */
export async function boardPrintDocument(exec: Db | Tx, printId: string): Promise<RenderedDocument | null> {
  const row = (await (exec as Db).select().from(rosterBoardPrints).where(eq(rosterBoardPrints.id, printId)))[0];
  return row === undefined ? null : { title: row.title, html: row.html, page: { ...A4_LANDSCAPE } };
}
