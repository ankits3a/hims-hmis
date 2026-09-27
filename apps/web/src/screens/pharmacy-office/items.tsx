import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchItems, materialsErrorText } from "../../lib/materials-api";
import { PAIR_RULES, executeMerge, fetchMerge, fetchMergePreview, fetchOfficeItems, raiseMerge } from "../../lib/item-merge-api";
import { Button } from "@/components/ui/button";
import { Sheet } from "./sheet";
import type { WireDuplicate, WireMergeSide, WireMergeSummary } from "../../lib/item-merge-api";

/**
 * ═══ PHARMACY P6 (HYGIENE) — THE OFFICE'S ITEMS SIDE: ONE THING REGISTERED TWICE, MERGED ═══
 *
 * The office's sixth side, one screen like the others (`?view=items`, `materials.items.merge`). It opens
 * on the agent's list — pairs of live items that look like one thing twice (the same formulary medicine,
 * or near-identical names over the same composition) — and the merges in flight: waiting on the medical
 * superintendent, ready to merge, and the last ones done. Every row opens the MERGE SHEET:
 *
 *   - A (stays) and B (retired) side by side: class, base unit, medicine, packs, barcodes, stock;
 *   - what will MOVE (stock batch by batch, open orders, levels, barcodes, packs, the sale registration,
 *     the shelf label, the short book) and what STAYS (the history, written against B);
 *   - every reason it cannot go ahead now, split into "not one thing" and "finish this first";
 *   - S swaps which one stays; ⏎ in the reason submits it for the MS's approval; once granted, M merges.
 *     The sheet says a merge is not undone.
 *
 * Keys (the legend via `useScreenKeys`, set by the office): ↑/↓ move, ⏎ open, N pick two items yourself.
 */
type Open =
  | { kind: "pair"; survivorId: string; mergedId: string; source: "agent" | "manual" }
  | { kind: "merge"; merge: WireMergeSummary }
  | { kind: "pick" };

const rowCls = "flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none";

export function ItemsView(): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["pharmacy", "office", "items"], queryFn: fetchOfficeItems });
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const d = q.data;

  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing || open !== null || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === "n") { e.preventDefault(); setOpen({ kind: "pick" }); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-merge-row]") ?? []);
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[i < 0 ? 0 : e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
    e.preventDefault();
  };

  const dupRow = (x: WireDuplicate): React.ReactElement => (
    <button type="button" data-merge-row data-testid={`dup-row-${x.merged.code}`} className={rowCls}
      onClick={() => setOpen({ kind: "pair", survivorId: x.survivor.id, mergedId: x.merged.id, source: "agent" })}>
      <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-900">{t(`pharmacyOffice.items.why.${x.why}`)}</span>
      <span className="flex-1">
        <b>{x.survivor.name}</b> <span className="font-mono text-xs text-muted-foreground">{x.survivor.code}</span>
        <span className="mx-2 text-muted-foreground">←</span>
        {x.merged.name} <span className="font-mono text-xs text-muted-foreground">{x.merged.code}</span>
      </span>
      <span className="text-xs text-muted-foreground">{t("pharmacyOffice.items.onHandPair", { keep: x.survivor.onHandBase, merge: x.merged.onHandBase })}</span>
    </button>
  );
  const mergeRow = (m: WireMergeSummary): React.ReactElement => (
    <button type="button" data-merge-row data-testid={`merge-row-${m.merged.code}`} className={rowCls} onClick={() => setOpen({ kind: "merge", merge: m })}>
      <span className="flex-1"><b>{m.survivor.name}</b> <span className="mx-2 text-muted-foreground">←</span> {m.merged.name} <span className="font-mono text-xs text-muted-foreground">{m.merged.code}</span></span>
      <span className="max-w-xs truncate text-xs text-muted-foreground">{m.reason}</span>
      <span className="rounded bg-amber-100 px-1 text-xs text-amber-900">
        {m.status === "requested" ? t(`pharmacyOffice.items.approval.${m.approvalStatus}`, { defaultValue: m.approvalStatus }) : t(`pharmacyOffice.items.status.${m.status}`)}
      </span>
    </button>
  );

  return (
    <div className="space-y-5 focus:outline-none" tabIndex={-1} onKeyDown={onKey} data-testid="items-view">
      {q.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(q.error, t)}</p>}
      {notice !== null && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {d !== undefined && (
        <>
          <div className="grid gap-3 sm:grid-cols-3" data-testid="items-counts">
            {([["duplicates", d.duplicates.length], ["awaiting", d.awaitingApproval.length], ["ready", d.readyToMerge.length]] as const).map(([k, n]) => (
              <div key={k} className={`rounded border p-3 ${k === "ready" && n > 0 ? "border-amber-400" : ""}`} data-testid={`items-count-${k}`}>
                <div className="text-2xl font-semibold tabular-nums">{n}</div>
                <div className="text-xs text-muted-foreground">{t(`pharmacyOffice.items.count.${k}`)}</div>
              </div>
            ))}
          </div>

          <section className="rounded border border-emerald-700/40 bg-emerald-50/40 p-3" data-testid="items-agent">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-xs font-medium text-white">{t("pharmacyOffice.agent.tag")}</span>
              <span className="flex-1 text-sm">
                {d.duplicates.length === 0
                  ? t("pharmacyOffice.items.agent.nothing", { scanned: d.scanned })
                  : t("pharmacyOffice.items.agent.found", { count: d.duplicates.length, scanned: d.scanned })}
              </span>
              <Button type="button" variant="outline" onClick={() => setOpen({ kind: "pick" })}>
                {t("pharmacyOffice.items.pickTwo")} <kbd className="ml-1 rounded border px-1 text-xs">N</kbd>
              </Button>
            </div>
          </section>

          <div ref={listRef} className="space-y-4">
            <Rows title={t("pharmacyOffice.items.section.ready")} testId="items-section-ready" rows={d.readyToMerge} render={mergeRow} />
            <Rows title={t("pharmacyOffice.items.section.duplicates")} testId="items-section-duplicates" rows={d.duplicates} render={dupRow} />
            <Rows title={t("pharmacyOffice.items.section.awaiting")} testId="items-section-awaiting" rows={d.awaitingApproval} render={mergeRow} />
            <Rows title={t("pharmacyOffice.items.section.recent")} testId="items-section-recent" rows={d.recent} render={mergeRow} />
            {d.duplicates.length + d.awaitingApproval.length + d.readyToMerge.length + d.recent.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("pharmacyOffice.items.empty")}</p>
            )}
          </div>
        </>
      )}

      {open?.kind === "pair" && (
        <MergeSheet survivorId={open.survivorId} mergedId={open.mergedId} source={open.source} merge={null}
          onClose={() => setOpen(null)} onDone={(msg) => { setNotice(msg); setOpen(null); }}
          onSwap={() => setOpen({ ...open, survivorId: open.mergedId, mergedId: open.survivorId })} />
      )}
      {open?.kind === "merge" && (
        <MergeSheet survivorId={open.merge.survivor.id} mergedId={open.merge.merged.id} source={open.merge.source} merge={open.merge}
          onClose={() => setOpen(null)} onDone={(msg) => { setNotice(msg); setOpen(null); }} onSwap={null} />
      )}
      {open?.kind === "pick" && (
        <PickSheet onClose={() => setOpen(null)} onPicked={(survivorId, mergedId) => setOpen({ kind: "pair", survivorId, mergedId, source: "manual" })} />
      )}
    </div>
  );
}

