import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { openImages, radiologyErrorCode, radiologyErrorText } from "../lib/radiology-api";
import { needsSecondFactor, verifySecondFactor } from "../lib/radiology-reading-api";
import {
  FOLLOWUP_CHANNELS, FOLLOWUP_CLOSE_REASONS, PEER_SCORES, bookFollowup, closeFollowup, fetchFollowups, fetchPeerBoard,
  fetchPeerCase, fetchTeleBoard, markFollowupNotified, overreadNightRead, scorePeerCase,
} from "../lib/radiology-reading-room-api";
import { RadiologyStation } from "./radiology-station";
import type {
  FollowupChannel, FollowupCloseReason, OverreadGrade, PeerScore, WireFollowup, WirePeerBoard, WireTeleBoard, WireTeleRow,
} from "../lib/radiology-reading-room-api";

/**
 * PLAN 18-S RS8c T4 — **THE READING ROOM, PART 3** (board: Reading room → Follow-ups · Peer review ·
 * Night & outside). Three header views of `/radiology/read` (`?view=followups|peer|tele`), each on
 * the station shell in the owner's layout: the thing in hand in the left lane, the work in the centre
 * with ONE next act in the sticky dock (Enter runs it), ONE list on the right with no filter tabs, and
 * "Clocks running" collapsed. The most urgent row is in hand on the first frame.
 *
 *   · **Follow-ups** — overdue first; the dock books the study (a holder of the ordering grant — the
 *     treating doctor or the desk) or, for the reading room, records that the doctor was told; a row
 *     closes with one of five reasons and a line.
 *   · **Peer review** — my queue of blind cases (never my own, never a name); RADPEER score, learning
 *     case, a line for any discrepancy; agreement by reader over 90 days.
 *   · **Night & outside** — the partner's prelims waiting for the morning over-read: concur, minor or
 *     major (the correction is signed under my second factor and released in the same act); the
 *     discrepancy log; outside films to read.
 */

