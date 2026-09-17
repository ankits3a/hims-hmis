import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { fmtIst, fmtPaise } from "../lib/format";
import {
  cancelCount, closeCount, fetchCount, fetchCountSheet, fetchCounts, fetchMyCounts, fetchStores, materialsErrorText,
  scheduleCount, submitCount,
} from "../lib/materials-api";
import { todayIst } from "../lib/opd-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WireCountHeader } from "../lib/materials-api";

/**
 * ═══ PLAN 14c, FIRST SLICE — STOCK COUNTS ═══
 *
 * Two halves on one screen, because the menu entry is the counter's (`materials.counts.perform`):
 *   - **My sheets.** The counter opens the sheet the system assigned: item, batch, expiry, and an
 *     empty box. Never the system's figure. Every box needs a number; a blank is not a zero. The
 *     time defaults to now and can be set back for a count done on paper (K8). The sheet prints
 *     blank for exactly that case.
 *   - **Counts** (the head, `materials.counts.manage`, a presentation check the server repeats):
 *     schedule a store, read each count with its variance, close a reviewed one, cancel one still
 *     being counted.
 * The server chooses the counter, and says who. Nothing here adjusts stock (runbook O1).
 */
const nowIstTime = (): string => fmtIst(new Date().toISOString());

function statusText(t: (k: string) => string, c: WireCountHeader): string {
  return t(`materialsCounts.s_${c.status}`);
}

