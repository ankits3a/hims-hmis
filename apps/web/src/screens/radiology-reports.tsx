import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fmtIst } from "../lib/format";
import { radiologyErrorCode, radiologyErrorText } from "../lib/radiology-api";
import {
  COLLECTOR_ID_TYPES, COLLECTOR_KINDS, fetchReleaseRegister, handOverReport, markMediaPrinted, requestImagingMedia,
} from "../lib/radiology-release-api";
import type { CollectorKind, WireReleaseRow } from "../lib/radiology-release-api";
import { RadiologyStation } from "./radiology-station";
import { Refusal, useNow } from "../components/radiology/imaging-counter";
import { istDay } from "../components/radiology/desk-time";

/**
 * PLAN 18-S RS9 T4 — **REPORT HAND-OVER: one release register at the imaging window** (board:
 * "Front desk → Report hand-over").
 *
 * The owner's counter layout: the header carries the menu; the LEFT lane holds the report in hand;
 * the CENTRE is the one register (rows that need the desk first — nothing filtered away) or, with a
 * report in hand, the hand-over with ONE docked act (Enter runs it); the RIGHT is ONE list — who is
 * waiting at the window — then "Clocks running", collapsed unless an abnormal report has sat
 * uncollected for a day.
 *
 * The hand-over names its collector as the type needs (the server's rule, repeated here only as the
 * disabled state of the dock): a relative gives a name, a relation and the ID they showed (type +
 * last four). **There is no patient OTP service** — DECIDED: the ID record stands in, and the screen
 * says the OTP is not built. Film and CD per ruling 1: an X-ray includes one film; anything else is
 * charged at the billing counter under the tariff's `RAD-FILM` / `RAD-CD` — this screen composes no
 * money.
 */

type Draft = {
  kind: CollectorKind; name: string; relation: string; idType: string; idLast4: string; note: string; media: string[];
};
const EMPTY: Draft = { kind: "patient", name: "", relation: "", idType: "", idLast4: "", note: "", media: [] };
const RELATIONS = ["spouse", "son", "daughter", "parent", "sibling", "other"] as const;

function draftReady(d: Draft): boolean {
  if (d.kind === "patient") return true;
  if (d.name.trim().length < 2) return false;
  if (d.kind !== "relative") return true;
  return d.relation !== "" && d.idType !== "" && /^[A-Za-z0-9]{4}$/.test(d.idLast4);
}

