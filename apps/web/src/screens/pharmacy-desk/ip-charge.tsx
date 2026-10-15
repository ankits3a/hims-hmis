import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError, newIdempotencyKey } from "../../lib/api";
import { useDebounced } from "../../lib/format";
import { refusalOf } from "../../lib/ipd-beds-api";
import { chargeToIp, fetchIpCounterSales, findIpAdmission, returnToCounter, searchIpShelf } from "../../lib/ipd-counter-api";
import type { CounterChargeResult } from "../../lib/ipd-counter-api";
import type { IpdCounterAdmission, IpdCounterShelfEntry } from "@hmis/contracts";
import "./paper-rx.css";

/**
 * ═══ #787 (IP counter) — CHARGE TO IP: THE COUNTER'S IP-CHARGE MODE ═══
 *
 * An admitted patient's attendant buys at the OPD counter and the sale goes on the admission's running bill instead of
 * taking cash. The pharmacist types the IP number or the UHID; the sheet shows the patient, the bed and the ward so the
 * right admission is charged. Then the medicines off the PHARM-OPD shelf, the units, and Charge. The server prices each
 * batch exactly as a ward issue (batch MRP, no member benefit) and refuses a patient not admitted, a discharged stay and a
 * settled final bill — said here in the server's rule, with the way out (cash sale, or the supplementary bill).
 * Returns: the admission's counter sales, and units back per item — the bill is credited as a ward return is.
 */
type Line = { entry: IpdCounterShelfEntry; qty: string };