const dayWord = (d: string): string =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const timeWord = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** The dock: one act, Enter runs it outside a text box. */
function Dock({ hint, label, run, testId }: { hint: string; label: string; run: (() => void) | null; testId: string }): React.ReactElement {
  const ref = useRef<(() => void) | null>(null);
  ref.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (e.key === "Enter" && !["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag) && ref.current !== null) {
        e.preventDefault(); ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid={`${testId}-dock`}>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{hint}</span>
      <button
        type="button" data-testid={`${testId}-dock-act`} disabled={run === null} onClick={() => run?.()}
        className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {label} <span className="kb">Enter</span>
      </button>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "warn" | "ok" }): React.ReactElement {
  const color = tone === "danger" ? "text-red-700" : tone === "warn" ? "text-amber-800" : tone === "ok" ? "text-green-800" : "";
  return (
    <div className="min-w-0 rounded border bg-card p-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={`mo text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Refusal({ error }: { error: { code: string | null; text: string } | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (error === null) return null;
  return (
    <p role="alert" data-refusal={error.code ?? "unknown"} className="m-0 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
      {error.text}
      {error.code === "encounter_closed" && <> · <a className="underline" href="/radiology/reception">{t("radiology.fu.fixVisit")}</a></>}
      {error.code === "tele_reader_prelim_only" && <> · <a className="underline" href="/radiology/read?view=tele">{t("radiology.tele.fixReader")}</a></>}
    </p>
  );
}

const failOf = (e: unknown) => ({ code: radiologyErrorCode(e), text: radiologyErrorText(e) });

/* ═══════════════════════════════ T1 — Follow-ups ═══════════════════════════════ */

const FU_TONE: Record<string, string> = { open: "text-red-700", notified: "text-amber-800", booked: "text-green-800", closed: "text-muted-foreground" };

export function FollowupsView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canBook = can("radiology.orders.place");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["radiology", "reading", "followups"], queryFn: fetchFollowups, refetchInterval: 60_000 });
  const rows = q.data?.rows ?? [];
  const [inHand, setInHand] = useState<string | null>(null);
  const row = rows.find((r) => r.followupId === inHand) ?? rows.find((r) => r.state !== "closed" && r.state !== "booked") ?? rows[0] ?? null;
  const live = rows.filter((r) => r.state !== "closed");
  const overdue = rows.filter((r) => r.overdue);
  const tiles = q.data?.tiles;

  const list = (
    <section aria-label={t("radiology.fu.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.fu.listTitle")} · {live.length}</h2>
      <ul className="m-0 list-none space-y-1 p-0" data-testid="fu-list">
        {rows.map((r) => (
          <li key={r.followupId} data-fu={r.followupId} data-state={r.overdue ? "overdue" : r.state}>
            <button
              type="button" aria-current={r.followupId === row?.followupId ? "true" : undefined} onClick={() => setInHand(r.followupId)}
              className={`w-full rounded border bg-card p-2 text-left text-sm ${r.followupId === row?.followupId ? "border-green-700" : ""} ${r.state === "closed" ? "opacity-60" : ""}`}
            >
              <span className="flex justify-between gap-2">
                <b className="min-w-0 truncate">{r.patientName}</b>
                <span className={`mo shrink-0 text-xs ${r.overdue ? "font-bold text-red-700" : FU_TONE[r.state] ?? ""}`}>
                  {r.overdue ? t("radiology.fu.overdue") : t(`radiology.fu.state.${r.state}`)}
                </span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">{t(`radiology.fu.source.${r.source}`)} · {t("radiology.fu.dueOn", { day: dayWord(r.dueOn) })}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length === 0 && !q.isPending && <p className="text-sm text-muted-foreground">{t("radiology.fu.none")}</p>}
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="fu-clocks">
      {overdue.map((r) => <li key={r.followupId}>{t("radiology.fu.clockLine", { name: r.patientName, what: t(`radiology.fu.source.${r.source}`), day: dayWord(r.dueOn) })}</li>)}
      {overdue.length === 0 && <li className="text-muted-foreground">{t("radiology.fu.clocksQuiet")}</li>}
    </ul>
  );

  return (
    <RadiologyStation
      station="read" views={views}
      title={row === null ? t("radiology.fu.title") : `${row.patientName} · ${t(`radiology.fu.source.${row.source}`)}`}
      place={t("radiology.fu.place")}
      stats={[
        { label: t("radiology.fu.tile.open"), value: tiles?.open ?? 0 },
        { label: t("radiology.fu.tile.overdue"), value: tiles?.overdue ?? 0, tone: "danger" },
        { label: t("radiology.fu.state.open"), value: tiles?.notActed ?? 0, tone: "danger" },
      ]}
      lane={row === null
        ? <p className="mt-4 text-sm text-muted-foreground">{t("radiology.fu.nobody")}</p>
        : (
          <div className="mt-4 space-y-2 text-sm" data-testid="fu-in-hand">
            <span className="tag">{t("radiology.fu.inHand")}</span>
            <p className="m-0 text-base font-semibold">{row.patientName}</p>
            <p className="m-0 mo text-xs">{row.uhid} · {row.accessionNo}</p>
            <p className="m-0 text-xs">{row.studyName}</p>
            {row.signedAt !== null && <p className="m-0 text-xs">{t("radiology.fu.signedAt", { at: timeWord(row.signedAt) })}</p>}
            <p className="m-0 text-xs">{t("radiology.fu.doctor", { name: row.treatingDoctor ?? t("radiology.fu.noDoctor") })}</p>
          </div>
        )}
      list={list}
      listSummary={t("radiology.fu.listSummary", { count: live.length, over: overdue.length })}
      inHand={row !== null}
      closeListOn={inHand}
      clocks={clocks}
      clocksAlert={overdue.length > 0}
      clocksSummary={overdue.length > 0 ? t("radiology.fu.clocksSummary", { count: overdue.length }) : t("radiology.fu.clocksQuiet")}
    >
      <div className="flex min-h-full flex-col gap-3" data-testid="followups">
        <p className="m-0 text-sm">{t("radiology.fu.why")}</p>
        {/* The lane's stats carry open / overdue / not acted; the centre carries only what they do not (UX 4). */}
        <div className="grid grid-cols-2 gap-2">
          <Tile label={t("radiology.fu.tile.onTime")} value={tiles?.closedOnTime90 == null ? "—" : `${tiles.closedOnTime90}%`} tone="ok" />
          <Tile label={t("radiology.fu.tile.month")} value={tiles?.recommendedThisMonth ?? "—"} />
        </div>
        {q.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(q.error)}</p>}
        {q.isPending && <p>{t("common.loading")}</p>}
        {row !== null
          ? <FollowupCard key={row.followupId} row={row} canBook={canBook} onDone={() => { void qc.invalidateQueries({ queryKey: ["radiology", "reading", "followups"] }); }} />
          : !q.isPending && <p className="text-sm text-muted-foreground">{t("radiology.fu.none")}</p>}
      </div>
    </RadiologyStation>
  );
}

function FollowupCard({ row, canBook, onDone }: { row: WireFollowup; canBook: boolean; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<FollowupChannel>("phone");
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState<FollowupCloseReason>("done_elsewhere");
  const [closeNote, setCloseNote] = useState("");
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ok = (msg: string) => { setError(null); setDone(msg); onDone(); };
  const book = useMutation({ mutationFn: () => bookFollowup(row.followupId), onSuccess: (r) => ok(t("radiology.fu.booked", { orderNo: r.orderNo })), onError: (e) => setError(failOf(e)) });
  const tell = useMutation({ mutationFn: () => markFollowupNotified(row.followupId, { channel, note: notice.trim() || null }), onSuccess: () => ok(t("radiology.fu.toldDone")), onError: (e) => setError(failOf(e)) });
  const close = useMutation({ mutationFn: () => closeFollowup(row.followupId, { reason, note: closeNote.trim() }), onSuccess: () => ok(t("radiology.fu.closedDone")), onError: (e) => setError(failOf(e)) });
  const acting = row.state === "open" || row.state === "notified";

  const dock = !acting
    ? { label: t("radiology.fu.dock.nothing"), hint: row.state === "booked" ? t("radiology.fu.dock.bookedHint", { orderNo: row.booked?.orderNo ?? "" }) : t("radiology.fu.dock.closedHint"), run: null }
    : canBook
      ? { label: t("radiology.fu.dock.book", { name: row.patientName.split(" ")[0] }), hint: t("radiology.fu.dock.bookHint"), run: book.isPending ? null : () => book.mutate() }
      : row.state === "open"
        ? { label: t("radiology.fu.dock.told"), hint: t("radiology.fu.dock.toldHint"), run: tell.isPending ? null : () => tell.mutate() }
        : { label: t("radiology.fu.dock.close"), hint: t("radiology.fu.dock.closeHint"), run: closeNote.trim().length >= 4 && !close.isPending ? () => close.mutate() : null };

  return (
    <article className="flex flex-1 flex-col gap-3 rounded border bg-card p-3 text-sm" data-testid={`fu-${row.followupId}`}>
      <header className="flex flex-wrap items-baseline gap-2">
        <b className="text-base">{row.recommendation}</b>
        <span className={`text-xs font-semibold ${row.overdue ? "text-red-700" : FU_TONE[row.state] ?? ""}`}>
          {row.overdue ? t("radiology.fu.overdue") : t(`radiology.fu.state.${row.state}`)}
        </span>
      </header>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("radiology.fu.rule")}</dt><dd className="m-0">{t(`radiology.fu.source.${row.source}`)} · {row.intervalLabel}</dd>
        <dt className="text-muted-foreground">{t("radiology.fu.due")}</dt><dd className="m-0 mo">{dayWord(row.dueOn)}</dd>
        {row.notified !== null && (<><dt className="text-muted-foreground">{t("radiology.fu.told")}</dt>
          <dd className="m-0">{t(`radiology.fu.channel.${row.notified.channel}`)} · {row.notified.by ?? "—"} · {timeWord(row.notified.at)}{row.notified.note ? ` — ${row.notified.note}` : ""}</dd></>)}
        {row.booked !== null && (<><dt className="text-muted-foreground">{t("radiology.fu.bookedAs")}</dt><dd className="m-0 mo">{row.booked.orderNo} · {timeWord(row.booked.at)}</dd></>)}
        {row.closed !== null && (<><dt className="text-muted-foreground">{t("radiology.fu.closedAs")}</dt>
          <dd className="m-0">{t(`radiology.fu.reason.${row.closed.reason}`)}{row.closed.note ? ` — ${row.closed.note}` : ""}</dd></>)}
      </dl>
      {!canBook && acting && <p className="m-0 text-xs text-muted-foreground" data-testid="fu-who-books">{t("radiology.fu.whoBooks", { name: row.treatingDoctor ?? t("radiology.fu.noDoctor") })}</p>}
      {done !== null && <p role="status" className="m-0 text-sm text-green-800">{done}</p>}
      <Refusal error={error} />
      {acting && (
        <div className="grid gap-3 md:grid-cols-2">
          {row.state === "open" && (
            <fieldset className="m-0 space-y-2 rounded border p-2">
              <legend className="px-1 text-xs font-semibold">{t("radiology.fu.tellTitle")}</legend>
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t("radiology.fu.tellTitle")}>
                {FOLLOWUP_CHANNELS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)}
                    className={`rounded border px-2 py-1 text-xs ${channel === c ? "border-green-800 bg-green-50 font-semibold" : ""}`}>
                    {t(`radiology.fu.channel.${c}`)}
                  </button>
                ))}
              </div>
              <input className="w-full rounded border px-2 py-1 text-sm" value={notice} maxLength={500} placeholder={t("radiology.fu.tellNote")} onChange={(e) => setNotice(e.target.value)} />
              {canBook && <button type="button" className="rounded border px-2 py-1 text-xs" disabled={tell.isPending} onClick={() => tell.mutate()}>{t("radiology.fu.dock.told")}</button>}
              <p className="m-0 text-xs text-muted-foreground">{t("radiology.fu.noSend")}</p>
            </fieldset>
          )}
          <fieldset className="m-0 space-y-2 rounded border p-2">
            <legend className="px-1 text-xs font-semibold">{t("radiology.fu.closeTitle")}</legend>
            <select className="w-full rounded border bg-card px-2 py-1 text-sm" value={reason} onChange={(e) => setReason(e.target.value as FollowupCloseReason)} aria-label={t("radiology.fu.closeTitle")}>
              {FOLLOWUP_CLOSE_REASONS.map((r) => <option key={r} value={r}>{t(`radiology.fu.reason.${r}`)}</option>)}
            </select>
            <input className="w-full rounded border px-2 py-1 text-sm" value={closeNote} maxLength={500} placeholder={t("radiology.fu.closeNote")} onChange={(e) => setCloseNote(e.target.value)} />
            {!(dock.label === t("radiology.fu.dock.close")) && (
              <button type="button" className="rounded border px-2 py-1 text-xs" disabled={closeNote.trim().length < 4 || close.isPending} onClick={() => close.mutate()}>{t("radiology.fu.dock.close")}</button>
            )}
          </fieldset>
        </div>
      )}
      <Dock testId="fu" {...dock} />
    </article>
  );
}

