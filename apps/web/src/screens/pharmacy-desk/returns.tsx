import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError, newIdempotencyKey } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { acceptReturn, cancelBilledDispense, cancelDispense, pharmacyErrorCode, pharmacyErrorText } from "../../lib/pharmacy-api";
import { say } from "./log";
import type { WireDispense, WireDispenseLine } from "../../lib/pharmacy-api";

/**
 * ═══ RETURN / CANCEL / REFUND FROM THE DESK — the ticket's ⋯ ═══
 *
 * The server had all three acts and no screen called any of them (walk 2026-09-29): a pharmacist who
 * made a mistake, or a patient who brought medicine back, had no way to do it. Exceptions live behind
 * ⋯ and sheets (the Desk board), so this is ONE ⋯ on the ticket's header that offers the act the
 * ticket's status allows, and only that one:
 *
 *   - handed over → "Take medicine back": P6 `POST /pharmacy/dispenses/:id/returns`. Sealed, intact,
 *     whole packs, within the window — every clause is the SERVER's refusal, said via `pharmacyErrorText`.
 *   - billed, not handed over → "Cancel and refund": P5 `POST …/refund` (the whole bill is credited).
 *   - claimed / verified / picked → "Cancel this ticket": `POST …/cancel` (no money has moved).
 *
 * MONEY IS NOT DECIDED HERE. A return and a cancel-with-refund each raise a credit note and REQUEST a
 * refund (billing's `billing_refund` approval). The amount is the credit note's own net, read back
 * after the act; there is no preview endpoint, so the sheet never guesses a figure first. Who approves
 * is said as the server routes it: a billing manager; the voucher and the payout are billing's.
 */
export type TicketAct = "return" | "refund" | "cancel";

export function ticketActOf(d: Pick<WireDispense, "status" | "invoiceId">, can: (p: string) => boolean): TicketAct | null {
  if (d.status === "handed_over") return d.invoiceId !== null && can("billing.refund.request") ? "return" : null;
  if (d.status === "billed") return can("billing.refund.request") ? "refund" : null;
  if (d.status === "claimed" || d.status === "verified" || d.status === "picked") return can("pharmacy.dispense.place") ? "cancel" : null;
  return null;
}

/** A line that left the counter on a batch: the only kind a return may name (the server's `returnable`). */
export function returnableLines(d: WireDispense): WireDispenseLine[] {
  return d.lines.filter((l) => l.status === "open" && (l.qtyBase ?? 0) > 0 && l.batchId !== null);
}

type CreditNoteRow = { id: string; creditNoteNo: string; netPaise: number };
async function fetchCreditNotes(invoiceId: string): Promise<CreditNoteRow[]> {
  const { items } = await api<{ items: CreditNoteRow[] }>("GET", `/billing/invoices/${encodeURIComponent(invoiceId)}/credit-notes`);
  return items;
}

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const drugOf = (l: WireDispenseLine): string => l.dispensedMedicine?.brandName ?? l.item?.name ?? l.rxLine.drug;
/** The strip size (smallest pack above one tablet), or null when the item has no pack. */
export const stripOf = (l: WireDispenseLine): number | null => {
  const packs = (l.item?.uoms ?? []).map((u) => u.toBaseMultiplier).filter((m) => m > 1);
  return packs.length === 0 ? null : Math.min(...packs);
};
const expiryOf = (iso: string | null | undefined): string => (iso == null ? "—" : `${iso.slice(5, 7)}/${iso.slice(0, 4)}`);

/*
 * Common reasons as one-tap chips (owner 2026-10-03): typing the reason was the slowest step of a return.
 * A chip fills the reason box with its sentence in the desk's language, and on a return or refund it
 * also picks whose reason it is. The box stays editable; the approver reads whatever is sent.
 */
