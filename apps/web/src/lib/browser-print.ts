import { api } from "./api";
import { fetchPrintDocument, reprintJob } from "./print-api";
import type { WirePrintJob, WireRenderedDocument } from "./print-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * BROWSER PRINTING — THE COUNTER'S OWN PRINTER, WHILE NO RELAY SERVES IT (owner, 2026-10-07)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, at the front desk on production: after "hand over" nothing printed — *"I have to click on
 * 'print the paper again' and then from the popup, I have to click on 'save as pdf' and then print
 * from the next dialog screen."* And: *"Right now I have printer attached with each computer at
 * front desk… Right now no thermal printer and so I am not printing token. Right now I am working
 * using only the prescription slip."*
 *
 * Decision 0002 made printing server-side through a relay inside the hospital, and no relay has
 * been installed, so every job sat `queued`. Decision 0043 keeps the relay as the design and makes
 * the browser the sanctioned fallback for a counter no relay serves: the SAME server-rendered
 * document (`GET /print/jobs/:id/document`), printed from a hidden frame of this page — no pop-up,
 * no save-as-PDF step — and the job is then told it reached paper here, so a relay installed later
 * does not print a week of stale sheets.
 *
 * ═══ PER COMPUTER, NOT PER PERSON ═══
 *
 * A printer is attached to a machine. So the choice lives in this browser's `localStorage`, not on
 * the user: the same clerk at another counter gets that counter's answer.
 */

export type PrintMode = "auto" | "relay" | "browser";
export type PrintSetting = {
  mode: PrintMode;
  /** Which papers this computer prints at hand-over. A document absent here is not printed. */
  papers: Record<string, boolean>;
};

/** The owner has no thermal printer: the sheet prints, the token slip does not, until told otherwise. */
export const DEFAULT_PRINT_SETTING: PrintSetting = {
  mode: "auto",
  papers: { opd_prescription: true, opd_token_slip: false, opd_payment_receipt: false },
};

/** The papers a counter can choose, in the order they come off the printer. */
export const HANDOVER_PAPERS = ["opd_prescription", "opd_token_slip", "opd_payment_receipt"] as const;

const KEY = "hmis.print.thisComputer.v1";
const listeners = new Set<() => void>();

export function readPrintSetting(): PrintSetting {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_PRINT_SETTING;
    const j = JSON.parse(raw) as Partial<PrintSetting>;
    const mode: PrintMode = j.mode === "relay" || j.mode === "browser" ? j.mode : "auto";
    return { mode, papers: { ...DEFAULT_PRINT_SETTING.papers, ...(typeof j.papers === "object" && j.papers !== null ? j.papers : {}) } };
  } catch {
    return DEFAULT_PRINT_SETTING; // a private window or blocked storage: the default still prints
  }
}

export function writePrintSetting(next: PrintSetting): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* kept for this page only */ }
  cached = next;
  for (const l of listeners) l();
}

let cached: PrintSetting | null = null;
/** For `useSyncExternalStore`: one object until it changes. */
export function printSettingSnapshot(): PrintSetting {
  if (cached === null) cached = readPrintSetting();
  return cached;
}
export function subscribePrintSetting(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
/** Tests only: forget what was read, so each test starts from storage. */
export function forgetPrintSetting(): void { cached = null; }

/**
 * Does THIS computer print the paper itself?
 *
 * `auto` — a browser nobody has told — decides from what the server knows: has a relay claimed
 * anything for this printer lately (`served`, `kernel/printing/served.ts`)? If nobody is there, the
 * browser prints; the day a relay starts claiming, an untouched counter goes quiet by itself.
 */
export function printsHere(setting: PrintSetting, jobs: readonly Pick<WirePrintJob, "served">[]): boolean {
  if (setting.mode === "browser") return true;
  if (setting.mode === "relay") return false;
  return jobs.length > 0 && jobs.every((j) => j.served === false); // an older server says nothing: stay on the relay road
}

/** The newest job of each document — a reprint is a new row, and the clerk wants "the sheet", once. */
export function latestPerDocument<T extends Pick<WirePrintJob, "document" | "createdAt">>(jobs: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const j of jobs) {
    const held = latest.get(j.document);
    if (held === undefined || j.createdAt > held.createdAt) latest.set(j.document, j);
  }
  return [...latest.values()];
}

/** What hand-over still owes the patient on this computer: chosen papers nobody has printed yet. */
export function owedHere(setting: PrintSetting, jobs: readonly WirePrintJob[]): WirePrintJob[] {
  const order = new Map<string, number>(HANDOVER_PAPERS.map((d, i) => [d, i]));
  return latestPerDocument(jobs)
    .filter((j) => setting.papers[j.document] === true && (j.status === "queued" || j.status === "failed"))
    .sort((a, b) => (order.get(a.document) ?? 99) - (order.get(b.document) ?? 99));
}