/* ═══════════════════════════════ T2 — Peer review ═══════════════════════════════ */

const SCORE_TONE: Record<string, string> = { "1": "text-green-800", "2a": "text-amber-800", "2b": "text-amber-800", "3a": "text-red-700", "3b": "text-red-700", "4a": "text-red-700", "4b": "text-red-700" };

export function PeerView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["radiology", "reading", "peer"], queryFn: fetchPeerBoard });
  const board: WirePeerBoard | undefined = q.data;
  const queue = board?.queue ?? [];
  const [inHand, setInHand] = useState<string | null>(null);
  const current = queue.find((c) => c.reviewId === inHand) ?? queue[0] ?? null;
  const overdue = queue.filter((c) => c.ageDays > 14);

  const list = (
    <section aria-label={t("radiology.peer.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.peer.listTitle")} · {queue.length}</h2>
      <ul className="m-0 list-none space-y-1 p-0" data-testid="peer-list">
        {queue.map((c, i) => (
          <li key={c.reviewId} data-review={c.reviewId}>
            <button type="button" aria-current={c.reviewId === current?.reviewId ? "true" : undefined} onClick={() => setInHand(c.reviewId)}
              className={`w-full rounded border bg-card p-2 text-left text-sm ${c.reviewId === current?.reviewId ? "border-green-700" : ""}`}>
              <span className="flex justify-between gap-2">
                <b className="min-w-0 truncate">{t("radiology.peer.caseNo", { n: i + 1 })} · {c.studyTypeName}</b>
                <span className={`mo shrink-0 text-xs ${c.ageDays > 14 ? "font-bold text-red-700" : ""}`}>{t("radiology.peer.age", { count: c.ageDays })}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">{t(`radiology.peer.trigger.${c.trigger}`)}</span>
            </button>
          </li>
        ))}
      </ul>
      {queue.length === 0 && !q.isPending && <p className="text-sm text-muted-foreground">{t("radiology.peer.none")}</p>}
    </section>
  );

  return (
    <RadiologyStation
      station="read" views={views}
      title={current === null ? t("radiology.peer.title") : `${t("radiology.peer.blindCase")} · ${current.studyTypeName}`}
      place={t("radiology.peer.place")}
      stats={[
        { label: t("radiology.peer.tile.queue"), value: queue.length },
        { label: t("radiology.peer.tile.overdue"), value: board?.tiles.overdue ?? 0, tone: "danger" },
      ]}
      lane={current === null
        ? <p className="mt-4 text-sm text-muted-foreground">{t("radiology.peer.nobody")}</p>
        : (
          <div className="mt-4 space-y-2 text-sm" data-testid="peer-in-hand">
            <span className="tag">{t("radiology.peer.inHand")}</span>
            <p className="m-0 text-base font-semibold">{current.studyTypeName}</p>
            <p className="m-0 text-xs">{t(`radiology.peer.trigger.${current.trigger}`)}</p>
            <p className="m-0 text-xs text-muted-foreground">{t("radiology.peer.blindNote")}</p>
          </div>
        )}
      list={list}
      listSummary={t("radiology.peer.listSummary", { count: queue.length })}
      inHand={current !== null}
      closeListOn={inHand}
      clocks={<ul className="m-0 list-none p-0 text-sm">{overdue.length === 0 ? <li className="text-muted-foreground">{t("radiology.peer.clocksQuiet")}</li> : overdue.map((c) => <li key={c.reviewId}>{t("radiology.peer.clockLine", { study: c.studyTypeName, days: c.ageDays })}</li>)}</ul>}
      clocksAlert={overdue.length > 0}
      clocksSummary={overdue.length > 0 ? t("radiology.peer.clocksSummary", { count: overdue.length }) : t("radiology.peer.clocksQuiet")}
    >
      <div className="flex min-h-full flex-col gap-3" data-testid="peer-review">
        <p className="m-0 text-sm">{t("radiology.peer.why")}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Tile label={t("radiology.peer.tile.sampled")} value={board === undefined ? "—" : `${board.tiles.sampledThisMonth} + ${board.tiles.triggeredThisMonth}`} />
          <Tile label={t("radiology.peer.tile.agreement")} value={board?.tiles.agreementPct == null ? "—" : `${board.tiles.agreementPct}%`} tone="ok" />
          <Tile label={t("radiology.peer.tile.significant")} value={board?.tiles.significantThisMonth ?? "—"} tone="danger" />
        </div>
        {q.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(q.error)}</p>}
        {current !== null && <PeerCaseCard key={current.reviewId} reviewId={current.reviewId} onDone={() => { setInHand(null); void qc.invalidateQueries({ queryKey: ["radiology", "reading", "peer"] }); }} />}
        {board !== undefined && board.readers.length > 0 && (
          <section className="rounded border bg-card p-3" data-testid="peer-agreement">
            <h3 className="m-0 mb-2 text-sm font-semibold">{t("radiology.peer.agreementTitle")}</h3>
            {board.readers.map((r) => (
              <div key={r.readerId} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
                <span className="truncate">{r.readerName}</span>
                <span className="h-2 overflow-hidden rounded bg-muted"><i className={`block h-2 ${ (r.agreementPct ?? 0) < 96 ? "bg-amber-600" : "bg-green-700"}`} style={{ width: `${Math.max(0, Math.min(100, ((r.agreementPct ?? 0) - 80) * 5))}%` }} /></span>
                <span className="mo">{r.agreementPct ?? "—"}% · {r.scored}</span>
              </div>
            ))}
            <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.peer.agreementNote")}</p>
          </section>
        )}
        {board !== undefined && board.recent.length > 0 && (
          <section className="rounded border bg-card p-3" data-testid="peer-recent">
            <h3 className="m-0 mb-2 text-sm font-semibold">{t("radiology.peer.recentTitle")}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground"><th className="pr-2">{t("radiology.peer.col.study")}</th><th className="pr-2">{t("radiology.peer.col.why")}</th><th className="pr-2">{t("radiology.peer.col.score")}</th><th>{t("radiology.peer.col.note")}</th></tr></thead>
                <tbody>
                  {board.recent.map((r) => (
                    <tr key={r.reviewId} className="border-t">
                      <td className="py-1 pr-2">{r.studyTypeName}</td>
                      <td className="py-1 pr-2">{t(`radiology.peer.trigger.${r.trigger}`)}</td>
                      <td className={`mo py-1 pr-2 font-semibold ${SCORE_TONE[r.score] ?? ""}`}>{r.score}{r.learningCase ? " ★" : ""}</td>
                      <td className="py-1">{r.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.peer.recentNote")}</p>
          </section>
        )}
      </div>
    </RadiologyStation>
  );
}

function PeerCaseCard({ reviewId, onDone }: { reviewId: string; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["radiology", "reading", "peer", reviewId], queryFn: () => fetchPeerCase(reviewId), retry: false });
  const [score, setScore] = useState<PeerScore>("1");
  const [learning, setLearning] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [imagesMsg, setImagesMsg] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => scorePeerCase(reviewId, { score, learningCase: learning, note: note.trim() || null }), onSuccess: onDone, onError: (e) => setError(failOf(e)) });
  const images = useMutation({
    mutationFn: (studyId: string) => openImages(studyId),
    onSuccess: (r) => { window.open(r.url, "_blank", "noopener"); setImagesMsg(null); },
    onError: (e) => setImagesMsg(radiologyErrorText(e)),
  });
  const c = q.data?.case ?? null;
  const needsNote = score !== "1";
  const run = (needsNote && note.trim().length < 4) || save.isPending ? null : () => save.mutate();
  return (
    <article className="flex flex-col gap-3 rounded border bg-card p-3 text-sm" data-testid={`peer-case-${reviewId}`}>
      {q.isPending && <p>{t("common.loading")}</p>}
      {q.isError && <Refusal error={failOf(q.error)} />}
      {c !== null && (
        <>
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <b>{c.studyTypeName} · {c.patientAgeSex}{c.prelim ? ` · ${t("radiology.peer.prelim")}` : ""}</b>
            <button type="button" className="rounded border px-2 py-1 text-xs" onClick={() => images.mutate(c.studyId)} disabled={images.isPending}>{t("radiology.read.openImages")}</button>
          </header>
          {imagesMsg !== null && <p role="alert" className="m-0 text-xs text-red-700">{imagesMsg}</p>}
          <p className="m-0 text-xs"><span className="text-muted-foreground">{t("radiology.peer.question")}: </span>{c.indication ?? "—"}</p>
          <div className="space-y-1 rounded border bg-muted/30 p-2" data-testid="peer-report-text">
            {Object.entries(c.sections).map(([k, v]) => <p key={k} className="m-0"><b className="capitalize">{k.replace(/_/g, " ")}.</b> {v}</p>)}
            <p className="m-0"><b>{t("radiology.results.impression")}.</b> {c.impression ?? "—"}</p>
          </div>
          <fieldset className="m-0 space-y-2">
            <legend className="text-xs font-semibold">{t("radiology.peer.scoreTitle")}</legend>
            <div className="grid gap-1 sm:grid-cols-2" role="radiogroup" aria-label={t("radiology.peer.scoreTitle")}>
              {PEER_SCORES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={score === s} onClick={() => setScore(s)}
                  className={`rounded border px-2 py-1 text-left text-xs ${score === s ? "border-green-800 bg-green-50 font-semibold" : ""}`}>
                  <span className={`mo mr-1 font-bold ${SCORE_TONE[s] ?? ""}`}>{s}</span>{t(`radiology.peer.score.${s}`)}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={learning} onChange={(e) => setLearning(e.target.checked)} /> {t("radiology.peer.learning")}</label>
            <input className="w-full rounded border px-2 py-1 text-sm" value={note} maxLength={1000}
              placeholder={needsNote ? t("radiology.peer.notePhRequired") : t("radiology.peer.notePh")} onChange={(e) => setNote(e.target.value)} aria-label={t("radiology.peer.noteLabel")} />
          </fieldset>
          <Refusal error={error} />
          <Dock testId="peer" label={t("radiology.peer.dock", { score })} hint={needsNote ? t("radiology.peer.dockHintNote") : t("radiology.peer.dockHint")} run={run} />
        </>
      )}
    </article>
  );
}

