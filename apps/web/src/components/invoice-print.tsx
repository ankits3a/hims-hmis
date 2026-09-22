import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { billingPatientLabel } from "../lib/billing-api";
import { fmtPaise } from "../lib/format";
import { Button } from "@/components/ui/button";
import type { WireInvoicePrint } from "../lib/billing-api";

/**
 * The printed invoice (Plan 08 T13 / K40). Props are the `GET /billing/invoices/:id/print` wire
 * shape verbatim: the ONE hospital letterhead, the alias-safe patient summary, the STORED lines and
 * their stored heads, the derived settlement, the §170 rounding line and the signed QR.
 *
 * THE DUES STAMP IS DERIVED, NOT STORED. `invoices` has no status column at all — that absence is
 * what keeps the immutability triggers total (D1) — so the banner reads `settlement.outstandingPaise`
 * and nothing else. The legacy system's four-state paid/partial/due/void enum is reduced to this
 * one derived line; a screen that stamped DUES from a persisted field would be printing a number
 * the ledger no longer agrees with.
 *
 * NOTHING IS RECOMPUTED HERE. Every figure is rendered as the server sent it (the §15 rule the
 * whole module is built on): the invoice's `cgstPaise`/`sgstPaise` are sums of the LINE heads, and
 * a client-side fold over the lines would post a different number for exactly the fixtures the
 * plan's Book was written to catch.
 *
 * `.print-doc` isolation (styles.css) makes this the only element that reaches the paper, so a
 * screen that mounts it MUST keep it mutually exclusive with any other `.print-doc` surface — the
 * TokenSlip/RxPrint precedent, and the counter screen honours it by REPLACING itself with the print.
 */
/**
 * `annex` — PHARMACY P10: a module's own block printed inside the same document, after the lines
 * (the counter's batch and expiry per pack). Absent everywhere else, so every other caller prints
 * exactly what it printed before.
 */
/**
 * ═══ WHAT THE DOCUMENT IS, AND WHO ISSUED IT (2026-09-17) ═══
 *
 * CGST Rules r.46 (tax invoice), r.49 (bill of supply) and r.46A (invoice-cum-bill of supply):
 * - The title follows the lines. All exempt (a consultation) is a BILL OF SUPPLY, all taxable (a
 *   strip of medicine) is a TAX INVOICE, and a mix is an INVOICE-CUM-BILL OF SUPPLY.
 * - The supplier is named with its legal name, GSTIN and state, from the letterhead.
 * - A registered buyer's GSTIN is printed.
 * - The document ends with the authorised signatory.
 *
 * Nothing is printed for a GSTIN the letterhead does not carry; the readiness census reports that
 * gap instead (`supplier_gstin_on_invoice`).
 */
export function documentTitleKey(lines: readonly { exempt: boolean }[]): "taxInvoice" | "billOfSupply" | "invoiceCumBill" {
  const exempt = lines.filter((l) => l.exempt).length;
  if (exempt === 0) return "taxInvoice";
  return exempt === lines.length ? "billOfSupply" : "invoiceCumBill";
}