type ReasonChip = { key: string; whose: "mistake" | "genuine" | null };
export const REASON_CHIPS: Record<TicketAct, ReasonChip[]> = {
  return: [
    { key: "wrongMedicine", whose: "mistake" },
    { key: "wrongQty", whose: "mistake" },
    { key: "wrongBill", whose: "mistake" },
    { key: "doctorChanged", whose: "genuine" },
    { key: "notNeeded", whose: "genuine" },
    { key: "reaction", whose: "genuine" },
  ],
  refund: [
    { key: "wrongBill", whose: "mistake" },
    { key: "billedTwice", whose: "mistake" },
    { key: "outOfStock", whose: "mistake" },
    { key: "doctorChanged", whose: "genuine" },
    { key: "patientLeft", whose: "genuine" },
    { key: "notNeeded", whose: "genuine" },
  ],
  cancel: [
    { key: "patientLeft", whose: null },
    { key: "doctorChanged", whose: null },
    { key: "duplicate", whose: null },
    { key: "outOfStock", whose: null },
  ],
};

export function TicketMenu({ dispense }: { dispense: WireDispense }): React.ReactElement | null {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<TicketAct | null>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const act = ticketActOf(dispense, can);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent): void => { if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopImmediatePropagation(); setMenu(false); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [menu]);

  /* A sheet stays open across the act (it shows the refund), even when the status it was opened on has moved. */
  if (act === null && open === null) return null;
  return (
    <span ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-label={t("pharmacyDesk.returns.menu")}
        aria-expanded={menu}
        aria-haspopup="true"
        data-testid="desk-ticket-menu"
        onClick={() => setMenu((m) => !m)}
        style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dim)" }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </button>
      {menu && act !== null ? (
        <span className="lmenu" style={{ display: "block" }}>
          <button type="button" data-testid={`desk-act-${act}`} onClick={() => { setMenu(false); setOpen(act); }}>
            {t(`pharmacyDesk.returns.act.${act}`)}
          </button>
        </span>
      ) : null}
      {open !== null ? <ReturnSheet dispense={dispense} act={open} onClose={() => setOpen(null)} /> : null}
    </span>
  );
}

type Done = { creditNoteId: string; creditNoteNo: string; invoiceId: string | null; /** Kept as pharmacy credit instead of refunded (owner ruling 2026-10-02). */ keptPaise: number };

