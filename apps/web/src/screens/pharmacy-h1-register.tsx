import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { fetchH1Register, pharmacyErrorText } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * ═══ PHARMACY P9 — THE SCHEDULE H1 REGISTER ═══
 *
 * Drugs and Cosmetics Rules 1945 r.65(3A): the prescriber, the patient, the drug and the quantity of
 * every Schedule H1 supply, kept three years and produced to an inspector. Hand-over writes it; this
 * screen reads a month of it and prints it. The printed sheet carries the rule, the period, a line
 * for the drug licence number and the pharmacist's signature, because that is the paper an
 * inspector takes away.
 */
function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** YYYY-MM-DD → DD-MM-YYYY, the way a register is written. */
const dmy = (d: string): string => d.split("-").reverse().join("-");

export function PharmacyH1Register(): React.ReactElement {
  const { t } = useTranslation();
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  const { from, to } = monthBounds(month);
  const reg = useQuery({ queryKey: ["pharmacy", "h1", from, to], queryFn: () => fetchH1Register(from, to), enabled: /^\d{4}-\d{2}$/.test(month) });
  const rows = reg.data?.rows ?? [];
  return (
    <div className="space-y-4 p-4">
      <style>{"@media print { body * { visibility: hidden; } .h1-print, .h1-print * { visibility: visible; } .h1-print { position: absolute; left: 0; top: 0; width: 100%; } }"}</style>
      <h1 className="text-xl font-semibold">{t("pharmacyH1.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyH1.intro")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          {t("pharmacyH1.month")}
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" data-testid="h1-month" />
        </label>
        <Button type="button" variant="outline" onClick={() => window.print()} disabled={rows.length === 0}>{t("pharmacyH1.print")}</Button>
      </div>
      {reg.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(reg.error, t)}</p>}
      {rows.some((r) => r.restricted) && <p className="max-w-3xl text-xs text-amber-800">{t("pharmacyH1.sealedNote")}</p>}
      {reg.data !== undefined && rows.length === 0 && <p className="text-sm">{t("pharmacyH1.none")}</p>}
      {rows.length > 0 && (
        <div className="h1-print space-y-2">
          <div className="text-sm">
            <p className="font-semibold">{t("pharmacyH1.title")} · {t("pharmacyH1.rule")}</p>
            <p>{t("pharmacyH1.period", { from: dmy(from), to: dmy(to) })}</p>
            <p>{t("pharmacyH1.licence")}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left">
                  {(["sno", "when", "patient", "prescriber", "drug", "batch", "qty", "pharmacist"] as const).map((k) => (
                    <th key={k} className="border px-2 py-1">{t(`pharmacyH1.${k}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.entryNo} data-testid={`h1-row-${String(r.entryNo)}`}>
                    <td className="border px-2 py-1">{r.entryNo}</td>
                    <td className="border px-2 py-1">{dmy(todayIst(new Date(r.dispensedAt)))} {fmtIst(r.dispensedAt)}</td>
                    <td className="border px-2 py-1">
                      {r.patientName}
                      {r.restricted && <span className="ml-1 text-amber-800">({t("pharmacyH1.sealed")})</span>}
                      {r.patientAddress !== null && <span className="block text-muted-foreground">{r.patientAddress}</span>}
                    </td>
                    <td className="border px-2 py-1">{r.prescriberName}{r.prescriberRegNo !== null ? `, ${r.prescriberRegNo}` : ""}</td>
                    <td className="border px-2 py-1">{r.drugName}</td>
                    <td className="border px-2 py-1">{r.batchNo}</td>
                    <td className="border px-2 py-1">{r.qtyBase} {r.unit}</td>
                    <td className="border px-2 py-1">{r.pharmacistRegNo ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pt-6 text-sm">{t("pharmacyH1.signature")}</p>
        </div>
      )}
    </div>
  );
}