function Rows<T>({ title, testId, rows, render }: { title: string; testId: string; rows: T[]; render: (r: T) => React.ReactElement }): React.ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <section data-testid={testId}>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="divide-y rounded border">{rows.map((r, i) => <li key={i}>{render(r)}</li>)}</ul>
    </section>
  );
}

function Side({ side, role }: { side: WireMergeSide; role: "stays" | "retired" }): React.ReactElement {
  const { t } = useTranslation();
  const med = side.medicine;
  return (
    <div className={`rounded border p-3 text-sm ${role === "stays" ? "border-emerald-600" : "border-red-300"}`} data-testid={`side-${role}`}>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t(`pharmacyOffice.items.side.${role}`)}</div>
      <div className="font-medium">{side.name} <span className="font-mono text-xs text-muted-foreground">{side.code}</span></div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.class")}</dt><dd>{side.itemClass}</dd>
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.medicine")}</dt>
        <dd>{med === null ? "—" : `${med.brandName}${med.strengthLabel === null ? "" : ` · ${med.strengthLabel}`} · ${med.form}`}</dd>
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.baseUom")}</dt><dd>{side.baseUom}</dd>
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.packs")}</dt><dd>{side.packs.filter((p) => p.multiplier > 1).map((p) => `${p.uom} × ${String(p.multiplier)}`).join(", ") || "—"}</dd>
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.barcodes")}</dt><dd>{side.barcodes.join(", ") || "—"}</dd>
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.onHand")}</dt><dd className="tabular-nums">{side.onHandBase} {side.baseUom}</dd>
        <dt className="text-muted-foreground">{t("pharmacyOffice.items.field.controlled")}</dt><dd>{side.controlled ? t("pharmacyOffice.items.yes") : t("pharmacyOffice.items.no")}</dd>
      </dl>
    </div>
  );
}

/**
 * THE MERGE SHEET — the preview for a pair (new), or the state of a raised merge (waiting, ready, done).
 * Nothing moves until the MS has approved and a person presses Merge now; the server asks every rule again.
 */
