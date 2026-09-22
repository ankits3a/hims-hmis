import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fmtIst, fmtPaise } from "../lib/format";
import { todayIst } from "../lib/opd-api";
import { fetchLeakage, pharmacyErrorText } from "../lib/pharmacy-api";
import { Input } from "@/components/ui/input";
import type { LeakageStore } from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P12 — THE LEAKAGE TRIANGLE ═══
 *
 * Doc 16 I1's Leakage Auditor, as a read for the billing supervisor and the owner
 * (`billing.reports.read`). One day at one counter's store (P19b: the OPD counter's or the walk-in
 * counter's): stock that left against a bill that no longer pays for it, stock that left with no
 * dispense or sale, and what the blind counts found. It names dispense and bill numbers, never
 * patients.
 */
const STORES: readonly LeakageStore[] = ["PHARM-OPD", "PHARM-RETAIL"];
const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n));

export function PharmacyLeakage(): React.ReactElement {
  const { t } = useTranslation();
  const [day, setDay] = useState(todayIst());
  const [store, setStore] = useState<LeakageStore>("PHARM-OPD");
  const report = useQuery({ queryKey: ["pharmacy", "leakage", store, day], queryFn: () => fetchLeakage(day, store), enabled: /^\d{4}-\d{2}-\d{2}$/.test(day) });
  const r = report.data;
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("pharmacyLeakage.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyLeakage.intro")}</p>
      <div className="flex flex-wrap items-center gap-4">
        <label className="text-sm">
          {t("pharmacyLeakage.store")}
          <select aria-label={t("pharmacyLeakage.store")} className="ml-2 rounded border px-2 py-1" value={store} onChange={(e) => setStore(e.target.value as LeakageStore)}>
            {STORES.map((code) => <option key={code} value={code}>{t(`pharmacyLeakage.store_${code}`)}</option>)}
          </select>
        </label>
        <label className="text-sm">
          {t("pharmacyLeakage.day")}
          <Input type="date" aria-label={t("pharmacyLeakage.day")} value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />
        </label>
      </div>
      {report.error !== null && <p role="alert" className="text-sm text-red-700">{pharmacyErrorText(report.error, t)}</p>}
      {r !== undefined && (
        <>
          <p className="text-sm">{t("pharmacyLeakage.dispensed", { lines: r.dispensed.lines, units: r.dispensed.units })}</p>
          <p className="text-sm font-medium" data-testid="leakage-summary">
            {t("pharmacyLeakage.summary", {
              units: r.summary.unbilledUnits, value: fmtPaise(r.summary.unbilledPaise), other: r.summary.otherUnits,
              count: signed(r.summary.countVarianceUnits), countValue: fmtPaise(r.summary.countVariancePaise),
            })}
          </p>

          <section className="space-y-1">
            <h2 className="font-semibold">{t("pharmacyLeakage.mismatches")}</h2>
            {r.mismatches.length === 0 ? <p className="text-sm">{t("pharmacyLeakage.noMismatch")}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      {(["dispense", "item", "batch", "issued", "returned", "billed", "credited", "unbilled", "value"] as const).map((k) => <th key={k} className="pr-3">{t(`pharmacyLeakage.${k}`)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {r.mismatches.map((m) => {
                      const ref = m.dispenseNo ?? m.invoiceNo ?? m.dispenseId ?? m.saleId ?? "";
                      return (
                      <tr key={`${ref}-${m.itemCode}-${m.batchNo}`} data-testid={`leak-${ref}`} className="bg-red-50">
                        <td className="pr-3">
                          {m.source !== undefined && m.source !== "dispense" && <><span className="text-xs">{t(`pharmacyLeakage.source_${m.source}`)}</span>{" "}</>}
                          <span className="whitespace-nowrap font-mono">{ref}</span>
                        </td>
                        <td className="pr-3">{m.itemCode}</td>
                        <td className="pr-3 font-mono">{m.batchNo}</td>
                        <td className="pr-3">{m.issued}</td>
                        <td className="pr-3">{m.returned}</td>
                        <td className="pr-3">{m.billed}</td>
                        <td className="pr-3">{m.credited}</td>
                        <td className="pr-3 font-medium">{m.unbilledUnits}</td>
                        <td className="pr-3">{fmtPaise(m.unbilledPaise)}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-1">
            <h2 className="font-semibold">{t("pharmacyLeakage.other")}</h2>
            {r.otherConsumption.length === 0 ? <p className="text-sm">{t("pharmacyLeakage.noOther")}</p> : (
              <ul className="text-sm" data-testid="leak-other">
                {r.otherConsumption.map((c, i) => (
                  <li key={i}>
                    {fmtIst(c.occurredAt)} · {c.itemCode} · {t("pharmacyLeakage.batch")} {c.batchNo} · {c.units} {t("pharmacyLeakage.units")} · {t("pharmacyLeakage.ref")} {c.refType ?? "—"}{c.refId !== null ? ` ${c.refId}` : ""} · {t("pharmacyLeakage.by")} {c.actorName ?? c.actorId}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-1">
            <h2 className="font-semibold">{t("pharmacyLeakage.counted")}</h2>
            {r.counted.counts === 0 ? <p className="text-sm">{t("pharmacyLeakage.noCount")}</p> : (
              <ul className="text-sm" data-testid="leak-counted">
                {r.counted.lines.map((l) => (
                  <li key={`${l.countId}-${l.batchNo}`}>{l.itemCode} · {t("pharmacyLeakage.batch")} {l.batchNo} · {t("pharmacyLeakage.variance")} {signed(l.varianceQty)} ({fmtPaise(l.variancePaise)})</li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
