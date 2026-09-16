import { useTranslation } from "react-i18next";
import type { WireLabel } from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P10 — WHAT A CHEMIST'S BILL CARRIES THAT BILLING'S LINES DO NOT ═══
 *
 * An Indian retail pharmacy bill names each pack's batch and expiry, and the pharmacist who
 * dispensed it. The invoice lines are billing's: a service, a quantity, a price and its tax. So the
 * counter prints billing's own invoice and adds this annex from the dispense's label data. It is
 * read after the pick, so every line has its batch.
 */
const mmyyyy = (d: string | null): string => (d === null ? "" : `${d.slice(5, 7)}/${d.slice(0, 4)}`);

export function PharmacyBillAnnex({ label }: { label: WireLabel }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{t("pharmacyBill.title")}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left">
            <th>{t("pharmacyBill.drug")}</th>
            <th>{t("pharmacyBill.batch")}</th>
            <th>{t("pharmacyBill.expiry")}</th>
            <th className="text-right">{t("pharmacyBill.qty")}</th>
          </tr>
        </thead>
        <tbody>
          {label.lines.map((l) => (
            <tr key={l.lineIdx} data-testid={`bill-batch-${String(l.lineIdx)}`}>
              <td>
                {[l.drug, l.strength, l.form].filter((x): x is string => x !== null && x !== "").join(" ")}
                {l.substitutedFor !== null && ` ${t("pharmacyBill.substitutedFor", { brand: l.substitutedFor })}`}
              </td>
              <td className="font-mono">{l.batchNo}</td>
              <td>{mmyyyy(l.expiryDate)}</td>
              <td className="text-right">{l.qtyBase} {l.unit}{l.packs !== null ? ` (${l.packs})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {label.pharmacist !== undefined && label.pharmacist !== null && (
        <p className="text-xs" data-testid="bill-dispensed-by">
          {t("pharmacyBill.dispensedBy", { name: label.pharmacist.name })}
          {label.pharmacist.registrationNo !== null && ` · ${t("pharmacyBill.reg", { no: label.pharmacist.registrationNo })}`}
        </p>
      )}
    </div>
  );
}