/** Tell the server this job reached paper on this counter's own printer. */
export function markPrintedHere(jobId: string): Promise<{ accepted: boolean }> {
  return api("POST", `/print/jobs/${encodeURIComponent(jobId)}/printed-here`);
}

export type FramePrint = "printed" | "no_dialog" | "refused";

/**
 * Print one whole server document from a hidden frame of this page and wait for the dialog to close.
 *
 * The document is written as-is: its own `@page` (A4 for the sheet, 72 mm for a slip), its own
 * fonts, none of this app's stylesheet — the bytes the relay would have printed.
 *
 * `afterprint` fires when the dialog closes, whether the person printed or cancelled; no browser
 * says which. So `printed` here means "the print dialog was raised and closed" (or, under Chrome's
 * `--kiosk-printing`, that the job went straight to the default printer). `no_dialog` means the
 * browser never reported it within `waitMs` — the screen then says "not printed yet" instead of
 * guessing.
 */
export function printDocumentHere(doc: WireRenderedDocument, waitMs = 120_000): Promise<FramePrint> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-testid", "print-frame");
    frame.setAttribute("title", doc.title);
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    document.body.appendChild(frame);
    const w = frame.contentWindow;
    if (w === null) { frame.remove(); resolve("refused"); return; }
    let settled = false;
    const finish = (r: FramePrint): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // Removed a moment later: Firefox cancels a print whose frame disappears under it.
      window.setTimeout(() => frame.remove(), 1000);
      resolve(r);
    };
    const timer = window.setTimeout(() => finish("no_dialog"), waitMs);
    w.document.open();
    w.document.write(doc.html);
    w.document.close();
    const go = (): void => {
      try {
        w.addEventListener("afterprint", () => finish("printed"), { once: true });
        w.focus();
        w.print();
      } catch {
        finish("refused");
      }
    };
    /* `load` before `print()`: the sheet carries a letterhead, and a half-laid-out page reaching paper is the failure. */
    if (w.document.readyState === "complete") window.setTimeout(go, 50);
    else w.addEventListener("load", go, { once: true });
  });
}

export type HerePrintResult = { document: string; jobId: string; outcome: FramePrint | "gone" | "error" };

/**
 * Print these jobs on this computer, one after another, and tell the server about each that went.
 *
 * ONE AFTER ANOTHER, not one merged page: a sheet is A4 and a slip is a 72 mm roll, and CSS `@page`
 * is per document. With the owner's setting (the sheet only) that is one dialog. A counter that
 * turns the slip on as well gets a second dialog, and the panel says so.
 */
export async function printJobsHere(jobs: readonly Pick<WirePrintJob, "id" | "document">[]): Promise<HerePrintResult[]> {
  const out: HerePrintResult[] = [];
  for (const j of jobs) {
    try {
      const doc = await fetchPrintDocument(j.id);
      if (doc === null) { out.push({ document: j.document, jobId: j.id, outcome: "gone" }); continue; }
      const outcome = await printDocumentHere(doc);
      if (outcome === "printed") await markPrintedHere(j.id).catch(() => undefined);
      out.push({ document: j.document, jobId: j.id, outcome });
    } catch {
      out.push({ document: j.document, jobId: j.id, outcome: "error" });
    }
  }
  return out;
}

/**
 * "Print again" on this computer: a NEW job (the reprint's audit row and reason survive exactly as
 * for a relay), printed here at once and marked — never left `queued` for a relay that is not there.
 */
export async function reprintHere(job: Pick<WirePrintJob, "id" | "document">): Promise<HerePrintResult> {
  const again = await reprintJob(job.id);
  if (again.id === null) return { document: job.document, jobId: job.id, outcome: "gone" };
  const [r] = await printJobsHere([{ id: again.id, document: job.document }]);
  return r!;
}

/** One guard per visit and paper, so a re-render, a poll or a second look at the done screen prints nothing twice. */
const autoPrinted = new Set<string>();
export function claimAutoPrint(jobId: string): boolean {
  if (autoPrinted.has(jobId)) return false;
  autoPrinted.add(jobId);
  return true;
}
export function forgetAutoPrints(): void { autoPrinted.clear(); }

/** The test page: proves the printer and the margins without a patient on it. */
export function testPrintDocument(title: string, lines: readonly string[]): WireRenderedDocument {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return {
    title,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4;margin:14mm}body{font-family:system-ui,"Noto Sans","Noto Sans Devanagari",sans-serif;font-size:13pt;color:#000}h1{font-size:18pt;margin:0 0 6mm}p{margin:0 0 3mm}.box{border:1px solid #000;padding:6mm;margin-top:8mm}</style></head><body><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<div class="box">A4 · 210 × 297 mm</div></body></html>`,
  };
}