/** The server's own answer to the act (a 4xx other than "still running"): the next press is a new request. */
const answered = (e: unknown): boolean => e instanceof ApiError && e.status >= 400 && e.status < 500
  && !(typeof e.body === "object" && e.body !== null && (e.body as { code?: unknown }).code === "idempotency_key_in_progress");

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function IpChargeSheet({ onClose }: { onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [find, setFind] = useState("");
  const [admission, setAdmission] = useState<IpdCounterAdmission | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const typed = useDebounced(q.trim(), 200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CounterChargeResult | null>(null);
  const [backQty, setBackQty] = useState<Record<string, string>>({});
  /*
   * One key per charge, kept across a network failure (the retry is the same request) and dropped on an answer. Review of
   * 73731986: only the server's own answer drops it — a gateway 5xx (a deploy, a timeout) may sit in front of a sale the
   * server did, and `idempotency_key_in_progress` IS that sale still running; a new key there would charge it twice.
   */
  const key = useRef(newIdempotencyKey());
  /* One key per return row, by the same rule. */
  const backKeys = useRef<Record<string, string>>({});

  const say = (e: unknown): string => {
    const r = refusalOf(e);
    if (r !== null) return t(`ipCharge.refusal.${r.code}`, { defaultValue: r.rule });
    return e instanceof ApiError ? t("ipCharge.failed") : t("ipCharge.offline");
  };

  const shelf = useQuery({
    queryKey: ["ipd", "counter", "shelf", typed],
    queryFn: () => searchIpShelf(typed),
    enabled: admission !== null && typed.length >= 2,
    retry: false,
  });
  const sales = useQuery({
    queryKey: ["ipd", "counter", "sales", admission?.admissionId ?? ""],
    queryFn: () => fetchIpCounterSales(admission!.admissionId),
    enabled: admission !== null,
    retry: false,
  });

  const lookUp = async (): Promise<void> => {
    if (find.trim().length < 3 || busy) return;
    setBusy(true); setError(null); setDone(null); setAdmission(null); setLines([]);
    try { setAdmission(await findIpAdmission(find.trim())); } catch (e) { setError(say(e)); } finally { setBusy(false); }
  };
  const add = (entry: IpdCounterShelfEntry): void => {
    setLines((ls) => (ls.some((l) => l.entry.itemId === entry.itemId) ? ls : [...ls, { entry, qty: "" }]));
    setQ("");
  };
  const valid = lines.length > 0 && lines.every((l) => /^\d+$/.test(l.qty) && Number(l.qty) > 0 && Number(l.qty) <= 500);
  const charge = async (): Promise<void> => {
    if (admission === null || !valid || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await chargeToIp(admission.admissionId, lines.map((l) => ({ medicineId: l.entry.medicineId, units: Number(l.qty) })), key.current);
      setDone(r); setLines([]); key.current = newIdempotencyKey();
      void qc.invalidateQueries({ queryKey: ["ipd", "counter", "sales", admission.admissionId] });
    } catch (e) {
      setError(say(e));
      if (answered(e)) key.current = newIdempotencyKey();
    } finally { setBusy(false); }
  };
  const giveBack = async (saleId: string, itemId: string): Promise<void> => {
    const n = Number(backQty[`${saleId}:${itemId}`] ?? "");
    if (!Number.isInteger(n) || n <= 0 || busy) return;
    setBusy(true); setError(null);
    const row = `${saleId}:${itemId}`;
    const k = backKeys.current[row] ?? newIdempotencyKey();
    backKeys.current[row] = k;
    try {
      await returnToCounter(saleId, itemId, n, t("ipCharge.returnReason"), k);
      delete backKeys.current[row];
      setBackQty((m) => ({ ...m, [row]: "" }));
      void qc.invalidateQueries({ queryKey: ["ipd", "counter", "sales", admission?.admissionId ?? ""] });
    } catch (e) {
      setError(say(e));
      if (answered(e)) delete backKeys.current[row];
    } finally { setBusy(false); }
  };

  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("ipCharge.title")} onClick={onClose}>
      <div className="box paper-rx" data-testid="ip-charge-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="paper-rx-head">
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flexGrow: 1 }}>{t("ipCharge.title")}</h2>
          <button type="button" className="pill" onClick={onClose}>{t("pharmacyDesk.close")} <span className="kb">Esc</span></button>
        </div>
        <div className="paper-rx-body">
          <p style={{ margin: "0 0 12px 0", fontSize: 12.5, color: "var(--dim)" }}>{t("ipCharge.sub")}</p>
          <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); void lookUp(); }}>
            <input className="in" autoFocus autoComplete="off" value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("ipCharge.findPlaceholder")}
              aria-label={t("ipCharge.findPlaceholder")} data-testid="ip-charge-find" style={{ flexGrow: 1, minWidth: 0 }} />
            <button type="submit" className="sec" disabled={busy || find.trim().length < 3} data-testid="ip-charge-find-go">{t("ipCharge.find")}</button>
          </form>

          {admission === null ? null : (
            <div className="box" style={{ marginTop: 12, padding: "10px 12px", display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }} data-testid="ip-charge-patient">
              <strong style={{ fontSize: 14 }}>{admission.identity.name}</strong>
              <span className="mo" style={{ fontSize: 12 }}>{admission.identity.uhid}</span>
              <span className="mo" style={{ fontSize: 12 }}>{admission.admissionNo ?? ""}</span>
              <span style={{ fontSize: 13 }} data-testid="ip-charge-bed">
                {t("ipCharge.bed")} <strong>{admission.bedCode ?? "—"}</strong> · {t("ipCharge.ward")} <strong>{admission.wardName ?? "—"}</strong>
              </span>
            </div>
          )}

          {admission === null ? null : (
            <>
              <label htmlFor="ip-charge-search" className="tag" style={{ display: "block", marginTop: 16 }}>{t("ipCharge.medicine")}</label>
              <input id="ip-charge-search" className="in" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && shelf.data?.[0] !== undefined) { e.preventDefault(); add(shelf.data[0]); } }}
                placeholder={t("ipCharge.search")} style={{ marginTop: 6, width: "100%" }} data-testid="ip-charge-search" />
              {typed.length >= 2 && (shelf.data ?? []).length > 0 ? (
                <div className="box" style={{ marginTop: 6 }} data-testid="ip-charge-results">
                  {(shelf.data ?? []).slice(0, 8).map((s) => (
                    <button key={s.itemId} type="button" className="drow" style={{ width: "100%", textAlign: "left" }} onClick={() => add(s)}>
                      <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 500 }}>{s.brandName}{s.strengthLabel === null ? "" : ` ${s.strengthLabel}`}</span>
                      <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("ipCharge.available", { count: s.available })}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div style={{ marginTop: 12 }} data-testid="ip-charge-lines">
                {lines.map((l, i) => (
                  <div key={l.entry.itemId} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: i === 0 ? "none" : "1px solid var(--line2)" }}>
                    <span style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{l.entry.brandName}{l.entry.strengthLabel === null ? "" : ` ${l.entry.strengthLabel}`}</span>
                    <input className="in" inputMode="numeric" style={{ width: 80, height: 32 }} placeholder={l.entry.baseUom} value={l.qty}
                      aria-label={`${t("ipCharge.qty")} ${l.entry.brandName}`}
                      onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: v } : x))); }} />
                    <button type="button" className="pill" aria-label={`${t("ipCharge.remove")} ${l.entry.brandName}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {done === null ? null : (
            <p role="status" data-testid="ip-charge-done" style={{ margin: "12px 0 0 0", fontSize: 13, color: "var(--green)" }}>
              {t("ipCharge.charged", { amount: rupees(done.totalPaise), ip: admission?.admissionNo ?? "" })}
            </p>
          )}
          {error !== null ? <p role="alert" data-testid="ip-charge-error" style={{ margin: "12px 0 0 0", fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}

          {admission === null || (sales.data?.sales ?? []).length === 0 ? null : (
            <div style={{ marginTop: 18 }} data-testid="ip-charge-sales">
              <span className="tag">{t("ipCharge.returns")}</span>
              {(sales.data?.sales ?? []).map((s) => s.lines.filter((l) => l.units > l.returned).map((l) => {
                const k = `${s.saleId}:${l.itemId}`;
                return (
                  <div key={k} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0" }}>
                    <span style={{ flexGrow: 1, minWidth: 0, fontSize: 13 }}>{l.name}</span>
                    <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("ipCharge.out", { count: l.units - l.returned })}</span>
                    <input className="in" inputMode="numeric" style={{ width: 64, height: 30 }} value={backQty[k] ?? ""} aria-label={`${t("ipCharge.returnQty")} ${l.name}`}
                      onChange={(e) => { const v = e.target.value.replace(/\D/g, ""); setBackQty((m) => ({ ...m, [k]: v })); }} />
                    <button type="button" className="sec" disabled={busy || !(Number(backQty[k] ?? "") > 0)} onClick={() => void giveBack(s.saleId, l.itemId)}>{t("ipCharge.returnButton")}</button>
                  </div>
                );
              }))}
            </div>
          )}
        </div>
        <div className="paper-rx-foot">
          <button type="button" className="sec" style={{ marginLeft: "auto" }} onClick={onClose}>{t("ipCharge.cancel")}</button>
          <button type="button" className="pri" disabled={admission === null || !valid || busy} onClick={() => void charge()} data-testid="ip-charge-save">
            {busy ? t("ipCharge.charging") : t("ipCharge.charge")}
          </button>
        </div>
      </div>
    </div>
  );
}
