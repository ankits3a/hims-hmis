import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  askPaperRecheck, checkPaperCorrection, confirmPaperConsult, correctPaperConsult, fetchPaperConsults, reopenPaperConsult,
} from "../lib/opd-api";
import { fmtIst, useDebounced } from "../lib/format";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { PaperSlipPane } from "../components/paper-slip";
import { EMPTY_LINE, PaperLinesEditor, alertText, cleanLines, incompleteAt, startedLines } from "../components/paper-lines";
import type { WireHeldAlert, WirePaperConsult, WireRxLine } from "../lib/opd-api";
import "./paper-consult.css";

/**
 * ═══ CONSULTED ON PAPER — THE DOCTOR'S LOOK AND THE SUPERVISOR'S REOPEN (OWNER RULING 2026-10-06) ═══
 *
 * The visits a desk closed from the doctor's paper today. Two readers, one list:
 *
 *   · THE DOCTOR sees their own. Nothing here holds a patient — they left with their medicines on
 *     ruling A — so this is a list to glance down, not a queue to clear. One tap says "looks
 *     right". "Correct it" opens what the desk typed beside the photographed page. The ONE thing
 *     that does wait for the doctor is a line the desk could not send because it raised a warning:
 *     those visits come first, and only the doctor can give the reason that releases the line (or
 *     drop it).
 *   · THE SUPERVISOR sees every doctor's, and can put back in the line a patient whose visit was
 *     closed on the wrong paper.
 */

function nameOf(r: WirePaperConsult): string {
  return (r.patient.restricted ? r.patient.alias : r.patient.name) ?? r.patient.alias ?? r.patient.uhid;
}
function lineText(l: WireRxLine): string {
  return [l.drug, l.dose, l.frequency, l.durationDays === null ? null : `${String(l.durationDays)} d`, l.route === "oral" ? null : l.route, l.instructions]
    .filter((x): x is string => x !== null && x.trim() !== "").join(" · ");
}
function refusal(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  const body = e instanceof ApiError ? (e.body as { code?: unknown } | null) : null;
  const code = body !== null && typeof body === "object" && typeof body.code === "string" ? body.code : null;
  return code !== null ? t(`paper.refusal.${code}`, { defaultValue: t("paper.refusal.other") }) : t("paper.refusal.other");
}