export function ReturnSheet({ dispense, act, onClose }: { dispense: WireDispense; act: TicketAct; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  const [qty, setQty] = useState<Record<number, string>>({});
  /* Owner ruling 2026-10-02 — the money of a return: asked back (approval), or kept as credit for the next bill. */
  const [settleAs, setSettleAs] = useState<"refund" | "credit">("refund");
  const [reasonClass, setReasonClass] = useState<"genuine" | "mistake" | "">("");
  const [reason, setReason] = useState("");
  /* Owner ruling 2026-10-03 — loose tablets go to the loose tray (sealed in the pocket) or the damage tray (our mistake). */
  const [looseTo, setLooseTo] = useState<"loose" | "damage" | "">("");
  const [sealed, setSealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  /*
   * The ticket as the act left it. It reaches the desk only when the sheet closes: a cancel-and-refund
   * moves the ticket to `cancelled`, the panel re-renders without this ⋯, and the refund would vanish
   * before the pharmacist had read who must approve it.
   */
  const [next, setNext] = useState<WireDispense | null>(null);
  const close = (): void => {
    if (next !== null) qc.setQueryData(["pharmacy", "dispense", dispense.id], next);
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  /* Esc closes THIS sheet and nothing else: captured before the desk's own Esc would clear the desk. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const lines = act === "return" ? returnableLines(dispense) : dispense.lines.filter((l) => l.status === "open");
  const wanted = lines.filter((l) => (qty[l.lineIdx] ?? "") !== "");
  const qtyOk = (l: WireDispenseLine): boolean => {
    const raw = qty[l.lineIdx] ?? "";
    return /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= (l.qtyBase ?? 0);
  };
  const hasLoose = act === "return" && wanted.some((l) => { const s = stripOf(l); return s !== null && qtyOk(l) && Number(qty[l.lineIdx]) % s !== 0; });
  const looseOk = !hasLoose || looseTo === "loose" || (looseTo === "damage" && reasonClass === "mistake");
  const reasonOk = act === "cancel" ? reason.trim() !== "" : reason.trim().length >= 3 && reasonClass !== "";
  const ready = !busy && done === null && reasonOk && (act !== "return" || (wanted.length > 0 && wanted.every(qtyOk) && sealed && looseOk));

  const refreshCounts = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["pharmacy", "queue"] }),
      qc.invalidateQueries({ queryKey: ["pharmacy", "summary"] }),
      qc.invalidateQueries({ queryKey: ["pharmacy", "closing", dispense.id] }),
    ]);
  };

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      if (act === "cancel") {
        const cancelled = await cancelDispense(dispense.id, reason.trim());
        say(t("pharmacyDesk.returns.logCancelled"));
        qc.setQueryData(["pharmacy", "dispense", dispense.id], cancelled);
        await refreshCounts();
        onClose();
        return;
      }
      const why = { reason: reason.trim(), reasonClass: reasonClass as "genuine" | "mistake" };
      const r = act === "return"
        ? await acceptReturn(dispense.id, { lines: wanted.map((l) => ({ lineIdx: l.lineIdx, qtyBase: Number(qty[l.lineIdx]) })), sealedIntact: true, ...why, ...(settleAs === "credit" ? { settle: "credit" as const } : {}), ...(hasLoose && looseTo !== "" ? { looseTo } : {}) }, key)
        : await cancelBilledDispense(dispense.id, why, key);
      setDone({ creditNoteId: r.creditNoteId, creditNoteNo: r.creditNoteNo, invoiceId: dispense.invoiceId, keptPaise: "creditKeptPaise" in r ? r.creditKeptPaise ?? 0 : 0 });
      void qc.invalidateQueries({ queryKey: ["pharmacy", "patient-rail"] });
      setKey(newIdempotencyKey());
      say(t(act === "return" ? "pharmacyDesk.returns.logReturned" : "pharmacyDesk.returns.logRefunded", { no: r.creditNoteNo }));
      setNext(r.dispense);
      await refreshCounts();
    } catch (e) {
      setError(refusalText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const title = t(`pharmacyDesk.returns.title.${act}`);
  const pad = { padding: "13px 18px" } as const;
  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={title} onClick={close}>
      <div className="box" data-testid="desk-return-sheet" style={{ width: 620, maxWidth: "calc(100vw - 32px)", maxHeight: "84vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...pad, borderBottom: "1px solid var(--line2)" }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h2>
          <p style={{ margin: "5px 0 0 0", fontSize: 12, color: "var(--dim)", lineHeight: "17px" }}>{t(`pharmacyDesk.returns.lead.${act}`)}</p>
        </div>

        <div style={{ overflowY: "auto" }}>
          {done !== null ? (
            <RefundDone done={done} act={act} />
          ) : (
            <>
              <div data-testid="desk-return-lines">
                {lines.length === 0 ? (
                  <p role="status" style={{ ...pad, margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.returns.nothing")}</p>
                ) : lines.map((l) => (
                  <div key={l.lineIdx} className="drow" data-testid={`return-line-${String(l.lineIdx)}`} style={{ padding: "11px 18px", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ flex: "1 1 220px", minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{drugOf(l)}</span>
                      <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)" }}>
                        {l.pickedBatch != null
                          ? t(act === "return" ? "pharmacyDesk.returns.batch" : "pharmacyDesk.returns.fromBatch", { batch: l.pickedBatch.batchNo, expiry: expiryOf(l.pickedBatch.expiryDate) })
                          : t("pharmacyDesk.returns.noBatch")}
                      </span>
                    </span>
                    {l.qtyBase === null ? null : (
                      <span className="mo" style={{ fontSize: 12, color: "var(--dim)", whiteSpace: "nowrap" }}>
                        {t(act === "return" ? "pharmacyDesk.returns.given" : "pharmacyDesk.returns.picked", { n: l.qtyBase, unit: l.item?.baseUom ?? "" })}
                      </span>
                    )}
                    {act === "return" ? (
                      <input
                        className="in mo"
                        inputMode="numeric"
                        aria-label={t("pharmacyDesk.returns.qty", { drug: drugOf(l) })}
                        data-testid={`return-qty-${String(l.lineIdx)}`}
                        placeholder="0"
                        value={qty[l.lineIdx] ?? ""}
                        onChange={(e) => setQty({ ...qty, [l.lineIdx]: e.target.value.replace(/\D/g, "") })}
                        style={{ width: 76, height: 32, textAlign: "right", borderColor: (qty[l.lineIdx] ?? "") !== "" && !qtyOk(l) ? "var(--red)" : undefined }}
                      />
                    ) : null}
                  </div>
                ))}
              </div>

              <div style={{ ...pad, borderTop: "1px solid var(--line2)", display: "grid", gap: 10 }}>
                {act === "cancel" ? null : (
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="tag">{t("pharmacyDesk.returns.whose")}</legend>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 5, fontSize: 12.5 }}>
                      {(["mistake", "genuine"] as const).map((c) => (
                        <label key={c} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="radio" name="return-class" data-testid={`return-class-${c}`} checked={reasonClass === c} onChange={() => setReasonClass(c)} style={{ accentColor: "#0e6b4e" }} />
                          {t(`pharmacyDesk.returns.class.${c}`)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <div>
                  <label className="tag" htmlFor="return-reason" style={{ display: "block" }}>{t(act === "cancel" ? "pharmacyDesk.returns.whyCancel" : "pharmacyDesk.returns.why")}</label>
                  <input id="return-reason" className="in" data-testid="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%", marginTop: 4, height: 34, fontSize: 13 }} />
                  <div role="group" aria-label={t("pharmacyDesk.returns.chipsLabel")} data-testid="return-reason-chips" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
                    {REASON_CHIPS[act].filter((c) => reasonClass === "" || c.whose === null || c.whose === reasonClass).map((c) => {
                      const text = t(`pharmacyDesk.returns.chip.${c.key}`);
                      const on = reason.trim() === text;
                      return (
                        <button
                          key={c.key}
                          type="button"
                          aria-pressed={on}
                          data-testid={`return-chip-${c.key}`}
                          onClick={() => { setReason(text); if (c.whose !== null) setReasonClass(c.whose); }}
                          style={{ height: 26, padding: "0 10px", borderRadius: 13, fontSize: 11.5, border: `1px solid ${on ? "var(--green-line)" : "var(--line)"}`, background: on ? "var(--green-soft)" : "var(--card)", color: on ? "var(--green)" : "var(--dim)", fontWeight: on ? 600 : 400 }}
                        >
                          {text}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {hasLoose ? (
                  <fieldset data-testid="return-loose" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="tag">{t("pharmacyDesk.returns.loose.title")}</legend>
                    <div style={{ display: "grid", gap: 4, marginTop: 5, fontSize: 12.5 }}>
                      {(["loose", "damage"] as const).map((c) => {
                        const off = c === "damage" && reasonClass !== "mistake";
                        return (
                          <label key={c} style={{ display: "flex", alignItems: "center", gap: 6, color: off ? "var(--faint)" : undefined }}>
                            <input type="radio" name="return-loose" data-testid={`return-loose-${c}`} disabled={off} checked={looseTo === c} onChange={() => setLooseTo(c)} style={{ accentColor: "#0e6b4e" }} />
                            {t(`pharmacyDesk.returns.loose.${c}`)}
                          </label>
                        );
                      })}
                    </div>
                    {reasonClass !== "mistake" ? <p style={{ margin: "4px 0 0 0", fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.returns.loose.patientNote")}</p> : null}
                  </fieldset>
                ) : null}
                {act === "return" ? (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                    <input type="checkbox" data-testid="return-sealed" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
                    {t("pharmacyDesk.returns.sealed")}
                  </label>
                ) : null}
                {act !== "return" ? null : (
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="tag">{t("pharmacyDesk.returns.settle.title")}</legend>
                    <div style={{ display: "grid", gap: 4, marginTop: 5, fontSize: 12.5 }}>
                      {(["refund", "credit"] as const).map((c) => (
                        <label key={c} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="radio" name="return-settle" data-testid={`return-settle-${c}`} checked={settleAs === c} onChange={() => setSettleAs(c)} style={{ accentColor: "#0e6b4e" }} />
                          {t(`pharmacyDesk.returns.settle.${c}`)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)", lineHeight: "16px" }}>{t(act === "return" && settleAs === "credit" ? "pharmacyDesk.returns.money.credit" : `pharmacyDesk.returns.money.${act}`)}</p>
                {error !== null ? <p role="alert" data-testid="return-error" style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
              </div>
            </>
          )}
        </div>

        <div style={{ ...pad, borderTop: "1px solid var(--line2)", background: "var(--wash)", display: "flex", gap: 8 }}>
          {done === null ? (
            <button type="button" className="pri" style={{ flexGrow: 1 }} data-testid="return-submit" disabled={!ready} onClick={() => void submit()}>
              {busy ? t("pharmacyDesk.returns.working") : t(`pharmacyDesk.returns.submit.${act}`)}
            </button>
          ) : null}
          <button type="button" className="sec" style={done === null ? undefined : { flexGrow: 1 }} data-testid="return-close" onClick={close}>
            {t(done === null ? "pharmacyDesk.returns.close" : "pharmacyDesk.returns.done")} <span className="kb">Esc</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** The refund as the server raised it: the credit note's own net, and who must approve before money moves. */
function RefundDone({ done, act }: { done: Done; act: TicketAct }): React.ReactElement {
  const { t } = useTranslation();
  const notes = useQuery({
    queryKey: ["billing", "credit-notes", done.invoiceId],
    queryFn: () => fetchCreditNotes(done.invoiceId ?? ""),
    enabled: done.invoiceId !== null,
    retry: false,
  });
  const note = notes.data?.find((n) => n.id === done.creditNoteId) ?? null;
  return (
    <div data-testid="desk-return-done" role="status" style={{ padding: "14px 18px", display: "grid", gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: "var(--green)" }}>{t(`pharmacyDesk.returns.doneTitle.${act}`)}</p>
      <p className="mo" data-testid="desk-return-amount" style={{ margin: 0, fontSize: 13 }}>
        {note !== null
          ? t("pharmacyDesk.returns.refundOf", { amount: rupees(note.netPaise), no: done.creditNoteNo })
          : t("pharmacyDesk.returns.refundNoAmount", { no: done.creditNoteNo })}
      </p>
      {done.keptPaise > 0 ? (
        <div style={{ padding: "10px 12px", borderRadius: 7, background: "var(--green-soft)", border: "1px solid var(--green-line)", fontSize: 12.5, lineHeight: "18px" }} data-testid="desk-return-credit">
          {t("pharmacyDesk.returns.creditKept", { amount: rupees(done.keptPaise) })}
        </div>
      ) : (
        <div style={{ padding: "10px 12px", borderRadius: 7, background: "var(--gold-soft)", border: "1px solid var(--gold-line)", fontSize: 12.5, lineHeight: "18px" }} data-testid="desk-return-approval">
          {t("pharmacyDesk.returns.approval")}
        </div>
      )}
    </div>
  );
}

/** The server's refusal as a sentence; `return_exceeds_dispensed` also says how many can still come back. */
function refusalText(e: unknown, t: (key: string, o?: Record<string, unknown>) => string): string {
  const base = pharmacyErrorText(e, t);
  if (pharmacyErrorCode(e) === "return_exceeds_dispensed" && e instanceof ApiError) {
    const detail = (e.body as { detail?: { lineIdx?: unknown; left?: unknown } } | undefined)?.detail;
    if (typeof detail?.left === "number" && typeof detail.lineIdx === "number") {
      return `${base} — ${t("pharmacyDesk.returns.left", { n: detail.left, line: detail.lineIdx + 1 })}`;
    }
  }
  return base;
}
