import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PaperScreen } from "../components/paper-screen";
import { useAuth } from "../lib/auth";
import { fetchLinenBoard, fetchLinenLaundry, linenRefusal, newTapKey, releaseHoldApi, topUpToParApi } from "../lib/linen-api";
import type { LinenHoldCard, LinenWardState } from "@hmis/contracts";
import "./linen.css";

/**
 * ═══ LD-1 (#978, decision 0087) — THE LINEN STORE (desk, 16:9) ═══
 *
 * "Wards against par": par, on the shelf, due out today (planned discharges), beds waiting for linen, and Send — a
 * top-up to par. Wards with beds waiting come first, then the most short. Right: batches at the vendor and the holds.
 */
const TABS = [
  ["plant", "/linen/plant", "linen.plant"], ["store", "/linen/store", "linen.view"], ["rounds", "/linen/rounds", "linen.handle"], ["board", "/linen", "linen.view"],
  // LD-2 (#979) — the vendor desk and the uniform counter.
  ["vendor", "/linen/vendor", "linen.vendor"], ["uniforms", "/linen/uniforms", "linen.uniform"], ["setup", "/linen/setup", "linen.vendor"],
] as const;

/** The laundry desks' tab strip (plain links: each tab is its own route). */
export function LinenTabs({ on }: { on: (typeof TABS)[number][0] }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  return (
    <header className="lp-top">
      <span className="lp-mark" aria-hidden="true" />
      <b className="lp-brand">{t("linen.desk.brand")}</b>
      <nav aria-label={t("linen.desk.brand")}>
        {TABS.filter(([k, , p]) => k === on || can(p)).map(([k, to]) => (
          <a key={k} href={to} className={k === on ? "on" : ""} aria-current={k === on ? "page" : undefined}>{t(`linen.desk.tab.${k}`)}</a>
        ))}
      </nav>
    </header>
  );
}