function Correction({ row, onDone, onCancel }: { row: WirePaperConsult; onDone: () => void; onCancel: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [lines, setLines] = useState<WireRxLine[]>(() => {
    /* What the desk typed, what it could not send, and what the doctor had typed on screen and never issued. */
    const all = [...(row.prescription?.lines ?? []), ...(row.held?.lines ?? []), ...(row.doctorDraft ?? [])];
    return all.length > 0 ? all : [{ ...EMPTY_LINE }];
  });
  const [alerts, setAlerts] = useState<Map<number, WireHeldAlert[]>>(new Map());
  const [reasons, setReasons] = useState<Map<number, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = useDebounced(JSON.stringify(startedLines(lines).map((x) => [x.line.drug.trim(), x.line.medicineId ?? null])), 400);
  useEffect(() => {
    const now = startedLines(lines);
    if (now.length === 0) { setAlerts(new Map()); return; }
    let live = true;
    void checkPaperCorrection(row.encounterId, cleanLines(lines))
      .then((r) => { if (live) setAlerts(new Map(r.lines.flatMap((x) => (now[x.lineIndex] === undefined ? [] : [[now[x.lineIndex]!.at, x.alerts] as const])))); })
      .catch(() => { if (live) setAlerts(new Map()); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the debounced `lines`
  }, [key, row.encounterId]);

  const started = startedLines(lines);
  const incomplete = incompleteAt(lines);
  const owed = [...alerts.entries()].filter(([at, a]) => a.some((x) => x.hard) && (reasons.get(at) ?? "").trim().length < 3).length;
  const canSave = !busy && incomplete.length === 0 && owed === 0 && (started.length > 0 || row.held !== null);

  async function save(): Promise<void> {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      /* The server's index is into the STARTED lines, so the reasons are re-keyed to that order. */
      const order = new Map(started.map((x, i) => [x.at, i] as const));
      await correctPaperConsult(row.encounterId, {
        lines: cleanLines(lines),
        reasons: [...reasons.entries()]
          .filter(([at, r]) => order.has(at) && r.trim() !== "")
          .map(([at, r]) => ({ lineIndex: order.get(at)!, reason: r.trim() })),
      });
      onDone();
    } catch (e) {
      setError(refusal(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pcl-edit" data-testid={`paper-correct-${row.encounterId}`}>
      <p className="pc-note">{t("paper.list.correctHint")}</p>
      <PaperLinesEditor
        idPrefix={`fix-${row.encounterId}`} lines={lines} onChange={setLines} alerts={alerts}
        reasons={reasons} onReason={(at, r) => { setReasons((m) => new Map(m).set(at, r)); }}
      />
      {error !== null && <p className="pc-bad" role="alert" data-testid="paper-correct-error">{error}</p>}
      <div className="pcl-acts">
        <button type="button" className="pri" disabled={!canSave} data-testid="paper-correct-save" onClick={() => { void save(); }}>
          {started.length === 0 ? t("paper.list.dropHeld") : t("paper.list.saveCorrection")}
        </button>
        <button type="button" className="sec" onClick={onCancel}>{t("paper.list.cancel")}</button>
        {owed > 0 && <span className="pc-bad">{t("paper.list.reasonsOwed", { count: owed })}</span>}
        {incomplete.length > 0 && <span className="pc-bad">{t("scribe.dock.incomplete", { count: incomplete.length })}</span>}
      </div>
    </div>
  );
}

/** The doctor sends what the desk typed BACK, with a reason — instead of retyping it themselves (decision 0043). */
function Recheck({ row, onDone, onCancel }: { row: WirePaperConsult; onDone: () => void; onCancel: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go(): Promise<void> {
    if (reason.trim().length < 3 || busy) return;
    setBusy(true); setError(null);
    try { await askPaperRecheck(row.encounterId, reason.trim()); onDone(); } catch (e) { setError(refusal(t, e)); } finally { setBusy(false); }
  }
  return (
    <div className="pcl-edit" data-testid={`paper-recheck-${row.encounterId}`}>
      <p className="pc-note">{t("paper.list.recheckHint")}</p>
      <label className="pc-l" htmlFor={`recheck-${row.encounterId}`}>{t("paper.list.recheckReason")}</label>
      <input
        id={`recheck-${row.encounterId}`} className="in" autoFocus value={reason} data-testid="paper-recheck-reason" maxLength={500}
        placeholder={t("paper.list.recheckReasonHint")}
        onChange={(e) => { setReason(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
      />
      {error !== null && <p className="pc-bad" role="alert">{error}</p>}
      <div className="pcl-acts">
        <button type="button" className="pri" disabled={reason.trim().length < 3 || busy} data-testid="paper-recheck-go" onClick={() => { void go(); }}>{t("paper.list.recheckGo")}</button>
        <button type="button" className="sec" onClick={onCancel}>{t("paper.list.cancel")}</button>
      </div>
    </div>
  );
}

function Reopen({ row, onDone, onCancel }: { row: WirePaperConsult; onDone: () => void; onCancel: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [withdraw, setWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = row.prescription !== null && row.prescription.transcribedByName !== null;
  async function go(): Promise<void> {
    if (reason.trim().length < 3 || busy) return;
    setBusy(true); setError(null);
    try {
      await reopenPaperConsult(row.encounterId, { reason: reason.trim(), ...(typed && withdraw ? { voidTranscription: true } : {}) });
      onDone();
    } catch (e) { setError(refusal(t, e)); } finally { setBusy(false); }
  }
  return (
    <div className="pcl-edit" data-testid={`paper-reopen-${row.encounterId}`}>
      <p className="pc-note gd">{t("paper.list.reopenHint", { name: nameOf(row) })}</p>
      <label className="pc-l" htmlFor={`reopen-${row.encounterId}`}>{t("paper.list.reopenReason")}</label>
      <input
        id={`reopen-${row.encounterId}`} className="in" autoFocus value={reason} data-testid="paper-reopen-reason"
        placeholder={t("paper.list.reopenReasonHint")}
        onChange={(e) => { setReason(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } }}
      />
      {typed && (
        <label className="pcl-check">
          <input type="checkbox" checked={withdraw} onChange={(e) => { setWithdraw(e.target.checked); }} data-testid="paper-reopen-withdraw" />
          <span>{t("paper.list.reopenWithdraw")}</span>
        </label>
      )}
      {error !== null && <p className="pc-bad" role="alert">{error}</p>}
      <div className="pcl-acts">
        <button type="button" className="pri" disabled={reason.trim().length < 3 || busy} data-testid="paper-reopen-go" onClick={() => { void go(); }}>{t("paper.list.reopenGo")}</button>
        <button type="button" className="sec" onClick={onCancel}>{t("paper.list.cancel")}</button>
      </div>
    </div>
  );
}

export function PaperConsults(): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const queryClient = useQueryClient();
  const supervisor = can("opd.queue.transfer");
  const doctor = can("opd.consult");
  /* Chosen, or the login's own default once it is known: a doctor's list is theirs; a supervisor who is not a doctor reads the hospital's. */
  const [chosen, setScope] = useState<"mine" | "all" | null>(null);
  const scope: "mine" | "all" = chosen ?? (doctor || !supervisor ? "mine" : "all");
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "correct" | "reopen" | "recheck">("view");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["paper", "consults", scope],
    queryFn: () => fetchPaperConsults(scope),
    enabled: actor !== null,
    refetchInterval: 30_000,
    retry: false,
  });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const refresh = (): void => { setMode("view"); void queryClient.invalidateQueries({ queryKey: ["paper"] }); };

  const counts = {
    held: items.filter((r) => r.held !== null).length,
    unseen: items.filter((r) => r.held === null && r.confirmedAt === null).length,
    seen: items.filter((r) => r.confirmedAt !== null && r.held === null).length,
  };

  async function looksRight(r: WirePaperConsult): Promise<void> {
    setBusy(r.encounterId); setError(null);
    try { await confirmPaperConsult(r.encounterId); refresh(); }
    catch (e) { setError(refusal(t, e)); }
    finally { setBusy(null); }
  }

  return (
    <PaperScreen testId="paper-consults" style={{ height: "var(--pp-h)" }}>
      <div className="pc" style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div className="pc-top">
          <ScreenTitle
            title={t("paper.list.title")}
            subtitle={scope === "mine" ? t("paper.list.subtitleMine") : t("paper.list.subtitleAll")}
            actions={supervisor && doctor ? (
              <div className="pcl-seg" role="group" aria-label={t("paper.list.scope")}>
                <button type="button" className={scope === "mine" ? "on" : undefined} aria-pressed={scope === "mine"} onClick={() => { setScope("mine"); setOpen(null); }}>{t("paper.list.scopeMine")}</button>
                <button type="button" className={scope === "all" ? "on" : undefined} aria-pressed={scope === "all"} onClick={() => { setScope("all"); setOpen(null); }}>{t("paper.list.scopeAll")}</button>
              </div>
            ) : undefined}
          />
          <div className="pcl-tiles" data-testid="paper-counts">
            <div className={counts.held > 0 ? "pcl-tile rd" : "pcl-tile"}><b>{counts.held}</b><span>{t(scope === "mine" ? "paper.list.tileHeld" : "paper.list.tileHeldAll")}</span></div>
            <div className="pcl-tile"><b>{counts.unseen}</b><span>{t("paper.list.tileUnseen")}</span></div>
            <div className="pcl-tile"><b>{counts.seen}</b><span>{t("paper.list.tileSeen")}</span></div>
          </div>
        </div>

        <div className="pcl-body">
          {list.isPending ? <p className="pc-note">{t("app.loading")}</p>
            : list.isError ? <p className="pc-bad" role="alert">{t("paper.list.failed")}</p>
            : items.length === 0 ? <p className="pc-note" data-testid="paper-empty">{scope === "mine" ? t("paper.list.emptyMine") : t("paper.list.emptyAll")}</p>
            : null}
          {error !== null && <p className="pc-bad" role="alert">{error}</p>}
          <ul className="pcl-list">
            {items.map((r) => {
              const isOpen = open === r.encounterId;
              const typedBy = r.prescription?.transcribedByName ?? null;
              return (
                <li key={r.encounterId} className={isOpen ? "pcl-row open" : "pcl-row"} data-testid={`paper-row-${r.visitNo}`}>
                  <button
                    type="button" className="pcl-head" aria-expanded={isOpen}
                    onClick={() => { setOpen(isOpen ? null : r.encounterId); setMode("view"); setError(null); }}
                  >
                    <span className="pcl-tok mo">{r.tokenNo === null ? "—" : `#${String(r.tokenNo)}`}</span>
                    <span className="pcl-name">
                      <b>{nameOf(r)}</b>
                      <span className="mo">{r.patient.uhid} · {r.visitNo}{scope === "all" && r.doctorCode !== null ? ` · ${r.doctorCode}` : ""}</span>
                    </span>
                    <span className="pcl-how">
                      {r.completedVia === "paper"
                        ? t(r.evidenceKind === "slip_photo" ? "paper.list.closedByPhoto" : "paper.list.closedByTyping", { name: r.paperCompletedByName ?? "—", at: r.paperCompletedAt === null ? "" : fmtIst(r.paperCompletedAt) })
                        : t("paper.list.typedOnly", { name: typedBy ?? "—" })}
                    </span>
                    <span className="pcl-pills">
                      {r.held !== null && <span className="pill rd" data-testid="paper-pill-held">{t("paper.list.pillHeld", { count: r.held.lines.length })}</span>}
                      {(r.doctorDraft ?? []).length > 0 && <span className="pill gd" data-testid="paper-pill-draft">{t("paper.list.pillDraft")}</span>}
                      {r.held === null && r.confirmedAt === null && <span className="pill">{t("paper.list.pillUnseen")}</span>}
                      {r.recheck != null && r.recheck.doneAt === null && <span className="pill gd" data-testid="paper-pill-sent-back">{t("paper.list.pillSentBack")}</span>}
                      {r.recheck != null && r.recheck.doneAt !== null && <span className="pill gr" data-testid="paper-pill-rechecked">{t("paper.list.pillRechecked")}</span>}
                      {r.confirmedAt !== null && <span className="pill gr" data-testid="paper-pill-seen">{t("paper.list.pillSeen", { at: fmtIst(r.confirmedAt) })}</span>}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="pcl-open">
                      <div className="pcl-paper">
                        <PaperSlipPane patientId={r.patient.id} encounterId={r.encounterId} pages={r.documents.map((d) => ({ id: d.id, capturedAt: d.capturedAt }))} />
                      </div>
                      <div className="pcl-typed">
                        {mode === "correct" ? (
                          <Correction row={r} onDone={refresh} onCancel={() => { setMode("view"); }} />
                        ) : mode === "recheck" ? (
                          <Recheck row={r} onDone={refresh} onCancel={() => { setMode("view"); }} />
                        ) : mode === "reopen" ? (
                          <Reopen row={r} onDone={() => { setOpen(null); refresh(); }} onCancel={() => { setMode("view"); }} />
                        ) : (
                          <>
                            {r.held !== null && (
                              <div className="pcl-block held" data-testid="paper-held">
                                <h3>{t("paper.list.heldTitle", { count: r.held.lines.length })}</h3>
                                <ul>
                                  {r.held.lines.map((l, i) => (
                                    <li key={i}>
                                      <b>{lineText(l)}</b>
                                      {(r.held!.alerts[i] ?? []).map((a, k) => <span key={k} className="pcl-why">{alertText(t, a)}</span>)}
                                    </li>
                                  ))}
                                </ul>
                                {r.held.note !== null && <p className="pcl-noteline">{t("paper.list.scribeNote", { note: r.held.note })}</p>}
                              </div>
                            )}
                            {(r.doctorDraft ?? []).length > 0 && (
                              <div className="pcl-block draft" data-testid="paper-doctor-draft">
                                <h3>{t("paper.list.draftTitle", { count: (r.doctorDraft ?? []).length })}</h3>
                                <ul>{(r.doctorDraft ?? []).map((l, i) => <li key={i}>{lineText(l)}</li>)}</ul>
                                <p className="pcl-noteline">{t("paper.list.draftHint")}</p>
                              </div>
                            )}
                            {r.recheck != null && (
                              <div className="pcl-block draft" data-testid="paper-recheck-state">
                                <h3>{t(r.recheck.doneAt === null ? "paper.list.sentBackTitle" : "paper.list.recheckedTitle", { name: r.recheck.doneByName ?? "—" })}</h3>
                                <p className="pcl-noteline">{t("paper.list.sentBackReason", { reason: r.recheck.reason })}</p>
                                {r.recheck.doneAt !== null && r.recheck.doneNote !== null && <p className="pcl-noteline">{t("paper.list.recheckedNote", { note: r.recheck.doneNote })}</p>}
                              </div>
                            )}
                            <div className="pcl-block">
                              <h3>{t("paper.list.medicines")}</h3>
                              {r.prescription === null ? <p className="pc-note">{t("paper.list.noMedicines")}</p> : (
                                <>
                                  <p className="pcl-by" data-testid="paper-typed-by">
                                    {typedBy !== null ? t("paper.typedBy", { name: typedBy }) : t("paper.list.byDoctor")}
                                  </p>
                                  <ol>{r.prescription.lines.map((l, i) => <li key={i}>{lineText(l)}</li>)}</ol>
                                </>
                              )}
                            </div>
                            {r.advisedTests.length > 0 && (
                              <div className="pcl-block">
                                <h3>{t("paper.list.tests")}</h3>
                                <ul className="pcl-tests">
                                  {r.advisedTests.map((x) => (
                                    <li key={x.serviceId}>{x.name}{x.transcribedByName != null ? <span className="pcl-why">{t("paper.typedBy", { name: x.transcribedByName })}</span> : null}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div className="pcl-acts">
                              {scope === "mine" && (
                                <>
                                  <button
                                    type="button" className="pri" data-testid="paper-looks-right"
                                    disabled={r.held !== null || r.confirmedAt !== null || busy === r.encounterId}
                                    title={r.held !== null ? t("paper.list.looksRightHeld") : undefined}
                                    onClick={() => { void looksRight(r); }}
                                  >{r.confirmedAt !== null ? t("paper.list.looked") : t("paper.list.looksRight")}</button>
                                  <button type="button" className="sec" data-testid="paper-correct" onClick={() => { setMode("correct"); }}>
                                    {r.held !== null ? t("paper.list.decideHeld") : t("paper.list.correct")}
                                  </button>
                                  <button type="button" className="sec" data-testid="paper-ask-recheck" onClick={() => { setMode("recheck"); }}>
                                    {t("paper.list.askRecheck")}
                                  </button>
                                </>
                              )}
                              {supervisor && r.completedVia === "paper" && (
                                <button type="button" className="sec" data-testid="paper-reopen" onClick={() => { setMode("reopen"); }}>{t("paper.list.reopen")}</button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </PaperScreen>
  );
}