function MergeSheet({ survivorId, mergedId, source, merge, onClose, onDone, onSwap }: {
  survivorId: string; mergedId: string; source: "agent" | "manual"; merge: WireMergeSummary | null;
  onClose: () => void; onDone: (msg: string) => void; onSwap: (() => void) | null;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const done = merge?.status === "merged" || merge?.status === "refused";
  const preview = useQuery({ queryKey: ["pharmacy", "office", "merge-preview", survivorId, mergedId], queryFn: () => fetchMergePreview(survivorId, mergedId), enabled: !done });
  const current = useQuery({ queryKey: ["pharmacy", "office", "merge", merge?.id], queryFn: () => fetchMerge(merge!.id), enabled: merge !== null });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = preview.data;
  const m = current.data;
  const status = m?.status ?? merge?.status ?? null;
  const approval = m?.approval?.status ?? merge?.approvalStatus ?? null;
  const ready = status === "requested" && approval === "granted";
  const refusals = (p?.refusals ?? []).filter((r) => !(merge !== null && r.rule === "request_open"));
  const invalid = refusals.filter((r) => PAIR_RULES.includes(r.rule));
  const blocked = refusals.filter((r) => !PAIR_RULES.includes(r.rule));

  const act = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["pharmacy", "office"] });
      onDone(message);
    } catch (e) {
      setError(materialsErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const submit = (): void => {
    if (reason.trim().length < 3) { setError(t("pharmacyOffice.items.reasonNeeded")); return; }
    void act(() => raiseMerge({ survivorItemId: survivorId, mergedItemId: mergedId, reason: reason.trim(), source }), t("pharmacyOffice.items.submitted"));
  };
  const mergeNow = (): void => { if (merge !== null) void act(() => executeMerge(merge.id), t("pharmacyOffice.items.merged")); };

  const onKey = (e: React.KeyboardEvent): void => {
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
    if (typing || busy || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "s" || e.key === "S") && onSwap !== null) { e.preventDefault(); onSwap(); }
    if ((e.key === "m" || e.key === "M") && ready && refusals.length === 0) { e.preventDefault(); mergeNow(); }
  };

  const title = p === undefined ? (merge === null ? t("pharmacyOffice.sheet.loading") : `${merge.survivor.code} ← ${merge.merged.code}`) : `${p.survivor.code} ← ${p.merged.code}`;
  return (
    <Sheet title={t("pharmacyOffice.items.sheetTitle", { pair: title })} onClose={onClose} testId="merge-sheet" onKey={onKey}>
      <div className="space-y-4 text-sm">
        {preview.error !== null && <p role="alert" className="text-sm text-red-600">{materialsErrorText(preview.error, t)}</p>}
        {status !== null && (
          <p className="flex flex-wrap items-center gap-2" data-testid="merge-status">
            <span className="rounded bg-amber-100 px-1 text-xs text-amber-900">{status === "requested" ? t(`pharmacyOffice.items.approval.${approval ?? "pending"}`, { defaultValue: approval ?? "" }) : t(`pharmacyOffice.items.status.${status}`)}</span>
            <span className="text-muted-foreground">{merge?.reason}</span>
            {m?.approval?.decisionNote != null && <span className="text-xs text-muted-foreground">— {m.approval.decisionNote}</span>}
          </p>
        )}
        {p !== undefined && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <Side side={p.survivor} role="stays" />
              <Side side={p.merged} role="retired" />
            </div>
            {onSwap !== null && <Button type="button" variant="outline" onClick={onSwap}>{t("pharmacyOffice.items.swap")} <kbd className="ml-1 rounded border px-1 text-xs">S</kbd></Button>}

            {invalid.length > 0 && (
              <section className="rounded border border-red-400 bg-red-50 p-2" data-testid="merge-invalid">
                <h3 className="font-medium text-red-800">{t("pharmacyOffice.items.notOneThing")}</h3>
                <ul className="mt-1 list-disc pl-5 text-red-800">{invalid.map((r, i) => <li key={i} data-rule={r.rule}>{r.message}</li>)}</ul>
              </section>
            )}
            {blocked.length > 0 && (
              <section className="rounded border border-amber-400 bg-amber-50 p-2" data-testid="merge-blocked">
                <h3 className="font-medium text-amber-900">{t("pharmacyOffice.items.finishFirst")}</h3>
                <ul className="mt-1 list-disc pl-5 text-amber-900">{blocked.map((r, i) => <li key={i} data-rule={r.rule}>{r.message}</li>)}</ul>
              </section>
            )}

            <section data-testid="merge-moves">
              <h3 className="mb-1 font-medium">{t("pharmacyOffice.items.willMove")}</h3>
              {p.stock.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs" data-testid="merge-stock">
                    <thead><tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2">{t("pharmacyOffice.items.col.store")}</th><th className="py-1 pr-2">{t("pharmacyOffice.items.col.batch")}</th>
                      <th className="py-1 pr-2">{t("pharmacyOffice.items.col.expiry")}</th><th className="py-1 pr-2 text-right">{t("pharmacyOffice.items.col.qty")}</th>
                      <th className="py-1 pr-2">{t("pharmacyOffice.items.col.into")}</th>
                    </tr></thead>
                    <tbody>
                      {p.stock.map((s) => (
                        <tr key={`${s.storeResourceId}-${s.batchId}`} className="border-t">
                          <td className="py-1 pr-2">{s.storeName}</td><td className="py-1 pr-2 font-mono">{s.batchNo}</td><td className="py-1 pr-2">{s.expiryDate ?? "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{s.qtyBase} {p.merged.baseUom}</td><td className="py-1 pr-2">{t(`pharmacyOffice.items.into.${s.into}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <ul className="mt-1 space-y-0.5">
                {p.moves.filter((x) => x.count > 0 && x.key !== "stock").map((x) => (
                  <li key={x.key} data-testid={`move-${x.key}`}>{t(`pharmacyOffice.items.moves.${x.key}`, { count: x.count })}{x.detail.length > 0 && <span className="text-xs text-muted-foreground"> — {x.detail.join(", ")}</span>}</li>
                ))}
                {p.moves.every((x) => x.count === 0) && <li className="text-muted-foreground">{t("pharmacyOffice.items.nothingMoves")}</li>}
              </ul>
            </section>
            <section data-testid="merge-stays">
              <h3 className="mb-1 font-medium">{t("pharmacyOffice.items.stays")}</h3>
              <ul className="space-y-0.5 text-muted-foreground">
                {p.stays.filter((x) => x.count > 0).map((x) => <li key={x.key}>{t(`pharmacyOffice.items.stay.${x.key}`, { count: x.count })}</li>)}
              </ul>
            </section>
            <p className="rounded bg-muted p-2 text-xs" data-testid="merge-irreversible">{t("pharmacyOffice.items.irreversible")}</p>
          </>
        )}
        {m?.status === "merged" && m.moved !== null && (
          <p data-testid="merge-done" className="text-green-700">{t("pharmacyOffice.items.doneSummary", { units: Number(m.moved.unitsMoved ?? 0), by: m.names[m.mergedBy ?? ""] ?? "" })}</p>
        )}

        {error !== null && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {merge === null && p !== undefined && (
            <>
              <input className="min-w-64 flex-1 rounded border px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={t("pharmacyOffice.items.reason")} aria-label={t("pharmacyOffice.items.reason")} disabled={refusals.length > 0}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
              <Button type="button" disabled={busy || refusals.length > 0} onClick={submit}>{t("pharmacyOffice.items.submit")}</Button>
            </>
          )}
          {status === "requested" && approval === "pending" && <span className="text-muted-foreground">{t("pharmacyOffice.items.waitingOnMs")}</span>}
          {ready && (
            <Button type="button" disabled={busy || refusals.length > 0} onClick={mergeNow}>{t("pharmacyOffice.items.mergeNow")} <kbd className="ml-1 rounded border px-1 text-xs">M</kbd></Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Two items chosen by hand: search, pick the one that stays, then the duplicate. */
function PickSheet({ onClose, onPicked }: { onClose: () => void; onPicked: (survivorId: string, mergedId: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [keep, setKeep] = useState<{ id: string; code: string; name: string } | null>(null);
  const items = useQuery({ queryKey: ["materials", "items", "merge-pick", search], queryFn: () => fetchItems({ search }), enabled: search.trim().length >= 2 });
  const live = (items.data ?? []).filter((i) => i.active && (i.mergedIntoItemId ?? null) === null && i.id !== keep?.id);
  return (
    <Sheet title={t("pharmacyOffice.items.pickTitle")} onClose={onClose} testId="pick-sheet">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{keep === null ? t("pharmacyOffice.items.pickKeep") : t("pharmacyOffice.items.pickMerge", { keep: `${keep.name} (${keep.code})` })}</p>
        <input className="w-full rounded border px-2 py-1" autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t("pharmacyOffice.items.search")} aria-label={t("pharmacyOffice.items.search")} />
        <ul className="divide-y rounded border">
          {live.slice(0, 30).map((i) => (
            <li key={i.id}>
              <button type="button" className={rowCls} data-testid={`pick-${i.code}`}
                onClick={() => { if (keep === null) { setKeep({ id: i.id, code: i.code, name: i.name }); setSearch(""); } else onPicked(keep.id, i.id); }}>
                <span className="flex-1">{i.name}</span><span className="font-mono text-xs text-muted-foreground">{i.code}</span><span className="text-xs">{i.class}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