export function LinenStore(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ["linen", "board"], queryFn: fetchLinenBoard, refetchInterval: 30_000 });
  const laundry = useQuery({ queryKey: ["linen", "laundry"], queryFn: fetchLinenLaundry, refetchInterval: 30_000 });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const send = useMutation({
    mutationFn: (wardId: string) => topUpToParApi(wardId, newTapKey()),
    onSuccess: () => { setNotice({ ok: true, text: t("linen.storeDesk.sent") }); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => setNotice({ ok: false, text: t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") }) }),
  });

  const due = new Map((laundry.data?.rush.wards ?? []).map((w) => [w.wardId, w.discharges]));
  const waiting = new Map<string, number>();
  for (const w of laundry.data?.bedsWaiting ?? []) waiting.set(w.wardId, (waiting.get(w.wardId) ?? 0) + 1);
  const sum = (w: LinenWardState, k: "par" | "onHand" | "short"): number => w.items.reduce((n, i) => n + i[k], 0);
  const wards = [...(board.data?.wards ?? [])].sort((a, b) =>
    (waiting.get(b.wardId) ?? 0) - (waiting.get(a.wardId) ?? 0) || b.shortPieces - a.shortPieces || a.wardName.localeCompare(b.wardName));
  const inPlant = new Set((laundry.data?.plant.queue ?? []).map((q) => q.batchId));
  const atVendor = (board.data?.inTransit ?? []).filter((b) => !inPlant.has(b.id));
  const fmt = (iso: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  return (
    <PaperScreen testId="linen-store" style={{ height: "var(--pp-h)" }}>
      <div className="lp-desk">
        <LinenTabs on="store" />
        <div className="lp-grid store">
          <section className="lp-centre">
            <div className="lp-title">
              <div><h1>{t("linen.storeDesk.title")}</h1><p>{t("linen.storeDesk.sub")}</p></div>
              {notice !== null && <p role="alert" className={notice.ok ? "ln-notice ok" : "ln-notice"} data-testid="store-notice">{notice.text}</p>}
            </div>
            <div className="box lp-table-box">
              <table className="lp-table" data-testid="store-wards">
                <thead>
                  <tr>
                    <th>{t("linen.storeDesk.col.ward")}</th><th>{t("linen.storeDesk.col.par")}</th><th>{t("linen.storeDesk.col.onShelf")}</th>
                    <th>{t("linen.storeDesk.col.dueOut")}</th><th>{t("linen.storeDesk.col.waiting")}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {wards.map((w) => {
                    const wait = waiting.get(w.wardId) ?? 0;
                    return (
                      <tr key={w.wardId} className={wait > 0 ? "hot" : ""} data-testid={`store-${w.wardId}`}>
                        <td><b>{w.wardName}</b>{w.floorName === null ? "" : <span className="ln-dim"> · {w.floorName}</span>}</td>
                        <td className="mono">{sum(w, "par")}</td>
                        <td className={`mono${w.belowPar ? " ln-err" : ""}`}>{sum(w, "onHand")}{w.belowPar ? ` · ${t("linen.board.short", { count: w.shortPieces })}` : ""}</td>
                        <td className="mono">{due.get(w.wardId) ?? "—"}</td>
                        <td className={`mono${wait > 0 ? " ln-err" : ""}`}>{wait}</td>
                        <td>
                          {w.belowPar && (
                            <button type="button" className={wait > 0 ? "ln-mini ok" : "ln-mini"} disabled={send.isPending} onClick={() => { setNotice(null); send.mutate(w.wardId); }} data-testid={`send-${w.wardId}`}>
                              {wait > 0 ? t("linen.storeDesk.sendRush") : t("linen.storeDesk.send")}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {board.data !== undefined && wards.length === 0 && <tr><td colSpan={6} className="ln-empty">{t("linen.board.noWards")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <aside className="lp-side">
            <section className="box" data-testid="store-vendor">
              <header className="lp-h"><b>{t("linen.storeDesk.atVendor")}</b><span className="mono">{atVendor.length}</span></header>
              {atVendor.map((b) => (
                <div key={b.id} className="lp-crow">
                  <div>
                    <b><span className="mono">{b.batchNo}</span> · {t("linen.board.pieces", { count: b.piecesSent })}</b>
                    <small>{b.infected && <span className="ln-tag inf">{t("linen.board.infectedBatch")}</span>} {t("linen.board.sentAt", { at: fmt(b.sentAt) })}{b.vendorName === null ? "" : ` · ${b.vendorName}`}</small>
                  </div>
                </div>
              ))}
              {board.data !== undefined && atVendor.length === 0 && <div className="ln-empty">{t("linen.board.noneAtLaundry")}</div>}
            </section>
            <section className="box" data-testid="store-holds">
              <header className="lp-h"><b>{t("linen.storeDesk.holds")}</b><span className="mono">{laundry.data?.holds.length ?? 0}</span></header>
              {(laundry.data?.holds ?? []).map((h) => <HoldRow key={h.id} h={h} />)}
              {laundry.data !== undefined && laundry.data.holds.length === 0 && <div className="ln-empty">{t("linen.storeDesk.noHolds")}</div>}
            </section>
          </aside>
        </div>
      </div>
    </PaperScreen>
  );
}

/**
 * A hold with its release, by its owner (the server checks again): MLC to the police receiver (name, rank, station);
 * radioactive by the RSO (anyone else is refused `not_rso`, shown as words); chemotherapy has no button — it ends by itself.
 * Release is offered only to holders of `linen.hold.release`.
 */
export function HoldRow({ h }: { h: LinenHoldCard }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [police, setPolice] = useState({ name: "", rank: "", station: "" });
  const [err, setErr] = useState<string | null>(null);
  const release = useMutation({
    mutationFn: () => releaseHoldApi(h.id, h.kind === "mlc" ? { name: police.name.trim(), rank: police.rank.trim(), station: police.station.trim() } : undefined),
    onSuccess: () => { setErr(null); setOpen(false); void qc.invalidateQueries({ queryKey: ["linen"] }); },
    onError: (e) => setErr(t(`linen.refusal.${linenRefusal(e) ?? "failed"}`, { defaultValue: t("linen.refusal.failed") })),
  });
  const mayRelease = can("linen.hold.release") && h.kind !== "chemo";
  const ends = h.releaseAfter === null ? "" : new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(h.releaseAfter));
  const filled = police.name.trim().length >= 2 && police.rank.trim().length >= 2 && police.station.trim().length >= 2;
  return (
    <div className="lp-crow col" data-testid={`hold-${h.id}`}>
      <div>
        <b>{t("linen.plant.holdRow", { bed: h.bedName, kind: t(`linen.hold.${h.kind}`) })}</b>
        <small>{h.kind === "chemo" ? t("linen.holds.endsAt", { at: ends }) : t("linen.plant.notLaundry")}</small>
        {err !== null && <small className="ln-err" role="alert">{err}</small>}
      </div>
      {mayRelease && h.kind === "radioactive" && (
        <button type="button" className="ln-mini" disabled={release.isPending} onClick={() => release.mutate()} data-testid={`release-${h.id}`}>{t("linen.holds.release")}</button>
      )}
      {mayRelease && h.kind === "mlc" && !open && (
        <button type="button" className="ln-mini" onClick={() => setOpen(true)} data-testid={`release-${h.id}`}>{t("linen.holds.toPolice")}</button>
      )}
      {mayRelease && h.kind === "mlc" && open && (
        <span className="lp-form" data-testid={`police-${h.id}`}>
          {(["name", "rank", "station"] as const).map((k) => (
            <label key={k}>{t(`linen.holds.police.${k}`)}<input value={police[k]} onChange={(e) => setPolice((p) => ({ ...p, [k]: e.target.value }))} data-testid={`police-${k}`} /></label>
          ))}
          <button type="button" className="ln-mini ok" disabled={!filled || release.isPending} onClick={() => release.mutate()} data-testid="police-go">{t("linen.holds.handOver")}</button>
          <button type="button" className="ln-mini" onClick={() => setOpen(false)}>{t("linen.plant.cancel")}</button>
        </span>
      )}
    </div>
  );
}
