import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { materialsErrorText } from "../../lib/materials-api";
import { rupees } from "../../lib/purchase-api";
import { MANUAL_REASONS, createReturn, fetchReturnVendors, fetchReturnable, qtyText, returnRefusal } from "../../lib/returns-api";
import { Sheet } from "./sheet";
import type { ReturnLineInput, ReturnLineReason, WireReturn, WireReturnableBatch, Pack } from "../../lib/returns-api";

/**
 * ═══ GAP-CLOSURE A5 — A PERSON'S RETURN TO THE SUPPLIER, AND A DRAFT'S LINES EDITED ═══
 *
 * Before A5 only the agent (from the expiry list) and a recall could draft a return, and nobody could
 * change a draft's lines. `POST` / `PATCH /materials/supplier-returns` existed with no screen.
 *
 *   - N on the Returns side opens the NEW RETURN sheet: the supplier (only real suppliers of owned
 *     stock some store still holds), then lines found by searching that supplier's stock — item,
 *     batch, store, how much is free — each with its quantity (packs or base units), its reason and
 *     a note. Saved as a DRAFT; the existing approve → dispatch → debit note flow follows unchanged.
 *   - A draft's lines are edited from its sheet (E) until it is approved: a quantity changed, a line
 *     removed or added. The server re-checks every line on save and again at approval.
 *
 * Keys: / search · ↑↓ results · ⏎ add · Esc close. The server's refusals render as the rule that
 * fired (`returnRefusal`), else the `materialsErrors` sentence.
 */

export type DraftLine = {
  batchId: string; storeResourceId: string; itemName: string; itemCode: string; batchNo: string; expiryDate: string | null;
  storeCode: string; baseUom: string; pack: Pack; costPaise: number;
  qty: string; unit: "pack" | "base"; reason: ReturnLineReason; note: string;
};

const keyOf = (l: { storeResourceId: string; batchId: string }): string => `${l.storeResourceId}|${l.batchId}`;

/** The line's quantity in base units, or null when it is not a whole number above zero. */
export function qtyBaseOf(l: DraftLine): number | null {
  const n = Number(l.qty);
  if (l.qty.trim() === "" || !Number.isInteger(n) || n <= 0) return null;
  return l.unit === "pack" && l.pack !== null ? n * l.pack.multiplier : n;
}

export function linesFromReturn(r: WireReturn): DraftLine[] {
  return r.lines.map((l) => {
    const whole = l.pack !== null && l.qtyBase % l.pack.multiplier === 0;
    return {
      batchId: l.batchId, storeResourceId: l.storeResourceId, itemName: l.itemName, itemCode: l.itemCode, batchNo: l.batchNo, expiryDate: l.expiryDate,
      storeCode: l.storeCode, baseUom: l.baseUom, pack: l.pack, costPaise: l.ratePaise,
      qty: String(whole ? l.qtyBase / l.pack!.multiplier : l.qtyBase), unit: whole ? "pack" : "base", reason: l.reason, note: l.note ?? "",
    };
  });
}

export function toInput(lines: readonly DraftLine[]): ReturnLineInput[] {
  return lines.map((l) => ({
    batchId: l.batchId, storeResourceId: l.storeResourceId, qtyBase: qtyBaseOf(l) ?? 0, reason: l.reason, note: l.note.trim() === "" ? null : l.note.trim(),
  }));
}

/** The rule that fired, in the person's language; else the `materialsErrors` sentence. */
export function refusalText(e: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  const r = returnRefusal(e);
  if (r !== null) {
    const text = t(r.key, r.params);
    if (text !== r.key) return text;
  }
  return materialsErrorText(e, t);
}

function lineFrom(b: WireReturnableBatch): DraftLine {
  return {
    batchId: b.batchId, storeResourceId: b.storeResourceId, itemName: b.itemName, itemCode: b.itemCode, batchNo: b.batchNo, expiryDate: b.expiryDate,
    storeCode: b.storeCode, baseUom: b.baseUom, pack: b.pack, costPaise: b.landedCostPaise,
    qty: "", unit: b.pack !== null ? "pack" : "base", reason: b.reasons[0] ?? "damaged", note: "",
  };
}

