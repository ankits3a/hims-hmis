import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchReorderAdvice, pharmacyErrorText } from "../lib/pharmacy-api";
import { Button } from "@/components/ui/button";
import type { WireReorderLine } from "../lib/pharmacy-api";

/**
 * ═══ PHARMACY P4 — THE REORDER LIST ═══
 *
 * Doc 16 §9's Replenishment, drafting tier: the server says what the counter will run out of and
 * which store holds it; people act. "Print requisition" prints the lines with a suggestion, which
 * is what a pharmacist walks to the main store with today. The two-sided issue happens in
 * materials, by the storekeeper, as it always has.
 *
 * P8 adds the shelf's other risk below the list: batches that will expire before the counter's pace
 * sells them (send them back while there is time), and stock already past its date (quarantine).
 */
const TONE: Record<WireReorderLine["status"], string> = {
  stock_out: "bg-red-100 text-red-800", reorder: "bg-amber-100 text-amber-900", ok: "bg-green-50 text-green-800", no_movement: "bg-muted text-muted-foreground",
};

export function PharmacyReorder(): React.ReactElement {
  const { t } = useTranslation();
  const advice = useQuery({ queryKey: ["pharmacy", "reorder"], queryFn: fetchReorderAdvice });
  const w = advice.data?.window;
  return (
    <div className="space-y-4 p-4">
      <style>{"@media print { body * { visibility: hidden; } .reorder-print, .reorder-print * { visibility: visible; } .reorder-print { position: absolute; left: 0; top: 0; } .reorder-print .no-need { display: none; } }"}</style>
      <h1 className="text-xl font-semibold">{t("pharmacyReorder.title")}</h1>
      {w !== undefined && (
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("pharmacyReorder.intro", { days: w.days, min: w.minCoverDays, target: w.targetCoverDays })}
        </p>
      )}
      {advice.error !== null && <p role="alert" className="text-sm text-red-600">{pharmacyErrorText(advice.error, t)}</p>}
      {advice.data !== undefined && advice.data.items.length === 0 && <p className="text-sm">{t("pharmacyReorder.none")}</p>}
      {advice.data !== undefined && advice.data.items.length > 0 && (
        <>
          <Button type="button" variant="outline" onClick={() => window.print()}>{t("pharmacyReorder.print")}</Button>
          <div className="reorder-print overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="py-1 pr-3">{t("pharmacyReorder.item")}</th>
                  <th className="py-1 pr-3">{t("pharmacyReorder.status")}</th>
                  <th className="py-1 pr-3">{t("pharmacyReorder.available")}</th>
                  <th className="py-1 pr-3">{t("pharmacyReorder.used", { days: w?.days ?? 30 })}</th>
                  <th className="py-1 pr-3">{t("pharmacyReorder.cover")}</th>
                  <th className="py-1 pr-3">{t("pharmacyReorder.suggest")}</th>
                  <th className="py-1 pr-3">{t("pharmacyReorder.source")}</th>
                </tr>
              </thead>
              <tbody>
                {advice.data.items.map((l) => (
                  <tr key={l.itemId} data-testid={`reorder-${l.code}`} className={l.suggestBase === 0 ? "no-need" : ""}>
                    <td className="py-1 pr-3">{l.name} <span className="text-xs text-muted-foreground">{l.code}</span></td>
                    <td className="py-1 pr-3"><span className={`rounded px-1 text-xs ${TONE[l.status]}`}>{t(`pharmacyReorder.${l.status}`)}</span></td>
                    <td className="py-1 pr-3">{l.available} {l.baseUom}</td>
                    <td className="py-1 pr-3">{l.usedInWindow}</td>
                    <td className="py-1 pr-3">
                      {l.daysOfCover === null ? t("pharmacyReorder.noCover") : l.daysOfCover}
                      {l.unsoldByExpiry > 0 && (
                        <span className="block text-xs text-amber-800">{t("pharmacyReorder.unsoldHint", { n: l.unsoldByExpiry })}</span>
                      )}
                    </td>
                    <td className="py-1 pr-3">{l.suggestBase === 0 ? "" : `${String(l.suggestBase)} ${l.baseUom}${l.suggestPacks !== null ? ` (${l.suggestPacks})` : ""}`}</td>
                    <td className="py-1 pr-3">
                      {l.suggestBase === 0 ? "" : l.source === null
                        ? t("pharmacyReorder.purchase")
                        : t("pharmacyReorder.sourceHas", { store: l.source.storeName, n: l.source.available })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {advice.data !== undefined && w !== undefined && (
        <section className="space-y-2" data-testid="reorder-expiring">
          <h2 className="text-lg font-semibold">{t("pharmacyReorder.expiringTitle", { days: w.nearExpiryDays })}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyReorder.expiringIntro")}</p>
          {advice.data.expiring.length === 0
            ? <p className="text-sm">{t("pharmacyReorder.noneExpiring", { days: w.nearExpiryDays })}</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="py-1 pr-3">{t("pharmacyReorder.item")}</th>
                      <th className="py-1 pr-3">{t("pharmacyReorder.batch")}</th>
                      <th className="py-1 pr-3">{t("pharmacyReorder.expiry")}</th>
                      <th className="py-1 pr-3">{t("pharmacyReorder.daysLeft")}</th>
                      <th className="py-1 pr-3">{t("pharmacyReorder.available")}</th>
                      <th className="py-1 pr-3">{t("pharmacyReorder.unsold")}</th>
                      <th className="py-1 pr-3">{t("pharmacyReorder.action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {advice.data.expiring.map((e) => (
                      <tr key={e.batchId} data-testid={`expiring-${e.batchNo}`}>
                        <td className="py-1 pr-3">{e.name} <span className="text-xs text-muted-foreground">{e.code}</span></td>
                        <td className="py-1 pr-3">{e.batchNo}</td>
                        <td className="py-1 pr-3">{e.expiryDate}</td>
                        <td className="py-1 pr-3">{e.daysLeft === 0 ? t("pharmacyReorder.lastDay") : e.daysLeft}</td>
                        <td className="py-1 pr-3">{e.available} {e.baseUom}</td>
                        <td className="py-1 pr-3">{e.unsoldByExpiry === 0 ? "" : `${String(e.unsoldByExpiry)} ${e.baseUom}`}</td>
                        <td className="py-1 pr-3">
                          <span className={`rounded px-1 text-xs ${e.action === "move_back" ? "bg-amber-100 text-amber-900" : "bg-green-50 text-green-800"}`}>
                            {t(`pharmacyReorder.${e.action}`)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </section>
      )}
      {advice.data !== undefined && advice.data.expiredOnShelf.length > 0 && (
        <section className="space-y-2" data-testid="reorder-expired">
          <h2 className="text-lg font-semibold text-red-700">{t("pharmacyReorder.expiredTitle")}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("pharmacyReorder.expiredIntro")}</p>
          <ul className="text-sm">
            {advice.data.expiredOnShelf.map((e) => (
              <li key={e.batchId} data-testid={`expired-${e.batchNo}`}>
                {e.name} <span className="text-xs text-muted-foreground">{e.code}</span> · {t("pharmacyReorder.batch")} {e.batchNo} · {t("pharmacyReorder.expiry")} {e.expiryDate} · {t("pharmacyReorder.onHand")} {e.onHand} {e.baseUom}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
