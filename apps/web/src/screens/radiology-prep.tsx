import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import {
  fetchPrepBay, fetchPrepStudy, radiologyErrorCode, radiologyErrorText, requestGateOverride, satisfyGate, waiveGate,
} from "../lib/radiology-api";
import { GateEvidenceForm } from "../components/radiology/prep-gate-forms";
import { ContrastPanel } from "../components/radiology/contrast-panel";
import { Refusal } from "../components/radiology/imaging-counter";
import type { WirePrepGate, WirePrepRow, WirePrepStudy } from "../lib/radiology-api";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS5 T3 — **THE PREP & SAFETY BAY.** The approved board's `st-prep`: the bay closes the
 * safety gates the check-in opened, with evidence, and hands a ready patient to the room.
 *
 *   · RIGHT — ONE list: checked-in studies with an open PREP gate (`GET /radiology/prep`), STAT
 *     first, then by slot. No tabs. "Clocks running" (collapsed) is the radiologist's unanswered
 *     override requests.
 *   · LEFT — the patient in hand: allergies (contrast ones marked), the lab's latest signed
 *     creatinine with the eGFR the gate computes, weight, LMP, the study and its room.
 *   · CENTRE — every gate as a FORM (`prep-gate-forms.tsx`). Identity and side are ROOM gates
 *     (plan Gap 4): shown as "closed at the console", no buttons. A waivable gate shows WAIVE only
 *     to a holder of `radiology.gates.override` (the server's rule: a waiver is the radiologist's
 *     act). Every other open gate offers "Ask the radiologist to override" (T2), except the two
 *     that are never overridden. Contrast and the reaction sit under the gates (T5).
 *   · DOCK — the one next act, Enter runs it. When the last prep gate closes the server has already
 *     moved the study to `ready` (if the room's gates are closed too) and it leaves the list.
 *
 * The study console links here with `?study=<id>` (its contrast section), so a study that is on
 * the table, not in this list, can still be taken in hand for the contrast record.
 */

export const PREP_STATION_PERMISSION = "radiology.gates.satisfy";

function gateName(t: (k: string, o?: Record<string, unknown>) => string, kind: string): string {
  return t(`radiology.gate.${kind}`, { defaultValue: kind });
}

function evidenceLine(t: (k: string, o?: Record<string, unknown>) => string, g: WirePrepGate): string | null {
  if (g.state === "overridden" && g.override !== null) return t("radiology.bay.overriddenBy", { reason: g.override.reason });
  const ev = g.evidence;
  if (ev === null) return null;
  if (ev.kind === "waiver") return t("radiology.bay.waivedLine", { reason: String(ev.reason ?? "") });
  if (g.kind === "renal_function" && typeof ev.creatinineUmolL === "number") {
    return t("radiology.bay.kidneyLine", {
      umol: Math.round(ev.creatinineUmolL * 10) / 10,
      egfr: ev.egfr === null || ev.egfr === undefined ? "—" : String(ev.egfr),
    }) + (ev.hydration !== undefined ? ` · ${t("radiology.bay.kidney.hydrationLabel")}` : "");
  }
  return t("radiology.bay.recordedLine");
}

export function RadiologyPrep(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can, actor } = useAuth();
  const search = useSearch({ strict: false }) as { study?: string };
  const [hand, setHand] = useState<string | null>(search.study ?? null);
  const [active, setActive] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ kind: string; note: string } | null>(null);
  const [waiving, setWaiving] = useState<{ kind: string; reason: string } | null>(null);
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { if (search.study !== undefined) setHand(search.study); }, [search.study]);

  const listQ = useQuery({ queryKey: ["radiology", "prep"], queryFn: fetchPrepBay, refetchInterval: 30_000 });
  const viewQ = useQuery({
    queryKey: ["radiology", "prep", "study", hand],
    queryFn: () => fetchPrepStudy(hand!),
    enabled: hand !== null,
  });
  const rows = listQ.data?.rows ?? [];
  const view = hand === null ? null : viewQ.data?.view ?? null;

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["radiology", "prep"] });
  };
  const fail = (e: unknown): void => { setNotice(null); setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); };

  const satisfy = useMutation({
    mutationFn: ({ kind, evidence }: { kind: string; evidence: Record<string, unknown> }) => satisfyGate(hand!, kind, evidence),
    onSuccess: (_r, v) => { setError(null); setNotice(t("radiology.bay.satisfied", { gate: gateName(t, v.kind) })); setActive(null); refresh(); },
    onError: fail,
  });
  const ask = useMutation({
    mutationFn: ({ kind, note }: { kind: string; note: string }) => requestGateOverride(hand!, kind, note),
    onSuccess: (_r, v) => { setError(null); setAsking(null); setNotice(t("radiology.bay.asked", { gate: gateName(t, v.kind) })); refresh(); },
    onError: fail,
  });
  const waive = useMutation({
    mutationFn: ({ kind, reason }: { kind: string; reason: string }) => waiveGate(hand!, kind, reason),
    onSuccess: (_r, v) => { setError(null); setWaiving(null); setNotice(t("radiology.bay.waived", { gate: gateName(t, v.kind) })); refresh(); },
    onError: fail,
  });
  const busy = satisfy.isPending || ask.isPending || waive.isPending;

  const take = (studyId: string | null): void => {
    setHand(studyId); setActive(null); setAsking(null); setWaiving(null); setError(null); setNotice(null);
    void navigate({ to: "/radiology/prep", search: studyId === null ? {} : { study: studyId } } as never);
  };

  /* ── the gates in hand ── */
  const gates = view?.gates ?? [];
  const openPrep = gates.filter((g) => g.state === "open" && !g.room);
  const mine = openPrep.filter((g) => g.asked === null);
  const current = active ?? mine[0]?.kind ?? null;

  /* ── the dock: the ONE next act ── */
  const nextRow = rows.find((r) => r.studyId !== hand);
  let dock: { label: string; hint: string; run: (() => void) | null };
  if (view === null) {
    dock = rows[0] === undefined
      ? { label: t("radiology.bay.dock.empty"), hint: t("radiology.bay.dock.emptyHint"), run: null }
      : { label: t("radiology.bay.dock.take", { name: rows[0].patientName }), hint: t("radiology.bay.dock.takeHint"), run: () => { take(rows[0]!.studyId); } };
  } else if (mine.length > 0) {
    const g = mine.find((x) => x.kind === current) ?? mine[0]!;
    dock = {
      label: t("radiology.bay.dock.record", { gate: gateName(t, g.kind) }),
      hint: t("radiology.bay.dock.openHint", { count: openPrep.length }),
      run: () => { setActive(g.kind); document.getElementById(`gate-form-${g.kind}`)?.scrollIntoView({ block: "center" }); },
    };
  } else if (openPrep.length > 0) {
    dock = { label: t("radiology.bay.dock.waiting", { gate: gateName(t, openPrep[0]!.kind) }), hint: t("radiology.bay.dock.waitingHint"), run: null };
  } else {
    dock = {
      label: nextRow === undefined ? t("radiology.bay.dock.done") : t("radiology.bay.dock.next", { name: nextRow.patientName }),
      hint: t("radiology.bay.dock.doneHint", { room: view.study.deviceCode ?? "—" }),
      run: () => { take(nextRow?.studyId ?? null); },
    };
  }
  const dockRun = useRef(dock.run);
  dockRun.current = dock.run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(el?.tagName ?? "")) return;
      if (e.key === "Enter" && dockRun.current !== null) { e.preventDefault(); dockRun.current(); }
      if (e.key === "Escape") take(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ── the right column ── */
  const asked = rows.filter((r) => r.asked.length > 0);
  const list = (
    <section aria-label={t("radiology.bay.listTitle")} data-testid="prep-list">
      <h3 className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("radiology.bay.listTitle")} · {rows.length}</h3>
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map((r) => <PrepListRow key={r.studyId} row={r} inHand={r.studyId === hand} onOpen={() => { take(r.studyId); }} />)}
      </ul>
      {!listQ.isPending && rows.length === 0 && <p className="text-sm text-muted-foreground" data-testid="prep-empty">{t("radiology.bay.empty")}</p>}
      {listQ.isError && <Refusal code={radiologyErrorCode(listQ.error)} message={radiologyErrorText(listQ.error)} />}
    </section>
  );
  const clocks = (
    <ul className="m-0 list-none space-y-1 p-0 text-sm" data-testid="prep-clocks">
      {asked.map((r) => (
        <li key={r.studyId}>{t("radiology.bay.clockAsked", { name: r.patientName, gates: r.asked.map((k) => gateName(t, k)).join(", ") })}</li>
      ))}
      {asked.length === 0 && <li className="text-muted-foreground">{t("radiology.bay.clocksQuiet")}</li>}
    </ul>
  );

  /* ── the lane ── */
  const lane = view === null
    ? (
      <div className="mt-4 space-y-2 text-sm" data-testid="prep-nobody">
        <p className="m-0 text-muted-foreground">{t("radiology.bay.nobody")}</p>
        <p className="m-0">{t("radiology.bay.inBay", { count: rows.length })}</p>
      </div>
    )
    : <PrepLane view={view} />;

  return (
    <RadiologyStation
      station="prep"
      title={t("radiology.bay.title")}
      place={t("radiology.bay.place")}
      stats={[
        { label: t("radiology.bay.statBay"), value: rows.length },
        { label: t("radiology.station.stat"), value: rows.filter((r) => r.priority === "stat").length, tone: "danger" },
        { label: t("radiology.bay.statAsked"), value: asked.length, tone: "waiting" },
      ]}
      lane={lane}
      list={list}
      inHand={view !== null}
      closeListOn={hand}
      clocks={clocks}
      clocksAlert={asked.length > 0}
      clocksSummary={asked.length > 0 ? t("radiology.bay.clocksSummary", { count: asked.length }) : t("radiology.bay.clocksNone")}
    >
      <div className="flex min-h-full flex-col" data-testid="prep-centre">
        <div className="flex-1 space-y-3 pb-3">
          {hand !== null && viewQ.isPending && <p>{t("common.loading")}</p>}
          {hand !== null && viewQ.isError && <Refusal code={radiologyErrorCode(viewQ.error)} message={radiologyErrorText(viewQ.error)} />}
          {view === null && hand === null && <PrepBrief />}
          {view !== null && (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <b className="text-base">{view.study.studyTypeName}</b>
                {view.study.priority === "stat" && <b className="text-red-700">STAT</b>}
                <span className="mo text-xs text-muted-foreground">{view.study.accessionNo}</span>
                <span className="text-xs text-muted-foreground">{t(`radiology.counter.state.${view.study.status}`, { defaultValue: view.study.status })}</span>
              </div>
              {error !== null && <Refusal code={error.code} message={error.message} />}
              {notice !== null && <p role="status" className="m-0 rounded border border-green-300 bg-green-50 p-2 text-sm">{notice}</p>}
              <section className="space-y-2" data-testid="prep-gates">
                <h3 className="m-0 text-sm font-semibold">
                  {t("radiology.bay.gatesTitle", { closed: gates.filter((g) => g.state !== "open").length, total: gates.length })}
                </h3>
                {gates.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t("radiology.bay.noGates")}</p>}
                {gates.map((g) => (
                  <GateRow
                    key={g.id} gate={g} view={view} open={current === g.kind} busy={busy}
                    canWaive={can("radiology.gates.override")} actorId={actor?.id ?? null}
                    onOpen={() => { setActive(g.kind); }}
                    onSatisfy={(evidence) => { satisfy.mutate({ kind: g.kind, evidence }); }}
                    asking={asking?.kind === g.kind ? asking.note : null}
                    onAskStart={(note) => { setAsking({ kind: g.kind, note }); }}
                    onAskNote={(note) => { setAsking({ kind: g.kind, note }); }}
                    onAskSend={() => { if (asking !== null) ask.mutate(asking); }}
                    onAskCancel={() => { setAsking(null); }}
                    waiving={waiving?.kind === g.kind ? waiving.reason : null}
                    onWaiveStart={() => { setWaiving({ kind: g.kind, reason: "" }); }}
                    onWaiveReason={(reason) => { setWaiving({ kind: g.kind, reason }); }}
                    onWaiveSend={() => { if (waiving !== null) waive.mutate(waiving); }}
                    onWaiveCancel={() => { setWaiving(null); }}
                  />
                ))}
              </section>
              <ContrastPanel view={view} onChanged={refresh} />
            </>
          )}
        </div>
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="prep-dock">
          <span className="min-w-[12rem] flex-1 text-xs text-muted-foreground">{dock.hint}</span>
          <button type="button" data-testid="dock-act" disabled={dock.run === null}
            className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => dock.run?.()}>
            {dock.label} <span className="kb">Enter</span>
          </button>
        </div>
      </div>
    </RadiologyStation>
  );
}