export function MaterialsCounts(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const manager = can("materials.counts.manage");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [store, setStore] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [day, setDay] = useState(todayIst());
  const [time, setTime] = useState(nowIstTime());
  const [closing, setClosing] = useState("");
  const [cancelling, setCancelling] = useState("");

  const mine = useQuery({ queryKey: ["materials", "counts", "mine"], queryFn: fetchMyCounts });
  const all = useQuery({ queryKey: ["materials", "counts", "all"], queryFn: fetchCounts, enabled: manager });
  const stores = useQuery({ queryKey: ["materials", "stores"], queryFn: fetchStores, enabled: manager });
  const sheet = useQuery({ queryKey: ["materials", "counts", "sheet", sheetId], queryFn: () => fetchCountSheet(sheetId ?? ""), enabled: sheetId !== null });
  const review = useQuery({ queryKey: ["materials", "counts", "review", reviewId], queryFn: () => fetchCount(reviewId ?? ""), enabled: reviewId !== null });

  const act = async (fn: () => Promise<string>): Promise<void> => {
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
      await qc.invalidateQueries({ queryKey: ["materials", "counts"] });
    } catch (e) {
      setError(materialsErrorText(e, t));
    }
  };

  const lines = sheet.data?.lines ?? [];
  const complete = lines.length > 0 && lines.every((l) => /^\d+$/.test(qty[l.lineId] ?? ""));

  return (
    <div className="space-y-6 p-4">
      <style>{"@media print { body * { visibility: hidden; } .count-sheet, .count-sheet * { visibility: visible; } .count-sheet { position: absolute; left: 0; top: 0; width: 100%; } .count-sheet input { border: none; } }"}</style>
      <h1 className="text-xl font-semibold">{t("materialsCounts.title")}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("materialsCounts.intro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {note !== null && <p role="status" className="text-sm">{note}</p>}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t("materialsCounts.mine")}</h2>
        {mine.data !== undefined && mine.data.length === 0 && <p className="text-sm">{t("materialsCounts.noneMine")}</p>}
        <ul className="divide-y text-sm">
          {(mine.data ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <span>{c.storeName} <span className="text-xs text-muted-foreground">{c.storeCode}</span>{c.recountOf !== null ? ` · ${t("materialsCounts.recount")}` : ""}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => { setSheetId(c.id); setQty({}); setDay(todayIst()); setTime(nowIstTime()); }}>
                {t("materialsCounts.openSheet")}
              </Button>
            </li>
          ))}
        </ul>
        {sheetId !== null && sheet.data !== undefined && (
          <form
            className="space-y-2"
            data-testid="count-sheet"
            onSubmit={(ev) => {
              ev.preventDefault();
              const id = sheetId;
              void act(async () => {
                await submitCount(id, {
                  countedAt: new Date(`${day}T${time}:00+05:30`).toISOString(),
                  lines: lines.map((l) => ({ lineId: l.lineId, countedQty: Number(qty[l.lineId]) })),
                });
                setSheetId(null);
                return t("materialsCounts.submitted", { n: lines.length });
              });
            }}
          >
            <div className="count-sheet space-y-2">
              <p className="font-medium">{t("materialsCounts.sheetTitle", { store: sheet.data.storeName })}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="pr-3">{t("materialsCounts.item")}</th>
                      <th className="pr-3">{t("materialsCounts.batch")}</th>
                      <th className="pr-3">{t("materialsCounts.expiry")}</th>
                      <th className="pr-3">{t("materialsCounts.counted")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.lineId}>
                        <td className="pr-3">{l.itemName} <span className="text-xs text-muted-foreground">{l.itemCode}</span></td>
                        <td className="pr-3 font-mono">{l.batchNo}</td>
                        <td className="pr-3">{l.expiryDate ?? ""}</td>
                        <td className="pr-3">
                          <input
                            aria-label={t("materialsCounts.countedFor", { batch: l.batchNo })}
                            inputMode="numeric"
                            className="w-24 rounded border px-2 py-1"
                            value={qty[l.lineId] ?? ""}
                            onChange={(ev) => setQty({ ...qty, [l.lineId]: ev.target.value.replace(/\D/g, "") })}
                          /> {l.baseUom}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <label>{t("materialsCounts.countedOn")}
                <Input type="date" aria-label={t("materialsCounts.countedOn")} value={day} onChange={(e) => setDay(e.target.value)} className="w-40" />
              </label>
              <label>{t("materialsCounts.countedAt")}
                <Input type="time" aria-label={t("materialsCounts.countedAt")} value={time} onChange={(e) => setTime(e.target.value)} className="w-28" />
              </label>
              <Button type="button" variant="outline" onClick={() => window.print()}>{t("materialsCounts.printSheet")}</Button>
              <Button type="submit" disabled={!complete}>{t("materialsCounts.submit")}</Button>
            </div>
            {!complete && <p className="text-xs text-muted-foreground">{t("materialsCounts.fillAll")}</p>}
          </form>
        )}
      </section>

      {manager && (
        <section className="space-y-3" data-testid="count-manager">
          <h2 className="text-lg font-semibold">{t("materialsCounts.all")}</h2>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label>{t("materialsCounts.store")}
              <select aria-label={t("materialsCounts.store")} className="ml-2 rounded border px-2 py-1" value={store} onChange={(e) => setStore(e.target.value)}>
                <option value="">—</option>
                {(stores.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
              </select>
            </label>
            <Button
              type="button" disabled={store === ""}
              onClick={() => void act(async () => {
                const c = await scheduleCount(store);
                return t("materialsCounts.scheduled", { store: c.storeName, counter: c.counterName });
              })}
            >{t("materialsCounts.schedule")}</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="pr-3">{t("materialsCounts.store")}</th>
                  <th className="pr-3">{t("materialsCounts.status")}</th>
                  <th className="pr-3">{t("materialsCounts.counter")}</th>
                  <th className="pr-3">{t("materialsCounts.frozen")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(all.data ?? []).map((c) => (
                  <tr key={c.id} data-testid={`count-row-${c.id}`}>
                    <td className="pr-3">{c.storeName}{c.recountOf !== null ? ` · ${t("materialsCounts.recount")}` : ""}</td>
                    <td className="pr-3">{statusText(t, c)}</td>
                    <td className="pr-3">{c.counterName}</td>
                    <td className="pr-3">{todayIst(new Date(c.frozenAt))} {fmtIst(c.frozenAt)}</td>
                    <td><Button type="button" size="sm" variant="outline" onClick={() => { setReviewId(c.id); setClosing(""); setCancelling(""); }}>{t("materialsCounts.review")}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reviewId !== null && review.data !== undefined && (
            <div className="space-y-2 rounded border p-2" data-testid="count-review">
              <p className="font-medium">{review.data.storeName} · {statusText(t, review.data)} · {review.data.counterName}</p>
              <p className="text-sm" data-testid="count-totals">
                {t("materialsCounts.totals", {
                  lines: review.data.totals.lines, matched: review.data.totals.matched, variances: review.data.totals.variances,
                  recounts: review.data.totals.recounts, net: fmtPaise(review.data.totals.netVariancePaise),
                })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="pr-3">{t("materialsCounts.item")}</th>
                      <th className="pr-3">{t("materialsCounts.batch")}</th>
                      <th className="pr-3">{t("materialsCounts.system")}</th>
                      <th className="pr-3">{t("materialsCounts.moved")}</th>
                      <th className="pr-3">{t("materialsCounts.counted")}</th>
                      <th className="pr-3">{t("materialsCounts.variance")}</th>
                      <th className="pr-3">{t("materialsCounts.value")}</th>
                      <th className="pr-3">{t("materialsCounts.flag")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.data.lines.map((l) => (
                      <tr key={l.lineId} data-testid={`review-${l.batchNo}`} className={l.flag === "recount" ? "bg-red-50" : l.flag === "variance" ? "bg-amber-50" : ""}>
                        <td className="pr-3">{l.itemName}</td>
                        <td className="pr-3 font-mono">{l.batchNo}</td>
                        <td className="pr-3">{l.systemQty}</td>
                        <td className="pr-3">{l.movedQty ?? ""}</td>
                        <td className="pr-3">{l.countedQty ?? ""}</td>
                        <td className="pr-3">{l.varianceQty === null ? "" : l.varianceQty > 0 ? `+${String(l.varianceQty)}` : String(l.varianceQty)}</td>
                        <td className="pr-3">{l.variancePaise === null ? "" : fmtPaise(l.variancePaise)}</td>
                        <td className="pr-3">{l.flag === null ? "" : t(`materialsCounts.f_${l.flag}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {review.data.status === "submitted" && (
                <div className="flex flex-wrap items-end gap-2 text-sm">
                  <label>{t("materialsCounts.closeNote")}
                    <input aria-label={t("materialsCounts.closeNote")} className="ml-2 rounded border px-2 py-1" value={closing} onChange={(e) => setClosing(e.target.value)} />
                  </label>
                  <Button
                    type="button" size="sm" disabled={closing.trim() === ""}
                    onClick={() => { const id = reviewId; void act(async () => { await closeCount(id, closing.trim()); await qc.invalidateQueries({ queryKey: ["materials", "counts", "review", id] }); return t("materialsCounts.closed"); }); }}
                  >{t("materialsCounts.close")}</Button>
                </div>
              )}
              {review.data.status === "counting" && (
                <div className="flex flex-wrap items-end gap-2 text-sm">
                  <label>{t("materialsCounts.cancelReason")}
                    <input aria-label={t("materialsCounts.cancelReason")} className="ml-2 rounded border px-2 py-1" value={cancelling} onChange={(e) => setCancelling(e.target.value)} />
                  </label>
                  <Button
                    type="button" size="sm" variant="destructive" disabled={cancelling.trim().length < 3}
                    onClick={() => { const id = reviewId; void act(async () => { await cancelCount(id, cancelling.trim()); await qc.invalidateQueries({ queryKey: ["materials", "counts", "review", id] }); return t("materialsCounts.cancelled"); }); }}
                  >{t("materialsCounts.cancel")}</Button>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
