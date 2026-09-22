import type { PickLine, VerifyLine, WireBatch, WireDispenseLine, WireRxLine } from "../../lib/pharmacy-api";

/**
 * ═══ PD-4 — THE TICK IS THE PICK, AS FAR AS THE SERVER LETS IT BE (PD-D2) ═══
 *
 * The server's order is fixed: `verify` (the check the Act reserves, which also mints the number)
 * and then `pick` (one batch per line, all open lines in one call, a 30-minute reservation). So the
 * tick cannot reserve on its own. What it does instead: each tick SETTLES a line locally, and the
 * tick — or decline — that settles the LAST line fires verify and then pick. There is no verify
 * button, which is PD-D2; a refusal lands on the line it names.
 *
 * Settling is deliberately strict, because it is what triggers a stock write:
 *   · a partial quantity needs its reason BEFORE the tick counts (E9), so typing a reason can never
 *     be the keystroke that reserves stock;
 *   · editing a ticked line unticks it — the pharmacist re-affirms what they changed;
 *   · a line the shelf cannot serve (nothing placed, nothing stocked, nothing sellable) cannot be
 *     ticked at all; it is declined, substituted (PD-5), or — placed by nobody — read as a shelf
 *     medicine by the pharmacist (PD-5b).
 */
/**
 * `sub` is PD-5's generic equivalent, chosen on the sheet with the patient's consent. It is sent to
 * `verify` as `dispensedMedicineId` + `patientConsent`, and while it stands the line is served from
 * the SUBSTITUTE'S stock — the original's empty shelf no longer blocks the tick.
 */
/**
 * `res` is PD-5b's reading of a line the catalogue could not place: the pharmacist chose what the
 * doctor's words are, from this counter's shelf. It is sent as `dispensedMedicineId` WITHOUT consent
 * (nothing the doctor named is replaced), and `verify` judges it as it judges any prescribed line.
 */
export type Tick = {
  ticked: boolean; qty: string; reason: string; batchId: string | null; scan: string;
  sub: { medicineId: string; brandName: string; available: number } | null;
  res: { medicineId: string; brandName: string; available: number; baseUom: string } | null;
};

export function freshTick(line: WireDispenseLine): Tick {
  return { ticked: false, qty: line.qtyBase === null ? "" : String(line.qtyBase), reason: "", batchId: null, scan: "", sub: null, res: null };
}

/**
 * The block that applies to THIS tick: a chosen substitute lifts the shelf's, never the law's or the
 * catalogue's; a chosen reading lifts the catalogue's (the shelf search never offers Schedule X).
 */
export function blockedFor(line: WireDispenseLine, tick: Tick | undefined): Blocked | null {
  const b = blockedOf(line);
  if (b === "unresolved" && tick?.res != null) return null;
  if (tick?.sub == null || b === "unresolved" || b === "schedule_x") return b;
  return null;
}

/** PD-5b — a line nobody could place, still open: the pharmacist may choose what it is. */
export function placeable(line: WireDispenseLine): boolean {
  return line.status === "open" && line.dispensedMedicine === null && line.pickedBatch == null;
}

/**
 * The word the shelf search starts from: the doctor's words without the dosage form and the numbers
 * — "Tab. Zincovit" → "Zincovit", "Tab PCM 500" → "PCM". A start, never a choice.
 */
const FORM_WORD = /^(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syr|syrup|susp|inj|oint|gel|cream|drop|drops)$/i;
export function searchSeed(drug: string): string {
  const word = drug.trim().split(/\s+/).map((w) => w.replace(/[.,:;]+$/, "")).find((w) => w !== "" && !FORM_WORD.test(w) && !/^\d/.test(w));
  return word ?? "";
}

/** A line the sheet may offer an equivalent for: resolved, not marked no-substitution, not yet checked. */
export function substitutable(line: WireDispenseLine): boolean {
  return line.dispensedMedicine !== null && !line.rxLine.noSubstitution && line.scheduleFlag !== "X";
}

/** Why a line cannot be ticked, or null when it can. */
export type Blocked = "unresolved" | "not_stocked" | "not_saleable" | "empty" | "schedule_x";
export function blockedOf(line: WireDispenseLine): Blocked | null {
  /* A collected line holds its own stock — the shelf reading 0 afterwards is the reservation, not a block. */
  if (line.pickedBatch != null) return null;
  if (line.dispensedMedicine === null) return "unresolved";
  if (line.scheduleFlag === "X") return "schedule_x";
  if (line.item === null) return "not_stocked";
  if (!line.saleable) return "not_saleable";
  if ((line.available ?? 0) === 0) return "empty";
  return null;
}