/* ═══════════════════════════════ T3 — Night & outside reads ═══════════════════════════════ */

const GRADE_TONE: Record<string, string> = { concur: "text-green-800", minor: "text-amber-800", major: "text-red-700" };

export function TeleView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["radiology", "reading", "tele"], queryFn: fetchTeleBoard, refetchInterval: 60_000 });
  const board: WireTeleBoard | undefined = q.data;
  const queue = board?.queue ?? [];
  const [inHand, setInHand] = useState<string | null>(null);
  const row = queue.find((r) => r.teleReadId === inHand) ?? queue[0] ?? null;
  const late = queue.filter((r) => r.late);

  const list = (
    <section aria-label={t("radiology.tele.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.tele.listTitle")} · {queue.length}</h2>
      <ul className="m-0 list-none space-y-1 p-0" data-testid="tele-list">
        {queue.map((r) => (
          <li key={r.teleReadId} data-acc={r.accessionNo} data-state={r.state}>
            <button type="button" aria-current={r.teleReadId === row?.teleReadId ? "true" : undefined} onClick={() => setInHand(r.teleReadId)}
              className={`w-full rounded border bg-card p-2 text-left text-sm ${r.teleReadId === row?.teleReadId ? "border-green-700" : ""}`}>
              <span className="flex justify-between gap-2">
                <b className="min-w-0 truncate">{r.patientName}</b>
                <span className="mo shrink-0 text-xs">{timeWord(r.prelimAt)}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {r.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}{r.studyName}{r.late ? <b className="text-red-700"> · {t("radiology.tele.late")}</b> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {queue.length === 0 && !q.isPending && <p className="text-sm text-muted-foreground">{t("radiology.tele.none")}</p>}
    </section>
  );

  return (
    <RadiologyStation
      station="read" views={views}
      title={row === null ? t("radiology.tele.title") : `${row.patientName} · ${row.studyName}`}
      place={t("radiology.tele.place")}
      stats={[
        { label: t("radiology.tele.tile.awaiting"), value: board?.summary.awaiting ?? 0, tone: "danger" },
        { label: t("radiology.tele.tile.major"), value: board?.summary.major30 ?? 0, tone: "danger" },
      ]}
      lane={row === null
        ? <p className="mt-4 text-sm text-muted-foreground">{t("radiology.tele.nobody")}</p>
        : (
          <div className="mt-4 space-y-2 text-sm" data-testid="tele-in-hand">
            <span className="tag">{t("radiology.tele.inHand")}</span>
            <p className="m-0 text-base font-semibold">{row.patientName}</p>
            <p className="m-0 mo text-xs">{row.uhid} · {row.accessionNo}</p>
            <p className="m-0 text-xs">{row.studyName}</p>
            <span className="tag">{t("radiology.tele.readBy")}</span>
            <p className="m-0 text-xs">{row.readerName} · <span className="mo">{row.readerNmcNo}</span></p>
            <p className="m-0 text-xs text-muted-foreground">{row.providerName}</p>
            <p className={`m-0 text-xs ${row.late ? "font-bold text-red-700" : ""}`}>
              {row.tatMinutes === null ? t("radiology.tele.noClock") : t("radiology.tele.tat", { min: row.tatMinutes, target: row.targetMinutes ?? "—" })}
            </p>
          </div>
        )}
      list={list}
      listSummary={t("radiology.tele.listSummary", { count: queue.length })}
      inHand={row !== null}
      closeListOn={inHand}
      clocks={<ul className="m-0 list-none p-0 text-sm">{late.length === 0 ? <li className="text-muted-foreground">{t("radiology.tele.clocksQuiet")}</li> : late.map((r) => <li key={r.teleReadId}>{t("radiology.tele.clockLine", { name: r.patientName, min: r.tatMinutes ?? 0, target: r.targetMinutes ?? 0 })}</li>)}</ul>}
      clocksAlert={late.length > 0}
      clocksSummary={late.length > 0 ? t("radiology.tele.clocksSummary", { count: late.length }) : t("radiology.tele.clocksQuiet")}
    >
      <div className="flex min-h-full flex-col gap-3" data-testid="tele">
        {board !== undefined && !board.configured && (
          <p className="m-0 rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="tele-not-configured">
            {t("radiology.tele.notConfigured")} <a className="underline" href="/radiology/setup?view=books">{t("radiology.tele.fixBook")}</a>
          </p>
        )}
        {board?.coverage != null && (
          <p className="m-0 text-xs text-muted-foreground" data-testid="tele-coverage">
            {t("radiology.tele.coverage", { from: board.coverage.nightFrom, to: board.coverage.nightTo, stat: board.coverage.prelimMinutes.stat, urgent: board.coverage.prelimMinutes.urgent, by: board.coverage.overreadBy, who: board.providers.map((p) => p.name).join(", ") })}
          </p>
        )}
        {q.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(q.error)}</p>}
        {row !== null && <OverreadCard key={row.teleReadId} row={row} onDone={() => { setInHand(null); void qc.invalidateQueries({ queryKey: ["radiology", "reading"] }); }} />}
        {board !== undefined && (
          <section className="rounded border bg-card p-3" data-testid="tele-log">
            <h3 className="m-0 mb-1 text-sm font-semibold">{t("radiology.tele.logTitle")}</h3>
            <p className="m-0 mb-2 text-xs text-muted-foreground">
              {t("radiology.tele.summary", { n: board.summary.prelims30, median: board.summary.medianTat30 ?? "—", late: board.summary.late30, minor: board.summary.minor30, major: board.summary.major30 })}
            </p>
            {board.log.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{t("radiology.tele.logEmpty")}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-muted-foreground"><th className="pr-2">{t("radiology.tele.col.patient")}</th><th className="pr-2">{t("radiology.tele.col.prelim")}</th><th className="pr-2">{t("radiology.tele.col.grade")}</th><th>{t("radiology.tele.col.note")}</th></tr></thead>
                  <tbody>
                    {board.log.map((r) => (
                      <tr key={r.teleReadId} className={`border-t ${r.state === "major" ? "bg-red-50" : ""}`} data-state={r.state}>
                        <td className="py-1 pr-2"><b>{r.patientName}</b><span className="block text-muted-foreground">{r.studyName}</span></td>
                        <td className="py-1 pr-2">{r.prelim.impression ?? "—"}<span className="block text-muted-foreground">{r.readerName} · {timeWord(r.prelimAt)}</span></td>
                        <td className={`py-1 pr-2 font-semibold ${GRADE_TONE[r.state] ?? ""}`}>{t(`radiology.tele.grade.${r.state}`)}</td>
                        <td className="py-1">{r.overread?.note ?? "—"}{r.overread?.by ? <span className="block text-muted-foreground">{r.overread.by}</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {board !== undefined && (
          <section className="rounded border bg-card p-3" data-testid="tele-outside">
            <h3 className="m-0 mb-2 text-sm font-semibold">{t("radiology.tele.outsideTitle")}</h3>
            {board.outside.length === 0 ? <p className="m-0 text-xs text-muted-foreground">{t("radiology.tele.outsideNone")}</p> : (
              <ul className="m-0 list-none space-y-1 p-0">
                {board.outside.map((o) => (
                  <li key={o.studyId} className="flex flex-wrap items-baseline justify-between gap-2 text-xs" data-acc={o.accessionNo} data-state={o.state}>
                    <span><b>{o.patientName}</b> · {o.studyName} · {t("radiology.tele.from", { centre: o.centreName, day: dayWord(o.studyDate) })}</span>
                    <a className="underline" href={`/radiology/read?study=${o.studyId}`}>{t("radiology.tele.read")}</a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </RadiologyStation>
  );
}

function OverreadCard({ row, onDone }: { row: WireTeleRow; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [grade, setGrade] = useState<OverreadGrade>("concur");
  const [note, setNote] = useState("");
  const [findings, setFindings] = useState(row.prelim.findings ?? "");
  const [impression, setImpression] = useState(row.prelim.impression ?? "");
  const [totp, setTotp] = useState<{ asked: boolean; code: string }>({ asked: false, code: "" });
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (totp.asked && totp.code.trim() !== "") await verifySecondFactor(totp.code.trim());
      return await overreadNightRead(row.teleReadId, grade === "concur"
        ? { grade }
        : { grade, note: note.trim(), findings: findings.trim() || null, impression: impression.trim() });
    },
    onSuccess: (r) => { setError(null); setDone(t(`radiology.tele.done.${r.grade}`)); onDone(); },
    onError: (e) => {
      if (needsSecondFactor(e)) { setTotp((p) => ({ asked: true, code: p.asked ? "" : p.code })); setError(null); return; }
      setError(failOf(e));
    },
  });
  const correcting = grade !== "concur";
  const ready = !save.isPending && (!correcting || (note.trim().length >= 4 && impression.trim() !== "")) && (!totp.asked || totp.code.trim().length === 6);
  return (
    <article className="flex flex-col gap-3 rounded border bg-card p-3 text-sm" data-testid={`overread-${row.teleReadId}`}>
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-950">{t("radiology.tele.prelimBadge")}</span>
        {/* The reader and NMC number are the lane's (one fact, one card). */}
        <span className="mo text-xs text-muted-foreground">{timeWord(row.prelimAt)}</span>
      </header>
      <div className="space-y-1 rounded border bg-muted/30 p-2" data-testid="overread-prelim">
        <p className="m-0"><b>{t("radiology.tele.findings")}.</b> {row.prelim.findings ?? "—"}</p>
        <p className="m-0"><b>{t("radiology.results.impression")}.</b> {row.prelim.impression ?? "—"}</p>
      </div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t("radiology.tele.gradeTitle")}>
        {(["concur", "minor", "major"] as const).map((g) => (
          <button key={g} type="button" role="radio" aria-checked={grade === g} onClick={() => setGrade(g)}
            className={`rounded border px-3 py-1 text-xs ${grade === g ? `border-green-800 bg-green-50 font-semibold ${GRADE_TONE[g] ?? ""}` : ""}`}>
            {t(`radiology.tele.grade.${g}`)}
          </button>
        ))}
      </div>
      {correcting && (
        <div className="grid gap-2">
          <label className="flex flex-col gap-1 text-xs">{t("radiology.tele.noteLabel")}
            <input className="rounded border px-2 py-1 text-sm" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder={t("radiology.tele.notePh")} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t("radiology.tele.findings")}
            <textarea className="rounded border px-2 py-1 text-sm" rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">{t("radiology.results.impression")}
            <textarea className="rounded border px-2 py-1 text-sm" rows={2} value={impression} onChange={(e) => setImpression(e.target.value)} />
          </label>
          {grade === "major" && <p className="m-0 text-xs text-red-800">{t("radiology.tele.majorHint")}</p>}
        </div>
      )}
      {totp.asked && (
        <label className="flex flex-col gap-1 text-xs">{t("radiology.read.totpLabel")}
          <input className="mo w-40 rounded border px-2 py-1 text-sm" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={totp.code} onChange={(e) => setTotp({ asked: true, code: e.target.value.replace(/\D/g, "") })} />
        </label>
      )}
      {done !== null && <p role="status" className="m-0 text-sm text-green-800">{done}</p>}
      <Refusal error={error} />
      <Dock testId="overread" label={correcting ? t("radiology.tele.dockCorrect") : t("radiology.tele.dockConcur")} hint={correcting ? t("radiology.tele.dockCorrectHint") : t("radiology.tele.dockConcurHint")} run={ready ? () => save.mutate() : null} />
    </article>
  );
}
