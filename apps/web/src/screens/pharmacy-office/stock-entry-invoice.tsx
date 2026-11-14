import { useTranslation } from "react-i18next";
import type { WireInvoiceHeader } from "../../lib/stock-entry-api";

/**
 * #1047 — THE SUPPLIER INVOICE'S HEADER over the stock-entry grid: the supplier (an active one, never the
 * hospital's own stock), the invoice number and date as printed, an optional purchase order of that supplier,
 * the store it is received into, and whether the rate column is WITH GST. The server judges it with the rows
 * (`POST /pharmacy/opening-stock/invoice/check`) and its reasons are shown here, with the supplier's unused credit
 * notes (#1061: they are still set off in the payment run).
 */
export function InvoiceHeaderForm({ header, onChange, suppliers, stores, orders, reasons, unusedCreditPaise = 0 }: {
  header: WireInvoiceHeader; onChange: (patch: Partial<WireInvoiceHeader>) => void;
  /** #1061 — the supplier's accepted credit notes not yet set off (0 when none). */
  unusedCreditPaise?: number;
  suppliers: { id: string; code: string; name: string }[]; stores: { id: string; code: string; name: string }[];
  /** The supplier's open orders; null when this reader may not list them (the PO is then left out). */
  orders: { id: string; poNo: string }[] | null;
  reasons: string[];
}): React.ReactElement {
  const { t } = useTranslation();
  const field = "flex flex-col gap-1 text-sm";
  const box = "rounded border px-2 py-1";
  return (
    <section className="space-y-2 rounded border p-3" aria-labelledby="se-invoice-title" data-testid="se-invoice-header">
      <h2 id="se-invoice-title" className="text-sm font-semibold">{t("stockEntry.invoice.title")}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={field}>
          {t("stockEntry.invoice.supplier")}
          <select className={box} value={header.vendorId ?? ""} data-testid="se-invoice-vendor"
            onChange={(e) => onChange({ vendorId: e.target.value === "" ? null : e.target.value, purchaseOrderId: null })}>
            <option value="">{t("stockEntry.invoice.choose")}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </label>
        <label className={field}>
          {t("stockEntry.invoice.number")}
          <input className={box} value={header.invoiceNo} maxLength={64} data-testid="se-invoice-no" onChange={(e) => onChange({ invoiceNo: e.target.value })} />
        </label>
        <label className={field}>
          {t("stockEntry.invoice.date")}
          <input className={box} type="date" value={header.invoiceDate} data-testid="se-invoice-date" onChange={(e) => onChange({ invoiceDate: e.target.value })} />
        </label>
        <label className={field}>
          {t("stockEntry.invoice.store")}
          <select className={box} value={header.storeResourceId ?? ""} data-testid="se-invoice-store"
            onChange={(e) => onChange({ storeResourceId: e.target.value === "" ? null : e.target.value })}>
            <option value="">{t("stockEntry.invoice.choose")}</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
          </select>
        </label>
        {orders !== null && (
          <label className={field}>
            {t("stockEntry.invoice.order")}
            <select className={box} value={header.purchaseOrderId ?? ""} disabled={header.vendorId === null} data-testid="se-invoice-po"
              onChange={(e) => onChange({ purchaseOrderId: e.target.value === "" ? null : e.target.value })}>
              <option value="">{t("stockEntry.invoice.noOrder")}</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.poNo}</option>)}
            </select>
          </label>
        )}
        <fieldset className={field}>
          <legend>{t("stockEntry.invoice.rateBasis")}</legend>
          <div className="flex flex-wrap gap-3">
            {([false, true] as const).map((withGst) => (
              <label key={String(withGst)} className="flex items-center gap-1">
                <input type="radio" name="se-rate-basis" checked={header.rateIncludesGst === withGst} data-testid={`se-rate-${withGst ? "with" : "without"}-gst`}
                  onChange={() => onChange({ rateIncludesGst: withGst })} />
                {t(withGst ? "stockEntry.invoice.withGst" : "stockEntry.invoice.withoutGst")}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {unusedCreditPaise > 0 && (
        <p role="note" className="text-sm text-amber-900" data-testid="se-invoice-credit">
          {t("stockEntry.invoice.unusedCredit", { amount: `₹${(unusedCreditPaise / 100).toFixed(2)}` })}
        </p>
      )}
      {reasons.length > 0 && (
        <ul className="text-sm text-red-700" data-testid="se-invoice-reasons">
          {reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </section>
  );
}
