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
 *     ticked at all; it is declined, or substituted (PD-5).
 */
/**
 * `sub` is PD-5's generic equivalent, chosen on the sheet with the patient's consent. It is sent to
 * `verify` as `dispensedMedicineId` + `patientConsent`, and while it stands the line is served from
 * the SUBSTITUTE'S stock — the original's empty shelf no longer blocks the tick.
 */
export type Tick = {
  ticked: boolean; qty: string; reason: string; batchId: string | null; scan: string;
  sub: { medicineId: string; brandName: string; available: number } | null;
};

export function freshTick(line: WireDispenseLine): Tick {
  return { ticked: false, qty: line.qtyBase === null ? "" : String(line.qtyBase), reason: "", batchId: null, scan: "", sub: null };
}

/** The block that applies to THIS tick: a chosen substitute lifts the shelf's, never the law's or the catalogue's. */
export function blockedFor(line: WireDispenseLine, tick: Tick | undefined): Blocked | null {
  const b = blockedOf(line);
  if (tick?.sub == null || b === "unresolved" || b === "schedule_x") return b;
  return null;
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