export function InvoicePrint({ data, annex }: { data: WireInvoicePrint; annex?: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const { invoice, settlement, letterhead } = data;
  const outstanding = settlement.outstandingPaise > 0;
  const supplierState = data.supplierState ?? null;

  return (
    <div className="space-y-3">
      <div className="print-doc w-[640px] space-y-2 rounded-lg border p-4">
        <header className="space-y-1 border-b pb-2">
          <h2 className="text-lg font-bold">{letterhead.name}</h2>
          {letterhead.legalName !== undefined && (
            <p className="text-xs" data-testid="invoice-legal-name">{t("billing.print.unitOf", { legalName: letterhead.legalName })}</p>
          )}
          {letterhead.addressLines.map((line) => (
            <p key={line} className="text-xs text-neutral-600">{line}</p>
          ))}
          {letterhead.gstin !== undefined && (
            <p className="font-mono text-xs" data-testid="invoice-supplier-gstin">
              {t("billing.print.gstin")}: {letterhead.gstin}
              {supplierState !== null && ` · ${t("billing.print.state", { name: supplierState.name, code: supplierState.code })}`}
            </p>
          )}
          <p className="pt-1 text-center text-sm font-semibold uppercase tracking-wide" data-testid="invoice-title">
            {t(`billing.print.${documentTitleKey(data.lines)}`)}
          </p>
        </header>

        <section className="grid grid-cols-2 gap-1 border-b py-2 text-sm">
          <p data-testid="invoice-no" className="font-mono">{t("billing.print.invoiceNo")}: {invoice.invoiceNo}</p>
          <p data-testid="invoice-day">{t("billing.print.date")}: {invoice.serviceDay}</p>
          <p data-testid="invoice-patient">{billingPatientLabel(data.patient)}</p>
          <p className="font-mono text-xs">{t("billing.print.uhid")}: {data.patient?.uhid ?? "—"}</p>
          {invoice.buyerGstin !== null && (
            <p className="col-span-2 text-xs" data-testid="invoice-buyer-gstin">
              {t("billing.print.buyer", { name: invoice.buyerLegalName ?? "" })} · {t("billing.print.gstin")}: <span className="font-mono">{invoice.buyerGstin}</span>
            </p>
          )}
        </section>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>{t("billing.print.service")}</th>
              <th className="text-right">{t("billing.print.qty")}</th>
              <th className="text-right">{t("billing.print.gross")}</th>
              <th className="text-right">{t("billing.print.discount")}</th>
              <th className="text-right">{t("billing.print.tax")}</th>
              <th className="text-right">{t("billing.print.net")}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.id} data-testid={`invoice-line-${String(line.lineNo)}`}>
                <td>
                  {line.serviceName}
                  <span className="block font-mono text-xs text-neutral-600">
                    {t("billing.print.sac")} {line.sacCode}
                    {line.exempt ? ` · ${t("billing.print.exempt")}` : ` · ${String(line.rateBps / 100)}%`}
                  </span>
                </td>
                <td className="text-right tabular-nums">{line.qty}</td>
                <td className="text-right tabular-nums">{fmtPaise(line.grossPaise)}</td>
                <td className="text-right tabular-nums">{fmtPaise(line.discountPaise)}</td>
                <td className="text-right tabular-nums">{fmtPaise(line.cgstPaise + line.sgstPaise)}</td>
                <td className="text-right tabular-nums">{fmtPaise(line.netPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {annex !== undefined && <section className="border-t pt-2" data-testid="invoice-annex">{annex}</section>}

        <section className="space-y-1 border-t pt-2 text-sm">
          <p data-testid="invoice-gross">{t("billing.print.grossTotal")}: {fmtPaise(invoice.grossPaise)}</p>
          <p data-testid="invoice-discount">{t("billing.print.discountTotal")}: {fmtPaise(invoice.discountPaise)}</p>
          <p data-testid="invoice-taxable">{t("billing.print.taxableBase")}: {fmtPaise(invoice.taxableBasePaise)}</p>
          <p data-testid="invoice-cgst">{t("billing.print.cgst")}: {fmtPaise(invoice.cgstPaise)}</p>
          <p data-testid="invoice-sgst">{t("billing.print.sgst")}: {fmtPaise(invoice.sgstPaise)}</p>
          {/* §170's single rupee rounding, printed because a bill that does not show it is queried. */}
          <p data-testid="invoice-rounding">{t("billing.print.rounding")}: {fmtPaise(invoice.roundingPaise)}</p>
          <p data-testid="invoice-net" className="text-base font-semibold">
            {t("billing.print.netPayable")}: {fmtPaise(invoice.netPayablePaise)}
          </p>
        </section>

        <section className="flex items-end justify-between border-t pt-2">
          <div className="space-y-1 text-sm">
            <p data-testid="invoice-settlement">
              {t("billing.print.settlement")}: {t(`billing.settlement.${settlement.state}`)}
            </p>
            {outstanding && (
              <p data-testid="invoice-dues-stamp" className="text-base font-bold text-red-700">
                {t("billing.print.duesStamp", { amount: fmtPaise(settlement.outstandingPaise) })}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <QRCodeSVG value={data.qrPayload} size={96} />
            <p className="text-xs" data-testid="invoice-signatory">
              {t("billing.print.signatory", { legalName: letterhead.legalName ?? letterhead.name })}
            </p>
          </div>
        </section>
      </div>
      <Button type="button" className="no-print" onClick={() => window.print()}>
        {t("billing.print.print")}
      </Button>
    </div>
  );
}
