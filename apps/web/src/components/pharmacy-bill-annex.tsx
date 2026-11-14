import { useTranslation } from "react-i18next";
import { strengthShown } from "../../../../packages/contracts/src/drug-strength";
import type { WireLabel } from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P10 — WHAT A CHEMIST'S BILL CARRIES THAT BILLING'S LINES DO NOT ═══
 *
 * An Indian retail pharmacy bill names each pack's batch and expiry, and the pharmacist who
 * dispensed it. The invoice lines are billing's: a service, a quantity, a price and its tax. So the
 * counter prints billing's own invoice and adds this annex from the dispense's label data. It is
 * read after the pick, so every line has its batch.
 */
/** Spec #1046 D5 — expiry as the pack prints it, MM/YY. */
const mmyy = (d: string | null): string => (d === null ? "" : `${d.slice(5, 7)}/${d.slice(2, 4)}`);

export function PharmacyBillAnnex({ label }: { label: WireLabel }): React.ReactElement {
  const { t } = useTranslation();
  const licence = label.licence ?? null;
  return (
    <div className="space-y-1 text-sm">
      {/* Spec #1046 D5 — the licence it sells under and who sold it, in the bill's header ("—" when none on record). */}
      <p className="text-xs" data-testid="bill-licence">
        {licence === null ? t("pharmacyBill.licenceNone") : t("pharmacyBill.licence", { form20: licence.form20No, form21: licence.form21No })}
      </p>
      {label.pharmacist !== undefined && label.pharmacist !== null && (
        <p className="text-xs" data-testid="bill-dispensed-by">
          {t("pharmacyBill.dispensedBy", { name: label.pharmacist.name })}
          {` · ${t("pharmacyBill.reg", { no: label.pharmacist.registrationNo ?? "—" })}`}
        </p>
      )}
      <p className="font-medium">{t("pharmacyBill.title")}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left">
            <th className="pr-2">{t("pharmacyBill.drug")}</th>
            <th className="pr-2">{t("pharmacyBill.batch")} · {t("pharmacyBill.expiry")}</th>
            <th className="pr-2">{t("pharmacyBill.manufacturer")}</th>
            <th className="text-right">{t("pharmacyBill.qty")}</th>
          </tr>
        </thead>
        <tbody>
          {label.lines.map((l) => (
            <tr key={l.lineIdx} data-testid={`bill-batch-${String(l.lineIdx)}`}>
              <td className="pr-2">
                {[l.drug, strengthShown(l.strength), l.form].filter((x): x is string => x !== null && x !== "").join(" ")}
                {l.substitutedFor !== null && ` ${t("pharmacyBill.substitutedFor", { brand: l.substitutedFor })}`}
                {/* Spec #1055 — a medicine added at the counter by hand says so, and why. */}
                {l.added == null ? null : (
                  <span className="block text-[11px]" data-testid={`bill-added-${String(l.lineIdx)}`}>
                    {t("pharmacyBill.added", { name: l.added.byName, reason: t(`pharmacyBill.addedReason.${l.added.reason}`) })}
                  </span>
                )}
              </td>
              {/* Walk 2026-11-13 — two bare columns printed "PCMW131108/28": the batch and its expiry, said apart in one cell. */}
              <td className="whitespace-nowrap pr-2" data-testid={`bill-batch-exp-${String(l.lineIdx)}`}>
                <span className="font-mono">{l.batchNo}</span>
                {l.expiryDate === null ? null : ` · ${t("pharmacyBill.expiry")} ${mmyy(l.expiryDate)}`}
              </td>
              <td className="pr-2">{l.manufacturer ?? ""}</td>
              <td className="text-right">{l.qtyBase} {l.unit}{l.packs !== null ? ` (${l.packs})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