function PrepListRow({ row, inHand, onOpen }: { row: WirePrepRow; inHand: boolean; onOpen: () => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <li data-acc={row.accessionNo}>
      <button type="button" data-testid={`prep-row-${row.studyId}`} aria-current={inHand ? "true" : undefined}
        className={`w-full rounded border bg-card p-2 text-left text-sm ${inHand ? "border-green-700" : ""}`} onClick={onOpen}>
        <span className="flex justify-between gap-2">
          <b className="min-w-0 truncate">{row.patientName}</b>
          <span className="mo shrink-0 text-xs">{row.scheduledAt === null ? "—" : fmtIst(row.scheduledAt)}</span>
        </span>
        <span className="block text-xs text-muted-foreground">
          {row.priority === "stat" ? <b className="text-red-700">STAT · </b> : null}
          {row.studyTypeCode}{row.deviceCode === null ? "" : ` · ${row.deviceCode}`}
        </span>
        <span className="block text-xs">
          {row.openPrep.map((k) => t(`radiology.gate.${k}`, { defaultValue: k }) + (row.asked.includes(k) ? ` (${t("radiology.bay.askedShort")})` : "")).join(" · ")}
        </span>
      </button>
    </li>
  );
}

function PrepLane({ view }: { view: WirePrepStudy }): React.ReactElement {
  const { t } = useTranslation();
  const p = view.patient;
  const k = view.kidney;
  return (
    <div className="mt-4 space-y-3 text-sm" data-testid="prep-in-hand">
      <div>
        <span className="tag">{t("radiology.counter.inHand")}</span>
        <p className="m-0 mt-1 text-base font-semibold">{p.name}</p>
        <p className="m-0 mo text-xs">{p.uhid} · {view.study.encounterNo}</p>
        <p className="m-0 text-xs">{[p.ageYears === null ? null : t("radiology.bay.age", { years: p.ageYears }), t(`radiology.bay.sex.${p.sex}`, { defaultValue: p.sex })].filter(Boolean).join(" · ")}</p>
      </div>
      <div>
        <span className="tag">{t("radiology.bay.allergies")}</span>
        {view.allergies.length === 0
          ? <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.bay.noAllergies")}</p>
          : (
            <ul className="m-0 mt-1 list-none space-y-0.5 p-0" data-testid="lane-allergies">
              {view.allergies.map((a) => (
                <li key={a.substance} className={a.contrast ? "font-semibold text-red-700" : ""}>
                  {a.substance}{a.severity === null ? "" : ` · ${a.severity}`}
                </li>
              ))}
            </ul>
          )}
      </div>
      <div data-testid="lane-kidney">
        <span className="tag">{t("radiology.bay.kidneyTag")}</span>
        {k.creatinine === null
          ? <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.bay.noCreatinine")}</p>
          : (
            <p className="m-0 mt-1 text-xs">
              {t("radiology.bay.creatinineLine", { value: k.creatinine.reported.value, unit: k.creatinine.reported.unit ?? "", date: k.creatinine.sampledAt.slice(0, 10) })}
              <br />
              {k.egfr?.computed === true
                ? <b className={k.egfr.band === "hold" ? "text-red-700" : k.egfr.band === "hydrate" ? "text-amber-800" : ""}>eGFR {k.egfr.egfr} · {t(`radiology.bay.band.${k.egfr.band}`)}</b>
                : <span>{t("radiology.bay.kidney.noEgfr")}</span>}
            </p>
          )}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="tag">{t("radiology.bay.weight")}</span><p className="m-0 mt-1">{view.weight === null ? "—" : `${view.weight.kg} kg`}</p></div>
        <div><span className="tag">{t("radiology.bay.lmp")}</span><p className="m-0 mt-1">{view.lmpDate?.slice(0, 10) ?? "—"}</p></div>
      </div>
      <div className="text-xs">
        <span className="tag">{t("radiology.bay.studyTag")}</span>
        <p className="m-0 mt-1">{view.study.studyTypeName} · {view.study.deviceCode ?? "—"} · {view.study.scheduledAt === null ? "—" : fmtIst(view.study.scheduledAt)}</p>
      </div>
    </div>
  );
}

