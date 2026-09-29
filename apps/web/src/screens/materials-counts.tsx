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
import { CountAdjustments } from "../components/count-adjustments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OfficeHead, fieldCls } from "./pharmacy-office/office-page";
import { Sheet } from "./pharmacy-office/sheet";
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
 *
 * Gap-closure B5: inside the office both halves are groups of one list, and a sheet to count and a
 * count to review open as sheets over it, as every page of the office does.
 */
const nowIstTime = (): string => fmtIst(new Date().toISOString());

function statusText(t: (k: string) => string, c: WireCountHeader): string {
  return t(`materialsCounts.s_${c.status}`);
}

/** A count's state as the board's pill: open work is gold, closed is pine, cancelled is plain. */
function countPill(status: string): string {
  if (status === "closed") return "pill on";
  if (status === "cancelled") return "pill";
  return "pill gd";
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
  /* B5 — one list: counts still open (counting, then submitted) above the settled ones. */
  const order: Record<string, number> = { counting: 0, submitted: 1, closed: 2, cancelled: 3 };
  const allCounts = [...(all.data ?? [])].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const inSheet = (sheetId !== null && sheet.data !== undefined) || (reviewId !== null && review.data !== undefined);
  const feedback = (
    <>
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {note !== null && <p role="status" className="text-sm text-green-700">{note}</p>}
    </>
  );
  const complete = lines.length > 0 && lines.every((l) => /^\d+$/.test(qty[l.lineId] ?? ""));

  return (
    <div className="space-y-4" data-testid="materials-counts">
      <style>{"@media print { body * { visibility: hidden; } .count-sheet, .count-sheet * { visibility: visible; } .count-sheet { position: absolute; left: 0; top: 0; width: 100%; } .count-sheet input { border: none; } }"}</style>
      <OfficeHead title={t("materialsCounts.title")} lead={t("materialsCounts.intro")} />
      {!inSheet && feedback}

      <div className="ofp-box">
      <section data-testid="count-mine">
        <h2 className="ofp-group ofp-label">{t("materialsCounts.mine")} · {mine.data?.length ?? "…"}</h2>
        {mine.data !== undefined && mine.data.length === 0 && <p className="ofp-empty">{t("materialsCounts.noneMine")}</p>}
        <ul className="ofp-rows">
          {(mine.data ?? []).map((c) => (
            <li key={c.id}>
              <span className="min-w-0 flex-1">{c.storeName} <span className="text-xs text-muted-foreground">{c.storeCode}</span>{c.recountOf !== null ? ` · ${t("materialsCounts.recount")}` : ""}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => { setSheetId(c.id); setQty({}); setDay(todayIst()); setTime(nowIstTime()); }}>
                {t("materialsCounts.openSheet")}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {manager && (
        <section data-testid="count-manager">
          <h2 className="ofp-group ofp-label">{t("materialsCounts.all")} · {all.data?.length ?? "…"}</h2>
          <div className="flex flex-wrap items-end gap-2 px-3 pb-3 text-sm">
            <label className="flex min-w-0 flex-col gap-1">{t("materialsCounts.store")}
              <select aria-label={t("materialsCounts.store")} className={`${fieldCls} w-64 max-w-full`} value={store} onChange={(e) => setStore(e.target.value)}>
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
          <div className="ofp-scroll">
            <table className="ofp-table min-w-[36rem]">
              <thead>
                <tr>
                  <th>{t("materialsCounts.store")}</th>
                  <th>{t("materialsCounts.status")}</th>
                  <th>{t("materialsCounts.counter")}</th>
                  <th>{t("materialsCounts.frozen")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {allCounts.map((c) => (
                  <tr key={c.id} data-testid={`count-row-${c.id}`}>
                    <td>{c.storeName}{c.recountOf !== null ? ` · ${t("materialsCounts.recount")}` : ""}</td>
                    <td><span className={countPill(c.status)}>{statusText(t, c)}</span></td>
                    <td>{c.counterName}</td>
                    <td>{todayIst(new Date(c.frozenAt))} {fmtIst(c.frozenAt)}</td>
                    <td className="text-right"><Button type="button" size="sm" variant="outline" onClick={() => { setReviewId(c.id); setClosing(""); setCancelling(""); }}>{t("materialsCounts.review")}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      </div>

        {sheetId !== null && sheet.data !== undefined && (
          <Sheet title={t("materialsCounts.sheetTitle", { store: sheet.data.storeName })} testId="count-sheet-panel" onClose={() => setSheetId(null)}>
          {feedback}
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
              <div className="ofp-box ofp-scroll">
                <table className="ofp-table min-w-[30rem]">
                  <thead>
                    <tr>
                      <th>{t("materialsCounts.item")}</th>
                      <th>{t("materialsCounts.batch")}</th>
                      <th>{t("materialsCounts.expiry")}</th>
                      <th>{t("materialsCounts.counted")}</th>
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
          </Sheet>
        )}
          {reviewId !== null && review.data !== undefined && (
            <Sheet title={`${review.data.storeName} · ${statusText(t, review.data)}`} testId="count-review-panel" onClose={() => setReviewId(null)}>
            {feedback}
            <div className="space-y-3" data-testid="count-review">
              <p className="font-medium">{review.data.storeName} · {statusText(t, review.data)} · {review.data.counterName}</p>
              <p className="text-sm" data-testid="count-totals">
                {t("materialsCounts.totals", {
                  lines: review.data.totals.lines, matched: review.data.totals.matched, variances: review.data.totals.variances,
                  recounts: review.data.totals.recounts, net: fmtPaise(review.data.totals.netVariancePaise),
                })}
              </p>
              <div className="ofp-box ofp-scroll">
                <table className="ofp-table min-w-[44rem]">
                  <thead>
                    <tr>
                      <th>{t("materialsCounts.item")}</th>
                      <th>{t("materialsCounts.batch")}</th>
                      <th>{t("materialsCounts.system")}</th>
                      <th>{t("materialsCounts.moved")}</th>
                      <th>{t("materialsCounts.counted")}</th>
                      <th>{t("materialsCounts.variance")}</th>
                      <th>{t("materialsCounts.value")}</th>
                      <th>{t("materialsCounts.flag")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.data.lines.map((l) => (
                      <tr key={l.lineId} data-testid={`review-${l.batchNo}`} className={l.flag === "recount" ? "bg-red-50" : l.flag === "variance" ? "bg-amber-50" : ""}>
                        <td>{l.itemName}</td>
                        <td className="ofp-code">{l.batchNo}</td>
                        <td>{l.systemQty}</td>
                        <td>{l.movedQty ?? ""}</td>
                        <td>{l.countedQty ?? ""}</td>
                        <td>{l.varianceQty === null ? "" : l.varianceQty > 0 ? `+${String(l.varianceQty)}` : String(l.varianceQty)}</td>
                        <td>{l.variancePaise === null ? "" : fmtPaise(l.variancePaise)}</td>
                        <td>{l.flag === null ? "" : t(`materialsCounts.f_${l.flag}`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <CountAdjustments review={review.data} />
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
            </Sheet>
          )}

    </div>
  );
}