/**
 * THE LINES: search the supplier's stock and add a batch; each line's quantity, reason and note;
 * remove. `exceptReturnId` is the draft being edited, whose own lines do not count against it.
 */
export function LinesEditor({ vendorId, exceptReturnId, lines, onChange }: {
  vendorId: string; exceptReturnId: string | null; lines: DraftLine[]; onChange: (next: DraftLine[]) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const held = useQuery({ queryKey: ["pharmacy", "office", "returnable", vendorId, exceptReturnId], queryFn: () => fetchReturnable(vendorId, "", exceptReturnId) });
  const found = useQuery({
    queryKey: ["pharmacy", "office", "returnable", vendorId, exceptReturnId, q.trim()], queryFn: () => fetchReturnable(vendorId, q, exceptReturnId),
    enabled: q.trim().length >= 2,
  });
  const byKey = useMemo(() => new Map((held.data ?? []).map((b) => [keyOf(b), b])), [held.data]);
  const onBoard = new Set(lines.map(keyOf));
  const results = (q.trim().length >= 2 ? found.data ?? [] : []).slice(0, 30);
  const add = (b: WireReturnableBatch): void => {
    if (onBoard.has(keyOf(b)) || b.reasons.length === 0 || b.available <= 0) return;
    onChange([...lines, lineFrom(b)]);
    setQ("");
    setTimeout(() => document.querySelector<HTMLInputElement>(`[data-line-qty="${keyOf(b)}"]`)?.focus(), 0);
  };
  const set = (k: string, patch: Partial<DraftLine>): void => onChange(lines.map((l) => (keyOf(l) === k ? { ...l, ...patch } : l)));
  const onSearchKey = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") { e.preventDefault(); resultsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }
    if (e.key === "Enter") { e.preventDefault(); const first = results.find((b) => !onBoard.has(keyOf(b)) && b.reasons.length > 0 && b.available > 0); if (first !== undefined) add(first); }
  };
  const onResultsKey = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = Array.from(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowUp" && i <= 0) { searchRef.current?.focus(); e.preventDefault(); return; }
    all[e.key === "ArrowDown" ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    e.preventDefault();
  };
  const reasonText = (r: ReturnLineReason): string => t(`pharmacyOffice.returns.reason.${r}`);

  return (
    <div className="pr-lines" data-testid="return-lines-editor">
      <label className="fld">
        <span className="tag">{t("pharmacyOffice.returns.manual.search")} <span className="kb">/</span></span>
        <input ref={searchRef} className="in" data-return-search value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
          placeholder={t("pharmacyOffice.returns.manual.searchPlaceholder")} aria-label={t("pharmacyOffice.returns.manual.search")} />
      </label>
      {q.trim().length >= 2 && (
        <div ref={resultsRef} className="box pr-results" onKeyDown={onResultsKey} data-testid="return-search-results">
          {found.isLoading && <p className="pr-dim">{t("pharmacyOffice.sheet.loading")}</p>}
          {found.data !== undefined && results.length === 0 && <p className="pr-dim">{t("pharmacyOffice.returns.manual.noneFound")}</p>}
          {results.map((b) => {
            const onIt = onBoard.has(keyOf(b));
            const blocked = b.reasons.length === 0 || b.available <= 0;
            return (
              <button key={keyOf(b)} type="button" className="pr-hit" disabled={onIt || blocked} data-testid={`return-hit-${b.batchNo}-${b.storeCode}`} onClick={() => add(b)}>
                <span className="pr-hit-main">
                  <b>{b.itemName}</b>
                  <span className="pr-dim mo">{b.batchNo} · {t("pharmacyOffice.returns.manual.exp", { date: b.expiryDate ?? "—" })} · {b.storeCode}</span>
                </span>
                <span className="pr-hit-side">
                  {b.recalled && <span className="pill rd">{t("pharmacyOffice.returns.recalled")}</span>}
                  {b.pastWindow && <span className="pill rd">{t("pharmacyOffice.returns.manual.pastWindow")}</span>}
                  <span className="mo">{t("pharmacyOffice.returns.manual.free", { qty: qtyText(b.available, b.baseUom, b.pack) })}</span>
                  <span className="pr-act">{onIt ? t("pharmacyOffice.returns.manual.onReturn") : blocked ? "" : `${t("pharmacyOffice.returns.manual.add")} ⏎`}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {lines.length === 0
        ? <p className="pr-dim" data-testid="return-lines-empty">{t("pharmacyOffice.returns.manual.noLines")}</p>
        : (
          <div className="pr-rows">
            {lines.map((l) => {
              const k = keyOf(l);
              const stock = byKey.get(k);
              const base = qtyBaseOf(l);
              const over = stock !== undefined && base !== null && base > stock.available;
              const reasons = stock === undefined ? [l.reason] : MANUAL_REASONS.filter((r) => stock.reasons.includes(r) || r === l.reason);
              return (
                <div key={k} className="box pr-line" data-testid={`draft-line-${l.batchNo}-${l.storeCode}`}>
                  <div className="pr-line-head">
                    <span className="pr-hit-main">
                      <b>{l.itemName}</b>
                      <span className="pr-dim mo">{l.itemCode} · {l.batchNo} · {t("pharmacyOffice.returns.manual.exp", { date: l.expiryDate ?? "—" })} · {l.storeCode}</span>
                    </span>
                    <button type="button" className="sec pr-x" aria-label={t("pharmacyOffice.returns.manual.remove", { batch: l.batchNo })} data-testid={`remove-line-${l.batchNo}`}
                      onClick={() => onChange(lines.filter((x) => keyOf(x) !== k))}>✕</button>
                  </div>
                  <div className="pr-line-grid">
                    <label className="fld">
                      <span className="tag">{t("pharmacyOffice.sheet.qty")}</span>
                      <span className="pr-qty">
                        <input className="in mo" inputMode="numeric" data-line-qty={k} value={l.qty} onChange={(e) => set(k, { qty: e.target.value })}
                          aria-label={t("pharmacyOffice.returns.manual.qtyFor", { batch: l.batchNo })} />
                        {l.pack !== null ? (
                          <select className="in" value={l.unit} onChange={(e) => set(k, { unit: e.target.value as DraftLine["unit"] })} aria-label={t("pharmacyOffice.returns.manual.unitFor", { batch: l.batchNo })}>
                            <option value="pack">{l.pack.uom}</option>
                            <option value="base">{l.baseUom}</option>
                          </select>
                        ) : <span className="pr-dim">{l.baseUom}</span>}
                      </span>
                    </label>
                    <label className="fld">
                      <span className="tag">{t("pharmacyOffice.returns.col.reason")}</span>
                      <select className="in" value={l.reason} onChange={(e) => set(k, { reason: e.target.value as ReturnLineReason })} aria-label={t("pharmacyOffice.returns.manual.reasonFor", { batch: l.batchNo })}>
                        {reasons.map((r) => <option key={r} value={r}>{reasonText(r)}</option>)}
                      </select>
                    </label>
                    <label className="fld pr-note">
                      <span className="tag">{t("pharmacyOffice.returns.manual.note")}</span>
                      <input className="in" value={l.note} maxLength={500} onChange={(e) => set(k, { note: e.target.value })}
                        placeholder={t("pharmacyOffice.returns.manual.notePlaceholder")} aria-label={t("pharmacyOffice.returns.manual.noteFor", { batch: l.batchNo })} />
                    </label>
                  </div>
                  <div className="pr-line-foot">
                    <span className="pr-dim">
                      {stock === undefined ? "" : t("pharmacyOffice.returns.manual.free", { qty: qtyText(stock.available, stock.baseUom, stock.pack) })}
                      {base !== null ? ` · ${String(base)} ${l.baseUom}` : ""}
                    </span>
                    {over && <span className="pr-bad" role="alert">{t("pharmacyOffice.returns.manual.over", { qty: qtyText(stock.available, stock.baseUom, stock.pack) })}</span>}
                    {l.qty.trim() !== "" && base === null && <span className="pr-bad" role="alert">{t("pharmacyOffice.returns.manual.badQty")}</span>}
                    <span className="mo">{base === null ? "" : rupees(base * l.costPaise)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

/** Lines ready to save: at least one, every quantity a whole number above zero and within what is free. */
export function linesReady(lines: readonly DraftLine[], held: readonly WireReturnableBatch[] | undefined): boolean {
  if (lines.length === 0) return false;
  const byKey = new Map((held ?? []).map((b) => [keyOf(b), b]));
  return lines.every((l) => {
    const base = qtyBaseOf(l);
    const s = byKey.get(keyOf(l));
    return base !== null && (s === undefined || base <= s.available);
  });
}

/** THE NEW RETURN: the supplier, the lines, a note for the whole return — saved as a draft. */
export function NewReturnSheet({ onClose, onMade }: { onClose: () => void; onMade: (r: WireReturn) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vendors = useQuery({ queryKey: ["pharmacy", "office", "return-vendors"], queryFn: fetchReturnVendors });
  const [vendorId, setVendorId] = useState<string>("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = useQuery({ queryKey: ["pharmacy", "office", "returnable", vendorId, null], queryFn: () => fetchReturnable(vendorId, "", null), enabled: vendorId !== "" });
  const vendor = vendors.data?.find((v) => v.vendorId === vendorId);
  const total = lines.reduce((s, l) => s + (qtyBaseOf(l) ?? 0) * l.costPaise, 0);
  const ready = vendorId !== "" && linesReady(lines, held.data);
  const save = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const made = await createReturn({ vendorId, note: note.trim() === "" ? null : note.trim(), lines: toInput(lines) });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onMade(made);
    } catch (e) {
      setError(refusalText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (!typing && e.key === "/" && vendorId !== "") { e.preventDefault(); document.querySelector<HTMLInputElement>("[data-return-search]")?.focus(); }
  };
  return (
    <Sheet title={t("pharmacyOffice.returns.manual.title")} onClose={onClose} testId="new-return-sheet" onKey={onKey}>
      <div className="pof-pine pr-sheet">
        <p className="pr-dim">{t("pharmacyOffice.returns.manual.intro")}</p>
        <label className="fld">
          <span className="tag">{t("pharmacyOffice.returns.col.supplier")}</span>
          <select className="in" value={vendorId} aria-label={t("pharmacyOffice.returns.col.supplier")} data-testid="new-return-vendor"
            onChange={(e) => { setVendorId(e.target.value); setLines([]); setError(null); }}>
            <option value="">{t("pharmacyOffice.returns.manual.pickSupplier")}</option>
            {(vendors.data ?? []).map((v) => <option key={v.vendorId} value={v.vendorId}>{v.vendorName} · {t("pharmacyOffice.returns.batches", { count: v.batches })}</option>)}
          </select>
        </label>
        {vendors.error !== null && <p role="alert" className="pr-bad">{materialsErrorText(vendors.error, t)}</p>}
        {vendors.data !== undefined && vendors.data.length === 0 && <p className="pr-dim">{t("pharmacyOffice.returns.manual.noSuppliers")}</p>}
        {vendor !== undefined && (
          <>
            <p className="pr-dim mo" data-testid="new-return-vendor-facts">
              {vendor.gstin === null ? t("pharmacyOffice.returns.manual.noGstin") : `GSTIN ${vendor.gstin}`} · {t("pharmacyOffice.returns.manual.window", { days: vendor.windowDays })}
            </p>
            <LinesEditor vendorId={vendorId} exceptReturnId={null} lines={lines} onChange={setLines} />
            <label className="fld">
              <span className="tag">{t("pharmacyOffice.returns.manual.returnNote")}</span>
              <input className="in" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-label={t("pharmacyOffice.returns.manual.returnNote")}
                placeholder={t("pharmacyOffice.returns.manual.returnNotePlaceholder")} />
            </label>
          </>
        )}
        {error !== null && <p role="alert" className="pr-bad" data-testid="new-return-error">{error}</p>}
        <div className="pr-foot">
          <span className="pr-dim">{lines.length === 0 ? "" : t("pharmacyOffice.returns.manual.summary", { count: lines.length, amount: rupees(total) })}</span>
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyOffice.plan.notNow")}</button>
          <button type="button" className="pri" disabled={busy || !ready} onClick={() => void save()} data-testid="new-return-save">{t("pharmacyOffice.returns.manual.save")}</button>
        </div>
        <p className="pr-dim pr-small">{t("pharmacyOffice.returns.manual.after")}</p>
      </div>
    </Sheet>
  );
}