function PrepBrief(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded border bg-card p-3 text-sm" data-testid="prep-brief">
      <p className="m-0 font-semibold">{t("radiology.bay.briefTitle")}</p>
      <p className="m-0">{t("radiology.bay.brief")}</p>
    </div>
  );
}

function GateRow(props: {
  gate: WirePrepGate; view: WirePrepStudy; open: boolean; busy: boolean; canWaive: boolean; actorId: string | null;
  onOpen: () => void; onSatisfy: (evidence: Record<string, unknown>) => void;
  asking: string | null; onAskStart: (note: string) => void; onAskNote: (note: string) => void; onAskSend: () => void; onAskCancel: () => void;
  waiving: string | null; onWaiveStart: () => void; onWaiveReason: (r: string) => void; onWaiveSend: () => void; onWaiveCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { gate: g } = props;
  const terminal = g.state !== "open";
  const line = evidenceLine(t, g);
  const pill = terminal
    ? (g.state === "satisfied" ? "border-green-700 text-green-800" : "border-amber-600 text-amber-800")
    : g.asked !== null ? "border-sky-600 text-sky-800" : "border-red-600 text-red-700";
  return (
    <div className={`rounded border bg-card p-2 ${props.open && !terminal && !g.room ? "border-green-700" : ""}`} data-testid={`gate-${g.kind}`} data-state={g.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="min-w-0 text-left" onClick={props.onOpen} disabled={terminal || g.room}>
          <b className="text-sm">{t(`radiology.gate.${g.kind}`, { defaultValue: g.kind })}</b>{" "}
          <span className={`rounded border px-1 text-xs ${pill}`}>
            {g.asked !== null && !terminal ? t("radiology.bay.askedPill") : t(`radiology.bay.state.${g.state}`, { defaultValue: g.state })}
          </span>
        </button>
        {!terminal && g.room && <span className="text-xs text-muted-foreground" data-testid="room-gate">{t("radiology.bay.room")}</span>}
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{t(`radiology.bay.what.${g.kind}`, { defaultValue: "" })}</p>
      {line !== null && <p className="m-0 mt-1 text-xs">{line}</p>}
      {!terminal && !g.room && g.asked !== null && (
        <p className="m-0 mt-1 rounded border border-sky-200 bg-sky-50 p-1 text-xs" data-testid="gate-asked">
          {t("radiology.bay.askedLine", { who: g.asked.requesterName ?? "—", note: g.asked.note ?? "" })}
        </p>
      )}
      {!terminal && !g.room && props.open && g.asked === null && (
        <div className="mt-2 space-y-2" id={`gate-form-${g.kind}`}>
          <GateEvidenceForm gate={g} ctx={props.view} onSubmit={props.onSatisfy} busy={props.busy} actorId={props.actorId}
            onAsk={(note) => { props.onAskStart(note); }} />
          <div className="flex flex-wrap gap-2 border-t pt-2">
            {g.waivable && !g.neverWaive && props.canWaive && props.waiving === null && (
              <button type="button" className="rounded border px-2 py-1 text-xs" onClick={props.onWaiveStart}>{t("radiology.bay.waive")}</button>
            )}
            {!g.neverOverride && props.asking === null && (
              <button type="button" className="rounded border border-amber-600 px-2 py-1 text-xs" data-testid="ask-radiologist"
                onClick={() => { props.onAskStart(""); }}>{t("radiology.bay.ask")}</button>
            )}
            {g.neverOverride && <span className="text-xs text-muted-foreground">{t("radiology.bay.neverOverride")}</span>}
          </div>
          {props.waiving !== null && (
            <div className="space-y-1">
              <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.waiveReason")}
                <input className="rounded border px-2 py-1 text-sm" value={props.waiving} onChange={(e) => { props.onWaiveReason(e.target.value); }} />
              </label>
              <div className="flex gap-2">
                <button type="button" className="rounded bg-amber-700 px-2 py-1 text-xs text-white disabled:opacity-50" disabled={props.waiving.trim() === "" || props.busy} onClick={props.onWaiveSend}>{t("radiology.bay.waiveSend")}</button>
                <button type="button" className="rounded border px-2 py-1 text-xs" onClick={props.onWaiveCancel}>{t("radiology.bay.cancel")}</button>
              </div>
            </div>
          )}
          {props.asking !== null && (
            <div className="space-y-1" data-testid="ask-form">
              <label className="flex flex-col gap-1 text-xs font-medium">{t("radiology.bay.askNote")}
                <textarea className="rounded border px-2 py-1 text-sm" rows={2} value={props.asking} maxLength={400}
                  onChange={(e) => { props.onAskNote(e.target.value); }} data-testid="ask-note" />
              </label>
              <div className="flex gap-2">
                <button type="button" className="rounded bg-amber-700 px-2 py-1 text-xs text-white disabled:opacity-50" data-testid="ask-send"
                  disabled={props.asking.trim() === "" || props.busy} onClick={props.onAskSend}>{t("radiology.bay.askSend")}</button>
                <button type="button" className="rounded border px-2 py-1 text-xs" onClick={props.onAskCancel}>{t("radiology.bay.cancel")}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
