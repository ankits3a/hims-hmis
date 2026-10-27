import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { IpdEmarDueList, IpdHandoverDraft, IpdMyShift, IpdRefusalBody, IpdShiftHandoverList, IpdShiftItem } from "@hmis/contracts";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { refusalOf } from "../lib/ipd-beds-api";
import { acceptShiftHandover, getHandoverDraft, getMyShift, getShiftHandovers, giveShiftHandover } from "../lib/ipd-nursing-api";
import { buildSbarDraft } from "../lib/ipd-copilot-api";
import type { SbarText } from "../lib/ipd-nursing-api";
import { getDue, scan } from "../lib/ipd-emar-api";
import { endMyDuty, wardErrorOf } from "../lib/ipd-ward-api";
import { recordCareCheck, recordRestraintCheck } from "../lib/ipd-ward-safety-api";
import type { RestraintTicks } from "../lib/ipd-ward-safety-api";
import { PickWardPrompt, WardPicker, useWardChoice } from "../components/ward-picker";
import { Bedside, DueDoses, ScanBox } from "./ipd-emar-bedside";
import { LiveLine, VitalsForm, ageFromAgeSex, dueWords, savedWords, useLiveLoad, useNight } from "./ipd-nursing-shared";
import type { T } from "./ipd-nursing-shared";
import "./ipd-nursing.css";

/**
 * E4.1 (#733) — BOARD D1, MY SHIFT ON THE NURSE'S PHONE (spec SPEC-ipd-core §4.9 D). 390 px, one hand, gloves: every
 * target 48 px, the acts at the bottom in the thumb zone, text that still fits at 130 %.
 *
 * Header: ward, shift, my patients. The Now list in time order — early-warning alerts, overdue vitals, assessments
 * due, handovers — each with bed, patient and a countdown in words. A patient opens the vitals entry (the score shows
 * as the numbers are typed; the numbers read back large before Save). Handover: "N ready" → each patient's SBAR drafted
 * from the record (every line with its source) → edit → Give; and the handovers waiting for me (never one I gave).
 *
 * OFFLINE: vitals queue (up to 30 minutes, stamped with the time taken) and send themselves when the network returns.
 * Every other act is off with a few words. Phone notices are a few words on one line (owner rule).
 */

const TICK_MS = 30_000;
type Mode = { kind: "list" } | { kind: "vitals"; admissionId: string } | { kind: "handover" }
  // E4.3 (#735) — board D2: the bedside (doses) and the wristband scan that pivots to a patient.
  | { kind: "bedside"; admissionId: string; band: string | null } | { kind: "scan" }
  // WM-2 (#983) — a care-plan check (fall bundle / turn) or a restraint check, from the Now list.
  | { kind: "safety"; item: IpdShiftItem };

