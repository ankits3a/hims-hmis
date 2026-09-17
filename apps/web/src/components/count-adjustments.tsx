import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtPaise } from "../lib/format";
import { fetchAdjustments, materialsErrorText, postAdjustment, requestAdjustment } from "../lib/materials-api";
import { Button } from "@/components/ui/button";
import type { AdjustmentReason, WireCountReview } from "../lib/materials-api";

/**
 * ═══ PLAN 14c, SECOND SLICE — BOOKING A COUNT'S VARIANCE, WITH A SECOND KEY ═══
 *
 * The materials head picks the variance lines, gives each a reason and asks. The medical
 * superintendent decides in the approvals inbox. Once it is granted, the head books it here. A line
 * flagged for recount is booked from the recount, so it offers no box. Nothing on this panel moves
 * stock except "Book".
 */
const LOSS: AdjustmentReason[] = ["shrinkage", "damage", "expiry", "entry_error"];
const GAIN: AdjustmentReason[] = ["found", "entry_error"];

export function CountAdjustments({ review }: { review: WireCountReview }): React.ReactElement | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Record<string, AdjustmentReason>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const booked = useQuery({ queryKey: ["materials", "counts", "adjustments", review.id], queryFn: () => fetchAdjustments(review.id), enabled: review.status === "submitted" || review.status === "closed" });
  if (review.status !== "submitted" && review.status !== "closed") return null;
  const live = new Set((booked.data ?? []).filter((a) => a.status !== "refused").map((a) => a.countLineId));
  const candidates = review.lines.filter((l) => l.flag === "variance" && !live.has(l.lineId));
  const chosen = candidates.filter((l) => picked[l.lineId] !== undefined);
  const net = chosen.reduce((s, l) => s + (l.variancePaise ?? 0), 0);
  const refresh = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ["materials", "counts", "adjustments", review.id] }); };
  const act = async (fn: () => Promise<string>): Promise<void> => {
    setError(null); setDone(null);
    try { setDone(await fn()); await refresh(); } catch (e) { setError(materialsErrorText(e, t)); }
  };
  const approvals = [...new Set((booked.data ?? []).filter((a) => a.status === "requested" && a.approvalStatus !== "pending").map((a) => a.approvalId))];

  return (
    <div className="space-y-2 border-t pt-2" data-testid="count-adjustments">
      <p className="font-medium">{t("materialsCounts.adjustTitle")}</p>
      <p className="max-w-3xl text-xs text-muted-foreground">{t("materialsCounts.adjustIntro")}</p>
      {error !== null && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {done !== null && <p role="status" className="text-sm">{done}</p>}
      {candidates.length > 0 && (
        <div className="space-y-1 text-sm">
          {candidates.map((l) => {
            const reasons = (l.varianceQty ?? 0) < 0 ? LOSS : GAIN;
            return (
              <label key={l.lineId} className="flex flex-wrap items-center gap-2" data-testid={`adjust-${l.batchNo}`}>
                <input
                  type="checkbox" aria-label={t("materialsCounts.adjustLine", { batch: l.batchNo })}
                  checked={picked[l.lineId] !== undefined}
                  onChange={(e) => setPicked((cur) => {
                    const next = { ...cur };
                    if (e.target.checked) next[l.lineId] = reasons[0]!; else delete next[l.lineId];
                    return next;
                  })}
                />
                <span>{l.itemName} · {l.batchNo} · {(l.varianceQty ?? 0) > 0 ? "+" : ""}{l.varianceQty} ({fmtPaise(l.variancePaise ?? 0)})</span>
                {picked[l.lineId] !== undefined && (
                  <select aria-label={t("materialsCounts.adjustReason", { batch: l.batchNo })} className="rounded border px-1" value={picked[l.lineId]}
                    onChange={(e) => setPicked((cur) => ({ ...cur, [l.lineId]: e.target.value as AdjustmentReason }))}>
                    {reasons.map((r) => <option key={r} value={r}>{t(`materialsCounts.reason_${r}`)}</option>)}
                  </select>
                )}
              </label>
            );
          })}
          <label>{t("materialsCounts.adjustNote")}
            <input aria-label={t("materialsCounts.adjustNote")} className="ml-2 rounded border px-2 py-1" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div>
            <Button type="button" size="sm" disabled={chosen.length === 0}
              onClick={() => void act(async () => {
                await requestAdjustment(review.id, { lines: chosen.map((l) => ({ lineId: l.lineId, reasonCode: picked[l.lineId]! })), ...(note.trim() === "" ? {} : { note: note.trim() }) });
                setPicked({}); setNote("");
                return t("materialsCounts.adjustAsked");
              })}
            >{t("materialsCounts.adjustAsk", { count: chosen.length, net: fmtPaise(net) })}</Button>
          </div>
        </div>
      )}
      {(booked.data ?? []).length > 0 && (
        <ul className="text-sm">
          {(booked.data ?? []).map((a) => (
            <li key={a.id} data-testid={`adjustment-${a.batchNo}`}>
              {a.itemCode} · {a.batchNo} · {a.qtyDelta > 0 ? "+" : ""}{a.qtyDelta} ({fmtPaise(a.valuePaise)}) · {t(`materialsCounts.reason_${a.reasonCode}`)} · {t(`materialsCounts.adj_${a.status}`)}{a.status === "requested" ? ` · ${t(`materialsCounts.appr_${a.approvalStatus}`, { defaultValue: a.approvalStatus })}` : ""}
            </li>
          ))}
        </ul>
      )}
      {approvals.map((id) => (
        <Button key={id} type="button" size="sm" variant="outline"
          onClick={() => void act(async () => {
            const r = await postAdjustment(id);
            return r.posted > 0 ? t("materialsCounts.adjustBooked", { count: r.posted }) : t("materialsCounts.adjustRefused", { count: r.refused });
          })}
        >{t("materialsCounts.adjustBook")}</Button>
      ))}
    </div>
  );
}