export function RadiologyReports(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const tEn = i18n.getFixedT("en");
  const qc = useQueryClient();
  const now = useNow();
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [filmQty, setFilmQty] = useState(1);
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["radiology", "release"], queryFn: fetchReleaseRegister });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const inHand = rows.find((r) => r.reportId === sel) ?? null;
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["radiology", "release"] }); };
  const fail = (e: unknown): void => { setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); };
  const take = (r: WireReleaseRow | null): void => {
    setSel(r?.reportId ?? null); setDraft({ ...EMPTY, kind: r?.bedsideLocation != null ? "ward_staff" : "patient" });
    setError(null); setFilmQty(1);
  };

  const media = useMutation({
    mutationFn: (v: { row: WireReleaseRow; kind: "film" | "cd" }) =>
      requestImagingMedia(v.row.studyId, v.kind === "film" ? { kind: "film", quantity: filmQty } : { kind: "cd" }),
    onSuccess: (r) => { setDone(r.included ? t("radiology.release.filmIncludedDone") : t("radiology.release.mediaDone")); setError(null); refresh(); },
    onError: fail,
  });
  const printed = useMutation({
    mutationFn: (requestId: string) => markMediaPrinted(requestId),
    onSuccess: () => { setError(null); refresh(); },
    onError: fail,
  });
  const hand = useMutation({
    mutationFn: (row: WireReleaseRow) => handOverReport(row.reportId, {
      collectorKind: draft.kind,
      collectorName: draft.kind === "patient" ? null : draft.name.trim(),
      collectorRelation: draft.kind === "relative" ? tEn(`radiology.release.relation.${draft.relation}`) : null,
      collectorIdType: draft.kind === "relative" ? draft.idType : null,
      collectorIdLast4: draft.kind === "relative" ? draft.idLast4 : null,
      mediaRequestIds: draft.media,
      note: draft.note.trim() === "" ? null : draft.note.trim(),
    }),
    onSuccess: (_r, row) => {
      setDone(t("radiology.release.handedDone", { acc: row.accessionNo, name: row.patientName })); take(null); refresh();
    },
    onError: fail,
  });

  const ready = inHand !== null && draftReady(draft) && !hand.isPending;
  const dockRun = useRef<(() => void) | null>(null);
  dockRun.current = ready && inHand !== null ? () => hand.mutate(inHand) : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
      if (e.key === "Escape") take(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const waiting = rows.filter((r) => r.needs.length > 0);
  const abnormal = rows.filter((r) => r.needs.includes("abnormal_uncollected"));
  const needText = (r: WireReleaseRow): string => (r.needs.length === 0 ? "" : t(`radiology.release.need.${r.needs[0]}`));
  const hoursSince = (iso: string): number => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3_600_000));
  const last = (r: WireReleaseRow) => r.handovers[r.handovers.length - 1];

  const list = (
    <section aria-label={t("radiology.release.waiting")}>
      <h2 className="tag m-0 mb-2">{t("radiology.release.waiting")} · {waiting.length}</h2>
      {waiting.length === 0 && <p className="text-sm text-muted-foreground">{t("radiology.release.nobodyWaiting")}</p>}
      <ul className="m-0 list-none space-y-1 p-0">
        {waiting.map((r) => (
          <li key={r.reportId} data-acc={r.accessionNo}>
            <button
              type="button" onClick={() => take(r)}
              className={`w-full rounded border p-2 text-left text-sm ${r.reportId === sel ? "outline outline-2 outline-black" : ""} ${r.needs[0] === "abnormal_uncollected" ? "border-red-400 bg-red-50" : "bg-card"}`}
            >
              <b>{r.patientName}</b>
              <span className="block text-xs text-muted-foreground">{r.studyName} · {needText(r)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const clocks = abnormal.length === 0 ? null : (
    <ul className="m-0 list-none space-y-1 p-0 text-xs">
      {abnormal.map((r) => (
        <li key={r.reportId} className="text-red-800">
          {t("radiology.release.clockAbnormal", { name: r.patientName, hours: hoursSince(r.publishedAt) })}
        </li>
      ))}
    </ul>
  );

  const lane = inHand === null ? undefined : (
    <div className="space-y-1 text-sm" data-acc={inHand.accessionNo}>
      <b className="block">{inHand.patientName}</b>
      <span className="block text-xs text-muted-foreground">{inHand.uhid}</span>
      <span className="block">{inHand.studyName}</span>
      <span className="mo block text-xs">{inHand.accessionNo} · v{inHand.version}</span>
      <span className="block text-xs">{t("radiology.release.released", { at: `${istDay(inHand.publishedAt)} ${fmtIst(inHand.publishedAt)}` })}</span>
      {inHand.bedsideLocation !== null && <span className="block text-xs">{inHand.bedsideLocation}</span>}
      <span className="block text-xs">{t(`radiology.release.doctor.${inHand.doctor}`)}</span>
      <span className="block text-xs">{inHand.notice === null ? t("radiology.release.noticeNone") : t("radiology.release.noticeState", { state: inHand.notice })}</span>
    </div>
  );

  const register = (
    <section className="rounded border bg-card" aria-label={t("radiology.release.register")}>
      <h2 className="tag m-0 border-b p-2">{t("radiology.release.register")} · {rows.length}</h2>
      {q.isError && <div className="p-2"><Refusal code={radiologyErrorCode(q.error)} message={radiologyErrorText(q.error)} /></div>}
      {q.isSuccess && rows.length === 0 && <p className="m-0 p-2 text-sm text-muted-foreground">{t("radiology.release.empty")}</p>}
      <ul className="m-0 list-none p-0" data-testid="release-register">
        {rows.map((r) => {
          const h = last(r);
          return (
            <li
              key={r.reportId} data-acc={r.accessionNo} data-state={r.needs.length === 0 ? "done" : r.needs[0]}
              className={`flex flex-wrap items-start gap-x-3 gap-y-1 border-b p-2 text-sm ${r.needs[0] === "abnormal_uncollected" ? "bg-red-50" : r.needs.length > 0 ? "bg-amber-50" : ""}`}
            >
              <div className="min-w-0 flex-1 basis-48">
                <b>{r.patientName}</b> <span className="mo text-xs text-muted-foreground">{r.accessionNo}</span>
                <span className="block text-xs">{r.studyName}{r.criticalCategory !== null ? ` · ${t("radiology.release.abnormal")}` : ""}</span>
              </div>
              <div className="min-w-0 flex-1 basis-40 text-xs">
                {r.needs.length > 0 ? <b>{needText(r)}</b> : h !== undefined
                  ? t("radiology.release.handedTo", { who: h.collectorName ?? t("radiology.release.kind.patient"), at: fmtIst(h.handedAt) })
                  : "—"}
                <span className="block text-muted-foreground">{t(`radiology.release.doctor.${r.doctor}`)}</span>
              </div>
              <button type="button" className="rounded border px-3 py-1 text-xs" onClick={() => { take(r); setDone(null); }}>
                {t("radiology.release.open")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  const handover = inHand === null ? null : (
    <section className="space-y-3" data-testid="handover">
      <div className="rounded border bg-card p-3 space-y-2">
        <h2 className="tag m-0">{t("radiology.release.collector")}</h2>
        <div role="radiogroup" aria-label={t("radiology.release.collector")} className="flex flex-wrap gap-2">
          {COLLECTOR_KINDS.map((k) => (
            <button
              key={k} type="button" role="radio" aria-checked={draft.kind === k}
              className={`rounded border px-3 py-1 text-sm ${draft.kind === k ? "bg-green-800 text-white" : ""}`}
              onClick={() => setDraft((d) => ({ ...d, kind: k }))}
            >
              {t(`radiology.release.kind.${k}`)}
            </button>
          ))}
        </div>
        {draft.kind === "patient" && <p className="m-0 text-xs text-muted-foreground">{t("radiology.release.patientRule")}</p>}
        {draft.kind !== "patient" && (
          <label className="flex max-w-md flex-col text-xs">
            {t(`radiology.release.nameOf.${draft.kind}`)}
            <input className="border px-2 py-1 text-sm" maxLength={120} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          </label>
        )}
        {draft.kind === "relative" && (
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col text-xs">
              {t("radiology.release.relationLabel")}
              <select className="border px-2 py-1 text-sm" value={draft.relation} onChange={(e) => setDraft((d) => ({ ...d, relation: e.target.value }))}>
                <option value="">{t("radiology.release.choose")}</option>
                {RELATIONS.map((r) => <option key={r} value={r}>{t(`radiology.release.relation.${r}`)}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs">
              {t("radiology.release.idType")}
              <select className="border px-2 py-1 text-sm" value={draft.idType} onChange={(e) => setDraft((d) => ({ ...d, idType: e.target.value }))}>
                <option value="">{t("radiology.release.choose")}</option>
                {COLLECTOR_ID_TYPES.map((k) => <option key={k} value={k}>{t(`radiology.release.id.${k}`)}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs">
              {t("radiology.release.idLast4")}
              <input className="mo w-24 border px-2 py-1 text-sm" maxLength={4} value={draft.idLast4} onChange={(e) => setDraft((d) => ({ ...d, idLast4: e.target.value.replace(/[^A-Za-z0-9]/g, "") }))} />
            </label>
          </div>
        )}
        {draft.kind === "relative" && <p className="m-0 text-xs text-amber-900" data-testid="otp-deferred">{t("radiology.release.otpDeferred")}</p>}
        {draft.kind === "ward_staff" && <p className="m-0 text-xs text-muted-foreground">{t("radiology.release.wardRule")}</p>}
        {draft.kind === "courier" && <p className="m-0 text-xs text-muted-foreground">{t("radiology.release.courierRule")}</p>}
      </div>

      <div className="rounded border bg-card p-3 space-y-2" data-testid="media">
        <h2 className="tag m-0">{t("radiology.release.media")}</h2>
        <p className="m-0 text-xs text-muted-foreground">{inHand.filmIncluded ? t("radiology.release.filmIncludedRule") : t("radiology.release.mediaRule")}</p>
        {inHand.media.length > 0 && (
          <ul className="m-0 list-none space-y-1 p-0">
            {inHand.media.map((m) => (
              <li key={m.requestId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  {m.kind === "film" ? t("radiology.release.filmN", { n: m.quantity }) : t("radiology.release.cd")}
                  {" · "}
                  {m.included ? t("radiology.release.included") : m.serviceCode !== null ? t("radiology.release.billAs", { code: m.serviceCode }) : t("radiology.release.notInTariff")}
                </span>
                {m.handedOver ? <span className="text-xs text-green-800">{t("radiology.release.mediaHanded")}</span>
                  : m.printedAt === null ? (
                    <button type="button" className="rounded border px-2 py-0.5 text-xs" disabled={printed.isPending} onClick={() => printed.mutate(m.requestId)}>{t("radiology.release.markPrinted")}</button>
                  ) : (
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox" checked={draft.media.includes(m.requestId)}
                        onChange={(e) => setDraft((d) => ({ ...d, media: e.target.checked ? [...d.media, m.requestId] : d.media.filter((x) => x !== m.requestId) }))}
                      />
                      {t("radiology.release.withReport")}
                    </label>
                  )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs">
            {t("radiology.release.sheets")}
            <input type="number" min={1} max={20} className="w-20 border px-2 py-1 text-sm" value={filmQty} onChange={(e) => setFilmQty(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
          </label>
          <button type="button" className="rounded border px-3 py-1 text-sm" disabled={media.isPending} onClick={() => media.mutate({ row: inHand, kind: "film" })}>{t("radiology.release.askFilm")}</button>
          <button type="button" className="rounded border px-3 py-1 text-sm" disabled={media.isPending} onClick={() => media.mutate({ row: inHand, kind: "cd" })}>{t("radiology.release.askCd")}</button>
        </div>
      </div>

      <label className="flex max-w-xl flex-col text-xs">
        {t("radiology.release.note")}
        <input className="border px-2 py-1 text-sm" maxLength={300} value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
      </label>
      {error !== null && <Refusal code={error.code} message={error.message} />}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="release-dock">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{ready ? t("radiology.release.dockHint") : t("radiology.release.dockWait")}</span>
        <button type="button" className="px-2 text-sm underline" onClick={() => take(null)}>{t("radiology.release.back")}</button>
        <button
          type="button" data-testid="dock-act" className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!ready} onClick={() => dockRun.current?.()}
        >
          {t("radiology.release.handOver")} <span className="kb">Enter</span>
        </button>
      </div>
    </section>
  );

  return (
    <RadiologyStation
      station="reports"
      title={t("radiology.release.title")}
      place={t("radiology.release.place")}
      stats={[
        { label: t("radiology.release.statReleased"), value: rows.length },
        { label: t("radiology.release.statWaiting"), value: waiting.length },
        { label: t("radiology.release.statAbnormal"), value: abnormal.length, tone: abnormal.length > 0 ? "danger" : "plain" },
      ]}
      lane={lane}
      list={list}
      inHand={inHand !== null}
      closeListOn={sel}
      clocks={clocks ?? undefined}
      clocksSummary={t("radiology.release.clocks", { n: abnormal.length })}
      clocksAlert={abnormal.length > 0}
    >
      <div className="space-y-3">
        {done !== null && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-sm">{done}</p>}
        {handover ?? register}
        <p className="m-0 text-xs text-muted-foreground">{t("radiology.release.rules")}</p>
      </div>
    </RadiologyStation>
  );
}