export function qtyOf(tick: Tick): number | null {
  const n = Number(tick.qty.trim());
  return tick.qty.trim() !== "" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The prescribed quantity the check is made against — the server's prefill, or what was typed where there was none. */
export function prescribedOf(line: WireDispenseLine, tick: Tick): number | null {
  return line.qtyBase ?? qtyOf(tick);
}

export function isPartial(line: WireDispenseLine, tick: Tick): boolean {
  const q = qtyOf(tick);
  const p = prescribedOf(line, tick);
  return q !== null && p !== null && q < p;
}

/** A tick is ACCEPTED only when it could be sent: a quantity, no more than prescribed, a reason if short. */
export function canTick(line: WireDispenseLine, tick: Tick): boolean {
  const q = qtyOf(tick);
  const p = prescribedOf(line, tick);
  if (blockedFor(line, tick) !== null || q === null || p === null || q > p) return false;
  return !isPartial(line, tick) || tick.reason.trim() !== "";
}

export function isSettled(line: WireDispenseLine, tick: Tick | undefined): boolean {
  /* The server keeps a picked line `open` until it is billed; a batch on it means it was collected. */
  if (line.status !== "open" || line.pickedBatch != null) return true;
  return tick !== undefined && tick.ticked && canTick(line, tick);
}

export function allSettled(lines: readonly WireDispenseLine[], ticks: Readonly<Record<number, Tick>>): boolean {
  return lines.length > 0 && lines.every((l) => isSettled(l, ticks[l.lineIdx]));
}

/** What `verify` is told: every open line at its PRESCRIBED quantity — the short is the pick's, with its reason. */
export function verifyBody(lines: readonly WireDispenseLine[], ticks: Readonly<Record<number, Tick>>): VerifyLine[] {
  return lines.filter((l) => l.status === "open").map((l) => {
    const t = ticks[l.lineIdx]!;
    return {
      lineIdx: l.lineIdx, qtyBase: prescribedOf(l, t)!,
      ...(t.res !== null && l.dispensedMedicine === null ? { dispensedMedicineId: t.res.medicineId } : {}),
      ...(t.sub === null ? {} : { dispensedMedicineId: t.sub.medicineId, patientConsent: true }),
    };
  });
}

/** What `pick` is told: the quantity given when short (with why), the batch when not FEFO's, and the scan. */
export function pickBody(lines: readonly WireDispenseLine[], ticks: Readonly<Record<number, Tick>>): PickLine[] {
  return lines.filter((l) => l.status === "open").map((l) => {
    const t = ticks[l.lineIdx]!;
    return {
      lineIdx: l.lineIdx,
      ...(isPartial(l, t) ? { qtyBase: qtyOf(t)!, pickNote: t.reason.trim() } : {}),
      ...(t.batchId === null ? {} : { batchId: t.batchId }),
      ...(t.scan.trim() === "" ? {} : { scan: t.scan.trim() }),
    };
  });
}

/**
 * PD-D3 — the Indian sig shorthand, `1-0-1 × 5d`, when the doctor wrote a triplet. Anything else is
 * shown VERBATIM (E19): a weight-based or tapering dose has no honest shorthand, and one that drops
 * the per-kg is worse than none.
 */
export function sigOf(rx: Pick<WireRxLine, "dose" | "frequency" | "durationDays">): string {
  const days = rx.durationDays === null ? "" : ` × ${String(rx.durationDays)}d`;
  const triplet = /^\s*\d+(\.\d+)?\s*-\s*\d+(\.\d+)?\s*-\s*\d+(\.\d+)?\s*$/.test(rx.frequency);
  const unit = /^1\s+(tab|tablet|cap|capsule)s?$/i.test(rx.dose.trim());
  if (triplet) return `${unit ? "" : `${rx.dose.trim()} `}${rx.frequency.replace(/\s+/g, "")}${days}`;
  return [rx.dose.trim(), rx.frequency.trim()].filter((x) => x !== "").join(" · ") + days;
}

/**
 * E8 and the one-batch-per-line rule, said at the TICK. FEFO gives the earliest batch; `pick`
 * refuses when it cannot cover the quantity, and a batch that dies inside the course is a refund
 * waiting to happen. Each advice names the batch that WOULD do, so the pharmacist chooses it here
 * rather than meeting `short_stock` after the strips are pulled.
 */
export type BatchAdvice =
  | { kind: "ok"; batch: WireBatch }
  | { kind: "dies_in_course"; batch: WireBatch; better: WireBatch | null }
  | { kind: "first_short"; batch: WireBatch; better: WireBatch | null }
  | { kind: "none" };

export function adviceFor(line: WireDispenseLine, qty: number, today: string, chosen: string | null): BatchAdvice {
  const batches = line.batches ?? [];
  const batch = (chosen === null ? undefined : batches.find((b) => b.batchId === chosen)) ?? batches[0];
  if (batch === undefined) return { kind: "none" };
  const covers = batches.filter((b) => b.available >= qty && b.batchId !== batch.batchId);
  if (batch.available < qty) return { kind: "first_short", batch, better: covers[0] ?? null };
  const courseEnds = line.rxLine.durationDays === null ? null : addDays(today, line.rxLine.durationDays);
  if (courseEnds !== null && batch.expiryDate !== null && batch.expiryDate < courseEnds) {
    return { kind: "dies_in_course", batch, better: covers.find((b) => b.expiryDate === null || b.expiryDate >= courseEnds) ?? null };
  }
  return { kind: "ok", batch };
}

/** `YYYY-MM-DD` + n days, calendar arithmetic in UTC on a date that carries no clock. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today in IST, as the server's expiry comparisons read it. */
export function istToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * ═══ THE DESK BOARD'S FEFO BATCH & SHELF CHIP ═══
 *
 * Under every drug that has stock, one chip names the batch that goes out and the rack it sits on.
 * The server sends the sellable batches nearest-expiry first (`sellableBatchesByItem`, the order the
 * pick itself uses), so the top row IS FEFO; choosing another names it to the pick as `batchId`,
 * which the server records as a FEFO override.
 */
export type Pack = { uom: string; multiplier: number };

/** The pack the shelf counts in — the largest unit above the base ("strip" of 10), or null for loose stock. */
export function packOf(item: { uoms: readonly { uom: string; toBaseMultiplier: number }[] } | null | undefined): Pack | null {
  const packs = (item?.uoms ?? []).filter((u) => u.toBaseMultiplier > 1).sort((a, b) => b.toBaseMultiplier - a.toBaseMultiplier);
  const top = packs[0];
  return top === undefined ? null : { uom: top.uom, multiplier: top.toBaseMultiplier };
}

function unit(uom: string, n: number): string {
  return n === 1 || /s$/i.test(uom) ? uom : `${uom}s`;
}

/** A base quantity in the pack's words — "1 strip", "2 strips + 5" — or null when there is no pack. */
export function inPacks(qtyBase: number, pack: Pack | null): string | null {
  if (pack === null || qtyBase < pack.multiplier) return null;
  const whole = Math.floor(qtyBase / pack.multiplier);
  const rest = qtyBase % pack.multiplier;
  return `${String(whole)} ${unit(pack.uom, whole)}${rest === 0 ? "" : ` + ${String(rest)}`}`;
}

/** The qty column: strips on top, base units under ("1 strip" / "10 tablets"); loose stock is the count and its unit. */
export function qtyLabels(qtyBase: number | null, pack: Pack | null, baseUom: string): { main: string; sub: string } {
  if (qtyBase === null) return { main: "—", sub: baseUom };
  const packs = inPacks(qtyBase, pack);
  return packs === null ? { main: String(qtyBase), sub: unit(baseUom, qtyBase) } : { main: packs, sub: `${String(qtyBase)} ${unit(baseUom, qtyBase)}` };
}

/** `2026-10-21` → `21 Oct 2026`, as the board prints an expiry. */
export function expiryLabel(iso: string | null): string {
  if (iso === null) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

/** Days from `today` to `expiry` (both `YYYY-MM-DD`), negative once past. */
export function daysLeft(today: string, expiry: string): number {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** A batch is SOON when it dies inside the prescribed course, or inside 90 days. */
export const SOON_DAYS = 90;
export function expiresSoon(line: WireDispenseLine, batch: WireBatch, today: string): boolean {
  if (batch.expiryDate === null) return false;
  const course = line.rxLine.durationDays ?? 0;
  return batch.expiryDate < addDays(today, Math.max(course, SOON_DAYS));
}

/** The batch the line will be given from: the one chosen, else FEFO's first. */
export function chosenBatch(line: WireDispenseLine, tick: Tick | undefined): WireBatch | undefined {
  const batches = line.batches ?? [];
  const id = tick?.batchId ?? null;
  return (id === null ? undefined : batches.find((b) => b.batchId === id)) ?? batches[0];
}

export type BatchRow = { batch: WireBatch; fefo: boolean; chosen: boolean; days: number | null; soon: boolean; onHand: string };
export function batchRows(line: WireDispenseLine, tick: Tick | undefined, today: string): BatchRow[] {
  const pack = packOf(line.item);
  const chosen = chosenBatch(line, tick);
  return (line.batches ?? []).map((b, i) => ({
    batch: b, fefo: i === 0, chosen: b.batchId === chosen?.batchId,
    days: b.expiryDate === null ? null : daysLeft(today, b.expiryDate),
    soon: expiresSoon(line, b, today),
    onHand: inPacks(b.available, pack) ?? `${String(b.available)} ${unit(line.item?.baseUom ?? "", b.available)}`.trim(),
  }));
}

/**
 * The batch printed on a pack's GS1 code — `(10)` bracketed, or raw AIs back to back — or null. The
 * server reads the same code again at the pick and is the judge; this only routes the scan.
 */
export function scanBatchOf(raw: string): string | null {
  let s = raw.trim();
  if (/^\][A-Za-z]\d/.test(s)) s = s.slice(3);
  if (s.startsWith("(")) {
    const m = /\(10\)([^(]*)/.exec(s);
    return m === null || m[1]!.trim() === "" ? null : m[1]!.trim();
  }
  const GS = String.fromCharCode(29);
  const FIXED: Record<string, number> = { "01": 14, "11": 6, "13": 6, "15": 6, "17": 6 };
  let i = 0;
  if (!s.startsWith("01")) return null;
  while (i < s.length) {
    const ai = s.slice(i, i + 2);
    const fixed = FIXED[ai];
    if (fixed !== undefined) { i += 2 + fixed; }
    else if (ai === "10" || ai === "21") {
      const end = s.indexOf(GS, i + 2);
      const v = s.slice(i + 2, end === -1 ? s.length : end).trim();
      if (ai === "10") return v === "" ? null : v;
      i = end === -1 ? s.length : end;
    } else return null;
    if (s[i] === GS) i += 1;
  }
  return null;
}

/**
 * ONE SCAN BOX FOR THE TICKET. A pack scanned at the ticket goes to the line whose batch it carries;
 * a code with no batch goes to the line in focus, else the first open line not yet ticked. The pick
 * judges the pack (`scan_wrong_item`, `scan_batch_unknown`) and a refusal lands on that line.
 */
export function routeScan(
  code: string, lines: readonly WireDispenseLine[], ticks: Readonly<Record<number, Tick>>, focus: number | null,
): { lineIdx: number; batchId: string | null } | null {
  const open = lines.filter((l) => l.status === "open" && l.pickedBatch == null && blockedFor(l, ticks[l.lineIdx]) === null);
  const batchNo = scanBatchOf(code);
  if (batchNo !== null) {
    const hits = open.filter((l) => (l.batches ?? []).some((b) => b.batchNo.toLowerCase() === batchNo.toLowerCase()));
    const hit = hits.find((l) => ticks[l.lineIdx]?.ticked !== true) ?? hits[0];
    if (hit !== undefined) {
      const b = (hit.batches ?? []).find((x) => x.batchNo.toLowerCase() === batchNo.toLowerCase())!;
      return { lineIdx: hit.lineIdx, batchId: b.batchId === hit.batches?.[0]?.batchId ? null : b.batchId };
    }
  }
  const focused = open.find((l) => l.lineIdx === focus && ticks[l.lineIdx]?.ticked !== true);
  const next = focused ?? open.find((l) => ticks[l.lineIdx]?.ticked !== true);
  return next === undefined ? null : { lineIdx: next.lineIdx, batchId: ticks[next.lineIdx]?.batchId ?? null };
}

/** The salt under the doctor's brand: the server's composition, each salt with a capital. */
export function saltLabel(salt: string | null | undefined): string | null {
  if (salt == null || salt.trim() === "") return null;
  return salt.split(" + ").map((s) => (s === "" ? s : s[0]!.toUpperCase() + s.slice(1))).join(" + ");
}
