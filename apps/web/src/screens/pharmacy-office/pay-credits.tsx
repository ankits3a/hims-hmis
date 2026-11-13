import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  STANDALONE_CREDIT_KINDS, cancelStandaloneCredit, fetchStandaloneCredits, fetchVendors, materialsErrorText, recordStandaloneCredit,
} from "../../lib/materials-api";
import { rupees } from "../../lib/purchase-api";
import { Button } from "@/components/ui/button";
import { Sheet } from "./sheet";
import type { StandaloneCreditKind } from "../../lib/materials-api";

/**
 * ═══ #1047 — A SUPPLIER'S CREDIT NOTE WITHOUT A RETURN, FROM THE PAY SCREEN ═══
 *
 * A rate difference, a scheme, a breakage allowance or another credit the supplier sends with no goods coming
 * back. Recorded here (`POST /materials/supplier-credits`, `materials.bills.manage`) with the supplier's note
 * number and date and its taxable value and GST as printed; the next payment run sets it off against the
 * supplier's bills exactly as a return's credit (the agent's draft already does). A credit recorded in error is
 * cancelled from the list while no run has spent it.
 */
const NON_SUPPLIERS = ["OPENING-STOCK", "TRIAL-STOCK"];
const paiseOf = (text: string): number | null => (/^\s*\d+(\.\d{1,2})?\s*$/.test(text) ? Math.round(Number(text) * 100) : null);
const istToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function SupplierCreditsSection({ onDone }: { onDone: (message: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const credits = useQuery({ queryKey: ["materials", "supplier-credits"], queryFn: fetchStandaloneCredits });
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async (id: string, creditNo: string): Promise<void> => {
    const why = window.prompt(t("pharmacyOffice.pay.credits.cancelWhy", { creditNo }));
    if (why === null || why.trim() === "") return;
    setError(null);
    try {
      await cancelStandaloneCredit(id, why.trim());
      onDone(t("pharmacyOffice.pay.credits.cancelled", { creditNo }));
      await qc.invalidateQueries({ queryKey: ["materials", "supplier-credits"] });
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "pay"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    }
  };
  const live = (credits.data ?? []).filter((c) => c.status === "accepted").slice(0, 10);
  return (
    <section className="space-y-2 rounded border p-3" aria-labelledby="pay-credits-title" data-testid="pay-credits">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="pay-credits-title" className="flex-1 text-sm font-semibold">{t("pharmacyOffice.pay.credits.title")}</h2>
        <Button type="button" variant="outline" data-testid="pay-credit-record" onClick={() => setRecording(true)}>{t("pharmacyOffice.pay.credits.record")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.credits.lead")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {live.length > 0 && (
        <ul className="divide-y text-sm" data-testid="pay-credits-list">
          {live.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-1" data-testid={`pay-credit-${c.creditNo}`}>
              <span className="font-mono text-xs">{c.creditNo}</span>
              <span className="flex-1">{c.vendorName} · {c.vendorCreditNoteNo} · {t(`pharmacyOffice.pay.credits.kind.${c.kind}`)}</span>
              <span className="text-xs text-muted-foreground">{c.creditNoteDate}</span>
              <span className="tabular-nums text-emerald-800">{rupees(c.amountPaise)}</span>
              <button type="button" className="text-xs underline" onClick={() => void cancel(c.id, c.creditNo)}>{t("pharmacyOffice.pay.credits.cancel")}</button>
            </li>
          ))}
        </ul>
      )}
      {recording && (
        <CreditSheet
          onClose={() => setRecording(false)}
          onSaved={async (creditNo) => {
            setRecording(false);
            onDone(t("pharmacyOffice.pay.credits.recorded", { creditNo }));
            await qc.invalidateQueries({ queryKey: ["materials", "supplier-credits"] });
            await qc.invalidateQueries({ queryKey: ["pharmacy", "office", "pay"] });
          }}
        />
      )}
    </section>
  );
}

function CreditSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (creditNo: string) => Promise<void> }): React.ReactElement {
  const { t } = useTranslation();
  const vendors = useQuery({ queryKey: ["materials", "vendors", "active"], queryFn: () => fetchVendors({ status: "active" }) });
  const [vendorId, setVendorId] = useState("");
  const [kind, setKind] = useState<StandaloneCreditKind>("rate_difference");
  const [no, setNo] = useState("");
  const [date, setDate] = useState(istToday);
  const [taxable, setTaxable] = useState("");
  const [gst, setGst] = useState("");
  const [interState, setInterState] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taxablePaise = paiseOf(taxable);
  const gstPaise = gst.trim() === "" ? 0 : paiseOf(gst);
  const total = taxablePaise === null || gstPaise === null ? null : taxablePaise + gstPaise;
  const ready = vendorId !== "" && no.trim() !== "" && date !== "" && total !== null && total > 0 && !busy;
  const save = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const done = await recordStandaloneCredit({
        vendorId, kind, vendorCreditNoteNo: no.trim(), creditNoteDate: date, taxablePaise: taxablePaise!, gstPaise: gstPaise!, interState,
        note: note.trim() === "" ? null : note.trim(),
      });
      await onSaved(done.creditNo);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const field = "flex flex-col gap-1 text-sm";
  const box = "rounded border px-2 py-1";
  return (
    <Sheet title={t("pharmacyOffice.pay.credits.sheetTitle")} testId="pay-credit-sheet" onClose={onClose}>
      <div className="space-y-3">
        {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            {t("pharmacyOffice.pay.credits.supplier")}
            <select className={box} value={vendorId} data-testid="pay-credit-vendor" onChange={(e) => setVendorId(e.target.value)}>
              <option value="">{t("stockEntry.invoice.choose")}</option>
              {(vendors.data ?? []).filter((v) => !NON_SUPPLIERS.includes(v.code.toUpperCase())).map((v) => (
                <option key={v.id} value={v.id}>{v.tradeName ?? v.legalName} ({v.code})</option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("pharmacyOffice.pay.credits.kindLabel")}
            <select className={box} value={kind} data-testid="pay-credit-kind" onChange={(e) => setKind(e.target.value as StandaloneCreditKind)}>
              {STANDALONE_CREDIT_KINDS.map((k) => <option key={k} value={k}>{t(`pharmacyOffice.pay.credits.kind.${k}`)}</option>)}
            </select>
          </label>
          <label className={field}>
            {t("pharmacyOffice.pay.credits.number")}
            <input className={box} value={no} maxLength={64} data-testid="pay-credit-no" onChange={(e) => setNo(e.target.value)} />
          </label>
          <label className={field}>
            {t("pharmacyOffice.pay.credits.date")}
            <input className={box} type="date" value={date} max={istToday()} data-testid="pay-credit-date" onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className={field}>
            {t("pharmacyOffice.pay.credits.taxable")}
            <input className={box} inputMode="decimal" placeholder="0.00" value={taxable} data-testid="pay-credit-taxable" onChange={(e) => setTaxable(e.target.value)} />
          </label>
          <label className={field}>
            {t("pharmacyOffice.pay.credits.gst")}
            <input className={box} inputMode="decimal" placeholder="0.00" value={gst} data-testid="pay-credit-gst" onChange={(e) => setGst(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={interState} onChange={(e) => setInterState(e.target.checked)} />
            {t("pharmacyOffice.pay.credits.igst")}
          </label>
          <label className={field}>
            {t("pharmacyOffice.pay.credits.note")}
            <input className={box} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <p className="text-sm" data-testid="pay-credit-total">{t("pharmacyOffice.pay.credits.total", { amount: total === null ? "—" : rupees(total) })}</p>
        <p className="text-xs text-muted-foreground">{t("pharmacyOffice.pay.credits.setOff")}</p>
        <Button type="button" disabled={!ready} data-testid="pay-credit-save" onClick={() => void save()}>{t("pharmacyOffice.pay.credits.save")}</Button>
      </div>
    </Sheet>
  );
}