export function IpdMyShift(): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [shift, setShift] = useState<IpdMyShift | null>(null);
  const [handovers, setHandovers] = useState<IpdShiftHandoverList | null>(null);
  const [due, setDue] = useState<IpdEmarDueList | null>(null);
  const [scanRefusal, setScanRefusal] = useState<string | null>(null);
  const [error, setError] = useState<"forbidden" | null>(null);
  const pick = useWardChoice();
  const wardId = pick.wardId;
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => Promise.all([
    getMyShift(wardId).then((s) => { setShift(s); setError(null); setNow(Date.now()); }),
    getShiftHandovers(wardId).then(setHandovers, () => setHandovers(null)),
    can("ipd.emar.view") ? getDue(wardId).then(setDue, () => setDue(null)) : Promise.resolve(),
  ]).catch((e: unknown) => { if (e instanceof ApiError && e.status === 403) setError("forbidden"); throw e; }), [wardId, can]);
  const live = useLiveLoad(load);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(id); }, []);
  const [night, flipNight] = useNight(shift?.night);

  const patient = mode.kind === "vitals" ? shift?.patients.find((p) => p.identity.admissionId === mode.admissionId) ?? null : null;
  // Nothing remembered and more than one ward: ask, never show the server's first ward as "mine".
  const asking = shift !== null && pick.needsPick(shift.wards);
  const toAccept = (handovers?.handovers ?? []).filter((h) => !h.givenByViewer);

  return (
    <main className={`ipdn ipdn-phone${night ? " night" : ""}`} data-testid="ipd-my-shift">
      <header className="ipdn-phead">
        <div className="ipdn-prow">
          <b className="ipdn-wardname">{(asking ? null : shift?.ward?.name) ?? t("ipdNursing.shiftPage.title")}</b>
          <button type="button" className="ipdn-btn sm" aria-pressed={night} onClick={flipNight} data-testid="ipdn-night-toggle">{night ? "☾" : "☀"}<span className="sr">{night ? t("ipdNursing.night") : t("ipdNursing.day")}</span></button>
        </div>
        {shift !== null ? (
          <div className="ipdn-prow dim">
            <span>{t(`ipdNursing.shift.${shift.shift.key}`)} · {fmtIst(shift.shift.startsAt)}–{fmtIst(shift.shift.endsAt)}</span>
            <span>{t("ipdNursing.shiftPage.patients", { count: shift.patients.length })}</span>
          </div>
        ) : null}
        <LiveLine online={live.online} lastUpdate={live.lastUpdate} />
        {shift !== null && shift.wards.length > 1 ? (
          <WardPicker wards={shift.wards} value={asking ? null : shift.ward?.id ?? null} onChange={pick.choose} />
        ) : null}
      </header>
      {notice === null ? null : notice === t("ipdNursing.noDoctorReached")
        // Review walk: "No doctor reached — call" is a warning to act on, never a success tick.
        ? <div className="ipdn-warn" role="alert" data-testid="ipdn-notice">☎ {notice}</div>
        : <div className="ipdn-ok" role="status" data-testid="ipdn-notice">✓ {notice}</div>}
      {error === "forbidden" ? <div className="ipdn-empty" role="alert">{t("ipdNursing.forbidden")}</div> : null}
      {shift === null && error === null ? <div className="ipdn-empty">{t("ipdNursing.loading")}</div> : null}

      {asking ? <PickWardPrompt className="ipdn-empty" /> : null}
      {mode.kind === "list" && shift !== null && !asking ? (
        <>
          {due !== null ? <DueDoses items={due.items} now={now} onOpen={(id) => { setNotice(null); setMode({ kind: "bedside", admissionId: id, band: null }); }} /> : null}
          <section aria-label={t("ipdNursing.shiftPage.now")}>
            <h2 className="ipdn-h2">{t("ipdNursing.shiftPage.now")}</h2>
            {shift.now.length === 0 ? <div className="ipdn-empty">{t("ipdNursing.shiftPage.nothingDue")}</div> : null}
            <ul className="ipdn-now" data-testid="ipdn-now">
              {shift.now.map((i) => <NowItem key={`${i.kind}-${i.refId ?? i.admissionId}`} i={i} now={now}
                onOpen={() => {
                  setNotice(null);
                  setMode(i.kind === "handover" ? { kind: "handover" } : i.kind === "care_check" || i.kind === "restraint_check" ? { kind: "safety", item: i } : { kind: "vitals", admissionId: i.admissionId });
                }} />)}
            </ul>
          </section>
          <section aria-label={t("ipdNursing.shiftPage.patientsTitle")}>
            <h2 className="ipdn-h2">{t("ipdNursing.shiftPage.patientsTitle")}</h2>
            {/* WM-1 (#982): before the ward's first published map the list is the ward's, and says so. */}
            {shift.assignment === "ward" ? <p className="ipdn-warn" data-testid="ipdn-no-assignment">{t("ipdWard.myShift.noAssignment")}</p> : null}
            {shift.assignment === "none" ? <p className="dim" data-testid="ipdn-no-beds">{t("ipdWard.myShift.noBeds")}</p> : null}
            <ul className="ipdn-now">
              {shift.patients.map((p) => (
                <li key={p.identity.admissionId}>
                  <button type="button" className="ipdn-nowbtn" onClick={() => { setNotice(null); setMode({ kind: "vitals", admissionId: p.identity.admissionId }); }}>
                    <span className="bed mono">{p.bedCode ?? "—"}</span>
                    <span className="nm">{p.identity.name}</span>
                    <span className="dim">{t(`ipdNursing.kind.${p.scoreKind}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {shift.assignment !== undefined && shift.assignment !== "ward" && shift.ward !== null ? (
            <EndDuty wardId={shift.ward.id} beds={shift.patients.length} onEnded={(w) => { setNotice(w); void load().catch(() => undefined); }} />
          ) : null}
        </>
      ) : null}

      {mode.kind === "vitals" && patient !== null ? (
        <section className="ipdn-pane" aria-label={t("ipdNursing.v.title")}>
          <div className="ipdn-idhead">
            <b>{patient.identity.name}</b> <span className="dim">{patient.identity.ageSex}</span>
            <div className="dim">{[patient.bedCode, patient.identity.uhid ? `UHID ${patient.identity.uhid}` : null].filter(Boolean).join(" · ")}</div>
          </div>
          <VitalsForm admissionId={patient.identity.admissionId} kind={patient.scoreKind} ageYears={ageFromAgeSex(patient.identity.ageSex)} label={patient.identity.name}
            onCancel={() => setMode({ kind: "list" })}
            onDone={(d) => { setNotice(savedWords(d, t as T)); setMode({ kind: "list" }); if (!d.queued) void load().catch(() => undefined); }} />
        </section>
      ) : null}

      {mode.kind === "scan" ? (
        <section className="ipdn-pane" aria-label={t("ipdEmar.bedside.scanBand")}>
          <ScanBox label={t("ipdEmar.bedside.scanBand")} testId="ipde-pivot-input" onCode={(code) => {
            setScanRefusal(null);
            scan({ wristbandCode: code }).then((r) => { try { navigator.vibrate?.(80); } catch { /* not a phone */ } setMode({ kind: "bedside", admissionId: r.admissionId, band: code }); },
              (e: unknown) => setScanRefusal(refusalOf(e)?.rule ?? t("ipdNursing.actFailed")));
          }} />
          {scanRefusal !== null ? <div className="ipdn-refusal" role="alert">{scanRefusal}</div> : null}
          <footer className="ipdn-thumb"><button type="button" className="ipdn-btn wide" onClick={() => setMode({ kind: "list" })}>{t("ipdNursing.back")}</button></footer>
        </section>
      ) : null}

      {mode.kind === "bedside" ? (
        <Bedside key={`${mode.admissionId}-${mode.band ?? ""}`} admissionId={mode.admissionId} bandCode={mode.band} online={live.online}
          onBack={() => setMode({ kind: "list" })}
          onPivot={(id, band) => setMode({ kind: "bedside", admissionId: id, band: band === "" ? null : band })}
          onDone={(w) => { setNotice(w); void load().catch(() => undefined); }} />
      ) : null}

      {mode.kind === "safety" ? (
        <SafetyCheckPane item={mode.item} online={live.online} onBack={() => setMode({ kind: "list" })}
          onDone={(w) => { setNotice(w); setMode({ kind: "list" }); void load().catch(() => undefined); }} />
      ) : null}

      {mode.kind === "handover" && shift !== null ? (
        <HandoverPane shift={shift} toAccept={toAccept} online={live.online} onBack={() => setMode({ kind: "list" })}
          onDone={(w) => { setNotice(w); void load().catch(() => undefined); }} />
      ) : null}

      {mode.kind === "list" && shift !== null ? (
        <footer className="ipdn-thumb ipdn-thumb2">
          {can("ipd.emar.give") ? (
            <button type="button" className="ipdn-btn pri wide ipde-scanbtn" onClick={() => { setScanRefusal(null); setMode({ kind: "scan" }); }} data-testid="ipde-scan-open">⌗ {t("ipdEmar.scan")}</button>
          ) : null}
          {asking ? null : (
            <button type="button" className="ipdn-btn wide" onClick={() => setMode({ kind: "handover" })} data-testid="ipdn-handover-open">
              {t("ipdNursing.handover.ready", { count: shift.patients.length })}{toAccept.length > 0 ? ` · ${t("ipdNursing.handover.toAccept", { count: toAccept.length })}` : ""}
            </button>
          )}
        </footer>
      ) : null}
    </main>
  );
}

function NowItem({ i, now, onOpen }: { i: IpdShiftItem; now: number; onOpen: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const late = i.overdue || new Date(i.dueAt).getTime() < now;
  return (
    <li className={`k-${i.kind}${late ? " late" : ""}`}>
      <button type="button" className="ipdn-nowbtn" onClick={onOpen} data-testid={`ipdn-now-${i.kind}-${i.admissionId}`}>
        <span className="bed mono">{i.bedCode ?? "—"}</span>
        <span className="nm">{i.name}</span>
        <span className="what">{late ? "⚠ " : ""}{i.kind === "ews" && i.band !== null
          ? `${t("ipdNursing.alert", { band: t(`ipdNursing.band.${i.band}`) })}`
          : dueWords(i.kind, i.dueAt, now, t as T)}</span>
      </button>
    </li>
  );
}

const RESTRAINT_TICKS = ["circulation", "skin", "hydration", "toileting"] as const;

/** WM-2 (#983) — record a care-plan check, or a restraint check with its four ticks, for one patient. */
function SafetyCheckPane({ item, online, onBack, onDone }: { item: IpdShiftItem; online: boolean; onBack: () => void; onDone: (words: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [ticks, setTicks] = useState<RestraintTicks>({ circulation: false, skin: false, hydration: false, toileting: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const restraint = item.kind === "restraint_check";
  const save = async (): Promise<void> => {
    if (item.refId === null) return;
    setBusy(true); setFailed(false);
    try {
      if (restraint) await recordRestraintCheck(item.refId, ticks); else await recordCareCheck(item.refId);
      onDone(t("ipdSafety.myShift.saved", { bed: item.bedCode ?? t("ipdWard.bed") }));
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <section className="ipdn-pane" aria-label={t(`ipdNursing.due.${item.kind}`)} data-testid="ipdn-safety-pane">
      <div className="ipdn-idhead"><b>{item.name}</b> <span className="dim">{item.bedCode ?? "—"}</span></div>
      <h2 className="ipdn-h2">{t(`ipdNursing.due.${item.kind}`)}</h2>
      {restraint ? (
        <fieldset className="ipdn-ticks">
          {RESTRAINT_TICKS.map((k) => (
            <label key={k}><input type="checkbox" checked={ticks[k]} onChange={(e) => setTicks({ ...ticks, [k]: e.target.checked })} /> {t(`ipdSafety.restraint.tick.${k}`)}</label>
          ))}
        </fieldset>
      ) : <p className="dim">{t("ipdSafety.myShift.careHint")}</p>}
      {failed ? <div className="ipdn-refusal" role="alert">{t("ipdNursing.actFailed")}</div> : null}
      {!online ? <div className="ipdn-warn">{t("ipdNursing.offlineActs")}</div> : null}
      <footer className="ipdn-thumb">
        <button type="button" className="ipdn-btn pri wide" disabled={busy || !online} onClick={() => void save()} data-testid="ipdn-safety-save">{t("ipdSafety.myShift.done")}</button>
        <button type="button" className="ipdn-btn wide" onClick={onBack}>{t("ipdNursing.back")}</button>
      </footer>
    </section>
  );
}

const EMPTY_SBAR: SbarText = { situation: "", background: "", assessment: "", recommendation: "" };
const SBAR_KEYS = ["situation", "background", "assessment", "recommendation"] as const;

function HandoverPane({ shift, toAccept, online, onBack, onDone }: {
  shift: IpdMyShift; toAccept: IpdShiftHandoverList["handovers"]; online: boolean; onBack: () => void; onDone: (words: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<IpdHandoverDraft | null>(null);
  const [sbar, setSbar] = useState<SbarText>(EMPTY_SBAR);
  const [given, setGiven] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<IpdRefusalBody | null>(null);
  const [stale, setStale] = useState(false);
  const mayAct = online && can("ipd.handover.shift");

  const textOf = (d: IpdHandoverDraft): SbarText => ({
    situation: d.situation.map((l) => l.text).join("\n"), background: d.background.map((l) => l.text).join("\n"),
    assessment: d.assessment.map((l) => l.text).join("\n"), recommendation: d.recommendation.map((l) => l.text).join("\n"),
  });
  const picked = useRef<string | null>(null);
  const prefill = useRef<SbarText>(EMPTY_SBAR);
  const [building, setBuilding] = useState(false);
  /** Fill the form from a draft — never over the nurse's own edits. */
  const show = (d: IpdHandoverDraft, force: boolean): void => {
    const next = textOf(d);
    const before = prefill.current;
    setDraft(d);
    setSbar((now) => (force || SBAR_KEYS.every((k) => now[k] === before[k]) ? next : now));
    prefill.current = next;
  };
  /** Build (and keep) a draft: on the nurse's tap, or when the records changed since the kept one. */
  const build = (id: string): void => {
    setBuilding(true); setRefusal(null);
    buildSbarDraft(id).then((kept) => { setBuilding(false); if (picked.current === id) show(kept, false); }, () => setBuilding(false));
  };
  const pick = (id: string): void => {
    setAdmissionId(id); setDraft(null); setRefusal(null); setStale(false);
    picked.current = id; prefill.current = EMPTY_SBAR;
    // READ FIRST: the kept draft of this shift when the records are unchanged, else the record's own lines. A new draft
    // is built only when the records moved on since the kept one — or when the nurse asks for one.
    getHandoverDraft(id).then((d) => {
      if (picked.current !== id) return;
      show(d, true);
      if (d.changedSinceDraft) build(id);
    }, () => setSbar(EMPTY_SBAR));
  };
  const give = (): void => {
    if (admissionId === null) return;
    setBusy(true); setRefusal(null);
    // A kept copilot draft is named so the signed handover keeps its provenance; a typed one names none.
    (draft?.draftId ? giveShiftHandover(admissionId, sbar, draft.draftId) : giveShiftHandover(admissionId, sbar)).then(() => {
      setBusy(false); setGiven(new Set([...given, admissionId])); setAdmissionId(null); onDone(t("ipdNursing.handover.given"));
    }, (e: unknown) => {
      setBusy(false);
      // The records changed after the draft was built: say so and offer the rebuild (the nurse's words stay in the form).
      if (e instanceof ApiError && (e.body as { code?: string } | null)?.code === "shift_handover_draft_stale") setStale(true);
      else setRefusal(refusalOf(e));
    });
  };
  const accept = (handoverId: string): void => {
    setBusy(true); setRefusal(null);
    acceptShiftHandover(handoverId).then(() => { setBusy(false); onDone(t("ipdNursing.handover.accepted")); }, (e: unknown) => { setBusy(false); setRefusal(refusalOf(e)); });
  };
  const sbarFilled = SBAR_KEYS.every((k) => sbar[k].trim() !== "");

  return (
    <section className="ipdn-pane" aria-label={t("ipdNursing.handover.title")} data-testid="ipdn-handover">
      {!online ? <p className="ipdn-warn">⚠ {t("ipdNursing.offlineActs")}</p> : null}
      {toAccept.length > 0 ? (
        <>
          <h2 className="ipdn-h2">{t("ipdNursing.handover.waiting")}</h2>
          <ul className="ipdn-cards">
            {toAccept.map((h) => (
              <li key={h.handoverId} className="ipdn-card" data-testid={`ipdn-shift-handover-${h.handoverId}`}>
                <div><span className="mono">{h.bedCode ?? "—"}</span> · <b>{h.identity.name}</b></div>
                <div className="dim">{t("ipdNursing.handover.from", { name: h.givenBy.name, time: fmtIst(h.givenAt) })}</div>
                {h.draft != null ? (
                  <div className="dim ipdn-prov" data-testid="ipdn-handover-prov">
                    {t("ipdCopilot.sbar.signedFrom", { model: h.draft.modelId ?? t("ipdCopilot.template"), version: h.draft.promptVersion })}
                    {" · "}{t("ipdCopilot.sbar.builtBy", { name: h.draft.builtBy.name })}
                    {h.draft.edited === null ? null : <> · {t(h.draft.edited ? "ipdCopilot.sbar.edited" : "ipdCopilot.sbar.unedited")}</>}
                  </div>
                ) : null}
                <dl className="ipdn-sbar">{SBAR_KEYS.map((k) => <div key={k}><dt>{t(`ipdNursing.sbar.${k}`)}</dt><dd>{h.sbar[k]}</dd></div>)}</dl>
                <button type="button" className="ipdn-btn pri wide" disabled={busy || !mayAct} onClick={() => accept(h.handoverId)}>{t("ipdNursing.handover.accept")}</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2 className="ipdn-h2">{t("ipdNursing.handover.give")}</h2>
      {admissionId === null ? (
        <ul className="ipdn-now">
          {shift.patients.map((p) => (
            <li key={p.identity.admissionId}>
              <button type="button" className="ipdn-nowbtn" disabled={!mayAct || given.has(p.identity.admissionId)} onClick={() => pick(p.identity.admissionId)}>
                <span className="bed mono">{p.bedCode ?? "—"}</span>
                <span className="nm">{p.identity.name}</span>
                <span className="what">{given.has(p.identity.admissionId) ? `✓ ${t("ipdNursing.handover.done")}` : t("ipdNursing.handover.draft")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <form className="ipdn-form" onSubmit={(e) => { e.preventDefault(); if (sbarFilled) give(); }}>
          {draft?.stamp != null ? (
            <p className="ipdn-stamp" data-testid="ipdn-sbar-stamp">
              <b>{t("ipdCopilot.draft")}</b> · {draft.stamp.modelId ?? t("ipdCopilot.template")} · {draft.stamp.promptVersion} · {t("ipdCopilot.builtAt", { time: fmtIst(draft.stamp.builtAt) })}
              <span className="dim"> — {t("ipdCopilot.sbar.youSign")}</span>
            </p>
          ) : null}
          {draft !== null && draft.truncated.length > 0 ? <p className="ipdn-warn" role="alert">⚠ {t("ipdCopilot.truncated", { lists: draft.truncated.join(", ") })}</p> : null}
          {stale ? <p className="ipdn-warn" role="alert" data-testid="ipdn-sbar-stale">⚠ {t("ipdCopilot.sbar.stale")}</p> : null}
          {draft !== null && (draft.draftId === null || stale) ? (
            <button type="button" className="ipdn-btn" disabled={building || !mayAct} data-testid="ipdn-sbar-build"
              onClick={() => { setStale(false); if (admissionId !== null) build(admissionId); }}>
              {building ? t("ipdCopilot.sbar.building") : t(stale ? "ipdCopilot.sbar.rebuild" : "ipdCopilot.sbar.build")}
            </button>
          ) : null}
          {SBAR_KEYS.map((k) => (
            <label key={k}>{t(`ipdNursing.sbar.${k}`)}
              {draft !== null && draft[k].length > 0 ? (
                <span className="ipdn-chiprow">{[...new Set(draft[k].map((l) => l.source))].map((s) => <span key={s} className="ipdn-src">{t(`ipdNursing.sbarSource.${s}`)}</span>)}{draft[k].some((l) => l.by === "model") ? <span className="ipdn-src ai">{t("ipdCopilot.since.ai")}</span> : null}</span>
              ) : null}
              <textarea rows={3} value={sbar[k]} onChange={(e) => setSbar({ ...sbar, [k]: e.target.value })} />
            </label>
          ))}
          <div className="ipdn-acts">
            <button type="button" className="ipdn-btn" onClick={() => setAdmissionId(null)}>{t("ipdNursing.cancel")}</button>
            <button type="submit" className="ipdn-btn pri" disabled={busy || !sbarFilled || !mayAct}>{t("ipdNursing.handover.giveBtn")}</button>
          </div>
        </form>
      )}
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal.rule}</div> : null}
      <footer className="ipdn-thumb"><button type="button" className="ipdn-btn wide" onClick={onBack}>{t("ipdNursing.back")}</button></footer>
    </section>
  );
}

/**
 * WM-1 (#982) — "End my duty": refused while the nurse still holds a bed on the live map (the in-charge or she hands
 * each to a named registered nurse first). Two taps: the first asks, the second ends.
 */
function EndDuty({ wardId, beds, onEnded }: { wardId: string; beds: number; onEnded: (words: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const end = (): void => {
    setRefusal(null);
    endMyDuty(wardId).then(() => { setAsking(false); onEnded(t("ipdWard.myShift.ended")); }, (e: unknown) => {
      const w = wardErrorOf(e);
      setRefusal(w === null ? t("ipdNursing.actFailed") : t(`ipdWard.err.${w.code}`, { defaultValue: t("ipdWard.err.other") }));
      setAsking(false);
    });
  };
  return (
    <section className="ipdn-thumb" aria-label={t("ipdWard.myShift.endDuty")}>
      {beds > 0 ? <p className="dim">{t("ipdWard.myShift.handFirst")}</p> : null}
      <button type="button" className={`ipdn-btn wide${asking ? " pri" : ""}`} onClick={() => (asking ? end() : setAsking(true))} data-testid="ipdn-end-duty">
        {asking ? t("ipdWard.myShift.confirmEnd") : t("ipdWard.myShift.endDuty")}
      </button>
      {refusal !== null ? <div className="ipdn-refusal" role="alert">{refusal}</div> : null}
    </section>
  );
}
