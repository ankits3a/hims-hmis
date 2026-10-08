import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { checkPaperLines, fetchPaperSentBack, fetchPaperVisit, resolvePaperRecheck, transcribePaper } from "../lib/opd-api";
import { useDebounced } from "../lib/format";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { UnpaidMark } from "../components/unpaid-mark";
import { PaperSlipPane } from "../components/paper-slip";
import { EMPTY_LINE, PaperLinesEditor, alertText, cleanLines, incompleteAt, startedLines } from "../components/paper-lines";
import type { SlipReadback } from "../../../../packages/contracts/src/slip-desk";
import type {
  WireAdvisedTest, WireHeldAlert, WirePaperOutcome, WirePriceListRow, WireRxLine, WireTranscription,
} from "../lib/opd-api";
import "./paper-consult.css";

/**
 * ═══ THE DESK SCRIBE — THE DOCTOR'S PAPER, TYPED (OWNER RULINGS 2026-09-12 AND 2026-10-06) ═══
 *
 * 2026-09-12: *"doctors … just write manually by pen on the prescription slip. So we must give
 * access to a staff who could enter details on behalf of doctor."* 2026-10-06: *"some of my doctors
 * … are struggling to type … let's enable it [the Desk Scribe] to type the drugs as well as lab
 * tests … typing the prescriptions … will mark the patient as Consulted even if the doctor hasn't
 * … operated dashboard."* And ruling A: the pharmacy may dispense from what is typed here.
 *
 * SO THIS SEAT NO LONGER WRITES A DRAFT THAT WAITS FOR A TAP. One save:
 *   · issues the medicines that raise no hard warning (to the pharmacy, in the doctor's name,
 *     marked "typed from paper");
 *   · HOLDS any medicine that does raise one, for the doctor — this seat cannot clear a warning and
 *     the screen says so beside the line before the save, not after;
 *   · puts the tests where the lab and imaging counters read them;
 *   · marks the visit consulted.
 *
 * ═══ THE PAPER IS ON THE SCREEN ═══
 *
 * When the slip desk has photographed the page it sits on the left, zoomable, and the scribe types
 * from it. When nobody has, the pane says so and the scribe types from the paper in their hand.
 *
 * ═══ THE READ-BACK IS STILL THE SAFETY CONTROL, AND IT IS STILL THE SERVER'S ═══
 *
 * Nothing is typed against a visit until the server has named the patient. A prescription typed
 * against the wrong visit is dispensed to the wrong person.
 *
 * ═══ NO MOUSE ═══
 *
 * Scan or type the visit → Enter. Tab through a line; Enter adds the next line; ↓↑ pick a
 * suggestion. Tests: type, Enter picks the first match. Ctrl+Enter saves. Enter on the result
 * starts the next slip.
 */

type VisitFee = { feeUnpaid?: boolean; feeBypass?: { by: string; reason: string; at: string } | null };

const VISIT_NO = /^V\d{6,}$/i;
const CONSULTED: ReadonlySet<WirePaperOutcome> = new Set<WirePaperOutcome>(["marked", "already_marked", "doctor_completed"]);

/**
 * WHAT THE DOCTORS SENT BACK (decision 0043). A doctor read what this desk typed from their paper
 * and asked for another look, with a reason. It sits here until the desk retypes it (the save is the
 * answer) or says "I have looked again". Nothing is held meanwhile — the pharmacy already has the lines.
 */
function SentBack({ onOpen }: { onOpen: (visitNo: string) => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["paper", "sent-back"], queryFn: fetchPaperSentBack, refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  if (items.length === 0) return null;
  async function looked(id: string): Promise<void> {
    setBusy(id);
    try { await resolvePaperRecheck(id, null); } catch { /* the list re-reads and says what stands */ } finally {
      setBusy(null); void queryClient.invalidateQueries({ queryKey: ["paper"] });
    }
  }
  return (
    <div className="box pc-find-box" data-testid="scribe-sent-back">
      <span className="pc-find-l">{t("scribe.sentBack.title", { count: items.length })}</span>
      <ul className="pc-choices">
        {items.map((r) => (
          <li key={r.encounterId} data-testid={`scribe-sent-back-${r.visitNo}`}>
            <button type="button" onClick={() => { onOpen(r.visitNo); }}>
              <b>{r.patient.restricted || r.patient.name === null ? (r.patient.alias ?? r.patient.uhid) : r.patient.name}</b>
              <span className="mo">{r.patient.uhid} · {r.visitNo}{r.doctorCode !== null ? ` · ${r.doctorCode}` : ""}</span>
              <span className="pc-hint">{t("scribe.sentBack.reason", { reason: r.recheck?.reason ?? "" })}</span>
            </button>
            <button type="button" className="sec" disabled={busy === r.encounterId} data-testid={`scribe-looked-${r.visitNo}`} onClick={() => { void looked(r.encounterId); }}>
              {t("scribe.sentBack.looked")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function nameOf(back: SlipReadback): string {
  return back.patient?.name ?? back.patient?.alias ?? back.patient?.uhid ?? "—";
}

function errorCode(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body as { code?: unknown } | null;
  return body !== null && typeof body === "object" && typeof body.code === "string" ? body.code : null;
}

export function OpdScribe(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const findRef = useRef<HTMLInputElement | null>(null);
  const testRef = useRef<HTMLInputElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  const [typed, setTyped] = useState("");
  const [looking, setLooking] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [choices, setChoices] = useState<SlipReadback[] | null>(null);
  const [back, setBack] = useState<SlipReadback | null>(null);

  const [lines, setLines] = useState<WireRxLine[]>([{ ...EMPTY_LINE }]);
  const [tests, setTests] = useState<WireAdvisedTest[]>([]);
  const [testQuery, setTestQuery] = useState("");
  const [testAt, setTestAt] = useState(0);
  const [note, setNote] = useState("");
  const [alerts, setAlerts] = useState<Map<number, WireHeldAlert[]>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ back: SlipReadback; out: WireTranscription } | null>(null);
  const prefilled = useRef<string | null>(null);

  const encounterId = back?.encounterId ?? null;
  const state = useQuery({
    queryKey: ["paper", "visit", encounterId ?? ""],
    queryFn: () => fetchPaperVisit(encounterId!),
    enabled: encounterId !== null,
    retry: false,
  });
  const fee = useQuery({
    queryKey: ["scribe", "fee", encounterId ?? ""],
    queryFn: () => api<VisitFee>("GET", `/opd/visits/${encodeURIComponent(encounterId!)}`),
    enabled: encounterId !== null,
    retry: false,
  });
  const services = useQuery({
    queryKey: ["tariff", "price-list"],
    queryFn: () => api<{ items: WirePriceListRow[] }>("GET", "/tariff/price-list"),
    enabled: encounterId !== null,
    retry: false,
  });

  /* The doctor issued this visit's prescription on the screen: the desk types no medicines over it. */
  const doctorIssued = state.data?.prescription != null && state.data.prescription.transcribedByName === null;

  /*
    WHAT THIS DESK ALREADY TYPED COMES BACK INTO THE TABLE, ONCE. A second save replaces the first,
    so a scribe correcting line 2 must see lines 1 and 3 or they would be typed away.
  */
  useEffect(() => {
    const s = state.data;
    if (s === undefined || prefilled.current === s.encounterId) return;
    prefilled.current = s.encounterId;
    const typedBefore = s.prescription !== null && s.prescription.transcribedByName !== null ? s.prescription.lines : [];
    const heldBefore = s.held?.lines ?? [];
    const all = [...typedBefore, ...heldBefore];
    setLines(all.length > 0 ? all : [{ ...EMPTY_LINE }]);
    setTests(s.advisedTests.filter((x) => x.transcribedBy !== undefined).map((x) => ({ serviceId: x.serviceId, code: x.code, name: x.name, pricePaise: x.pricePaise })));
    setNote(s.held?.note ?? "");
  }, [state.data]);

  /* The warnings for what is typed so far — asked for a beat after the typing stops. */
  const started = useMemo(() => startedLines(lines), [lines]);
  const checkKey = useDebounced(JSON.stringify(started.map((x) => [x.line.drug.trim(), x.line.medicineId ?? null])), 450);
  useEffect(() => {
    if (encounterId === null || doctorIssued) { setAlerts(new Map()); return; }
    const now = startedLines(lines);
    if (now.length === 0) { setAlerts(new Map()); return; }
    let live = true;
    void checkPaperLines(encounterId, cleanLines(lines))
      .then((r) => {
        if (!live) return;
        /* The server's index is into the STARTED lines; the table's is into every row. */
        setAlerts(new Map(r.lines.flatMap((x) => (now[x.lineIndex] === undefined ? [] : [[now[x.lineIndex]!.at, x.alerts] as const]))));
      })
      .catch(() => { if (live) setAlerts(new Map()); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `checkKey` IS the debounced `lines`
  }, [checkKey, encounterId, doctorIssued]);

  /* Synchronous, for the reason `PaperLinesEditor` gives: a scanner fires the next slip's number the instant Enter lands. */
  const reset = (): void => {
    flushSync(() => {
      setBack(null); setTyped(""); setNotFound(null); setChoices(null);
      setLines([{ ...EMPTY_LINE }]); setTests([]); setTestQuery(""); setNote(""); setAlerts(new Map());
      setError(null); setDone(null);
    });
    prefilled.current = null;
    findRef.current?.focus();
  };

  const take = (found: SlipReadback): void => {
    setBack(found); setChoices(null); setNotFound(null); setError(null);
    setTimeout(() => { document.getElementById("scribe-drug-0")?.focus(); }, 0);
  };

  async function find(): Promise<void> { await findVisit(typed); }
  async function findVisit(raw: string): Promise<void> {
    const v = raw.trim();
    if (v === "" || looking) return;
    setLooking(true); setNotFound(null); setChoices(null);
    try {
      if (VISIT_NO.test(v.replace(/\s+/g, ""))) {
        take(await api<SlipReadback>("GET", `/opd/visits/by-number/${encodeURIComponent(v.replace(/\s+/g, "").toUpperCase())}`));
        return;
      }
      /* Not a visit number — a torn slip. Today's visits by name, UHID or mobile, and the scribe picks. */
      const { items } = await api<{ items: SlipReadback[] }>("GET", `/opd/slips/find?q=${encodeURIComponent(v)}`);
      if (items.length === 1) take(items[0]!);
      else if (items.length === 0) setNotFound(v);
      else setChoices(items);
    } catch {
      setNotFound(v);
    } finally {
      setLooking(false);
    }
  }

  const matches = useMemo(() => {
    const q = testQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return (services.data?.items ?? [])
      .filter((sv) => sv.name.toLowerCase().includes(q) || sv.code.toLowerCase().includes(q))
      .filter((sv) => !tests.some((x) => x.serviceId === sv.serviceId))
      .slice(0, 8);
  }, [services.data, testQuery, tests]);
  const addTest = (sv: WirePriceListRow): void => {
    setTests((prev) => [...prev, { serviceId: sv.serviceId, code: sv.code, name: sv.name, pricePaise: sv.pricePaise }]);
    setTestQuery(""); setTestAt(0);
    testRef.current?.focus();
  };

  const incomplete = incompleteAt(lines);
  const usable = cleanLines(lines);
  const medicines = doctorIssued ? [] : usable;
  const heldCount = [...alerts.entries()].filter(([, a]) => a.some((x) => x.hard)).length;
  const nothing = medicines.length === 0 && tests.length === 0;
  const canSave = back !== null && !busy && !nothing && (doctorIssued || incomplete.length === 0);

  async function save(): Promise<void> {
    if (back === null || !canSave) return;
    setBusy(true); setError(null);
    try {
      const out = await transcribePaper(back.encounterId, {
        lines: medicines, ...(tests.length === 0 ? {} : { advisedTests: tests }), note: note.trim() === "" ? null : note.trim(),
      });
      setDone({ back, out });
      void queryClient.invalidateQueries({ queryKey: ["paper"] });
      void queryClient.invalidateQueries({ queryKey: ["opd", "slips", "today"] });
      setTimeout(() => nextRef.current?.focus(), 0);
    } catch (e) {
      /* STATED. A scribe who typed eight lines and saw the form clear would believe it was sent. */
      const code = errorCode(e);
      setError(code !== null ? t(`paper.refusal.${code}`, { defaultValue: t("paper.refusal.other") }) : t("paper.refusal.other"));
    } finally {
      setBusy(false);
    }
  }

  /* Ctrl+Enter saves from anywhere in the form. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && back !== null && done === null) { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  });

  const s = state.data;
  const status = s === undefined ? null
    : s.completedVia === "paper" ? "paper"
    : s.status === "completed" ? "doctor"
    : s.status === "in_consultation" ? "with_doctor"
    : s.status === "abandoned" ? "abandoned" : "open";

  return (
    <PaperScreen testId="opd-scribe" style={{ height: "var(--pp-h)" }}>
      <div className="pc" style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div className="pc-top">
          <ScreenTitle title={t("scribe.title")} subtitle={t("scribe.subtitle")} />
        </div>

        {back === null ? (
          <div className="pc-find">
            <div className="box pc-find-box">
              <label htmlFor="scribe-visit" className="pc-find-l">{t("scribe.findVisit")}</label>
              {/* One box. A wedge scanner types the QR's payload and Enter; a clerk types the same. */}
              <div className="pc-find-row">
                <input
                  id="scribe-visit" ref={findRef} data-testid="scribe-visit" className="in" autoFocus autoComplete="off" spellCheck={false}
                  value={typed} placeholder={t("scribe.findVisitHint")}
                  onChange={(e) => { setTyped(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }}
                />
                <button type="button" className="pri" data-testid="scribe-take" disabled={looking} onClick={() => { void find(); }}>
                  {t("scribe.open")} <span className="kb">⏎</span>
                </button>
              </div>
              {notFound !== null && <p data-testid="scribe-not-found" className="pc-bad" role="alert">{t("scribe.notFound", { id: notFound })}</p>}
              {choices !== null && (
                <ul className="pc-choices" data-testid="scribe-choices">
                  {choices.map((c) => (
                    <li key={c.encounterId}>
                      <button type="button" onClick={() => { take(c); }}>
                        <b>{nameOf(c)}</b>
                        <span className="mo">{c.patient?.uhid ?? "—"} · {c.visitNo}{c.doctorCode != null ? ` · ${c.doctorCode}` : ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <SentBack onOpen={(visitNo) => { setTyped(visitNo); void findVisit(visitNo); }} />
            <ul className="pc-how">
              <li>{t("scribe.how.type")}</li>
              <li>{t("scribe.how.held")}</li>
              <li>{t("scribe.how.consulted")}</li>
            </ul>
          </div>
        ) : done !== null ? (
          <div className="pc-find">
            <div className="box pc-done" data-testid="scribe-saved" role="status">
              <p className="pc-done-h">{t("scribe.done.title", { name: nameOf(done.back) })} <span className="mo">{done.back.visitNo}</span></p>
              <ul className="pc-done-l">
                {done.out.prescription !== null && (
                  <li className="ok" data-testid="scribe-done-sent">{t("scribe.done.sent", { count: done.out.prescription.lineCount })}</li>
                )}
                {done.out.held.length > 0 && (
                  <li className="held" data-testid="scribe-done-held">
                    {t("scribe.done.held", { count: done.out.held.length })}
                    <ul>{done.out.held.map((h, i) => <li key={i}><b>{h.line.drug}</b> — {h.alerts.map((a) => alertText(t, a)).join("; ")}</li>)}</ul>
                  </li>
                )}
                {done.out.advisedTests.some((x) => x.transcribedBy !== undefined) && (
                  <li className="ok" data-testid="scribe-done-tests">{t("scribe.done.tests", { count: done.out.advisedTests.filter((x) => x.transcribedBy !== undefined).length })}</li>
                )}
                <li className={CONSULTED.has(done.out.paper.outcome) ? "ok" : "held"} data-testid="scribe-done-paper" data-outcome={done.out.paper.outcome}>
                  {t(`paper.outcome.${done.out.paper.outcome}`)}
                </li>
              </ul>
              <button type="button" ref={nextRef} className="pri" data-testid="scribe-next" onClick={reset}>
                {t("scribe.next")} <span className="kb">⏎</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="pc-work">
            <div className="pc-paper">
              <PaperSlipPane
                patientId={back.patientId} encounterId={back.encounterId}
                {...(s === undefined ? {} : { pages: s.documents.map((d) => ({ id: d.id, capturedAt: d.capturedAt })) })}
                emptyHint={t("scribe.noPhoto")}
              />
            </div>

            <div className="pc-type">
              {/*
                ═══ THE READ-BACK. The scribe confirms the human whose paper this is against what the
                SERVER resolved — before a single line is typed.
              */}
              <div className="box pc-who" data-testid="scribe-readback">
                <div className="pc-who-main">
                  <span className="tag">{t("scribe.matched")}</span>
                  <b data-testid="scribe-name">{nameOf(back)}</b>
                  <span className="mo">{back.patient?.uhid ?? "—"} · {back.visitNo}{back.doctorCode != null ? ` · ${back.doctorCode}` : ""}{back.departmentName != null ? ` · ${back.departmentName}` : ""}</span>
                </div>
                <div className="pc-who-side">
                  <UnpaidMark unpaid={fee.data?.feeUnpaid ?? false} bypass={fee.data?.feeBypass ?? null} />
                  {status !== null && status !== "open" && (
                    <span className={status === "abandoned" ? "pill rd" : "pill"} data-testid="scribe-status" data-status={status}>{t(`scribe.status.${status}`, { name: s?.paperCompletedByName ?? "—" })}</span>
                  )}
                  <button type="button" className="sec" data-testid="scribe-release" onClick={reset}>{t("scribe.notThem")}</button>
                </div>
              </div>

              <div className="box pc-card">
                <div className="pc-card-h">
                  <h2>{t("scribe.medicines")}</h2>
                  <span className="pc-hint">{t("scribe.medicinesHint")}</span>
                </div>
                {doctorIssued ? (
                  <p className="pc-note gd" data-testid="scribe-doctor-issued" role="status">{t("scribe.doctorIssued")}</p>
                ) : (
                  <PaperLinesEditor idPrefix="scribe" lines={lines} onChange={setLines} alerts={alerts} nicknames={{ surface: "scribe", encounterId }} />
                )}
              </div>

              <div className="box pc-card">
                <div className="pc-card-h">
                  <h2>{t("scribe.tests")}</h2>
                  <span className="pc-hint">{t("scribe.testsHint")}</span>
                </div>
                <div className="pc-tests">
                  {tests.map((x) => (
                    <span key={x.serviceId} className="pc-chip" data-testid={`scribe-test-${x.code}`}>
                      {x.name}
                      <button type="button" tabIndex={-1} aria-label={t("scribe.removeTest", { name: x.name })} onClick={() => { setTests((prev) => prev.filter((y) => y.serviceId !== x.serviceId)); }}>×</button>
                    </span>
                  ))}
                  <div className="pc-test-in">
                    <input
                      ref={testRef} className="in" data-testid="scribe-test-q" value={testQuery} autoComplete="off"
                      role="combobox" aria-expanded={matches.length > 0} aria-controls="scribe-test-list" aria-autocomplete="list"
                      placeholder={services.isError ? t("scribe.testsUnavailable") : t("scribe.testsPlaceholder")}
                      disabled={services.isError}
                      onChange={(e) => { setTestQuery(e.target.value); setTestAt(0); }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowDown" && matches.length > 0) { e.preventDefault(); setTestAt((i) => Math.min(matches.length - 1, i + 1)); }
                        else if (e.key === "ArrowUp" && matches.length > 0) { e.preventDefault(); setTestAt((i) => Math.max(0, i - 1)); }
                        else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); const m = matches[testAt]; if (m !== undefined) addTest(m); }
                        else if (e.key === "Escape" && testQuery !== "") { e.stopPropagation(); setTestQuery(""); }
                        else if (e.key === "Backspace" && testQuery === "" && tests.length > 0) { setTests((prev) => prev.slice(0, -1)); }
                      }}
                    />
                    {matches.length > 0 && (
                      <ul id="scribe-test-list" role="listbox" className="pc-test-list" data-testid="scribe-test-hits">
                        {matches.map((m, i) => (
                          <li key={m.serviceId} role="option" aria-selected={i === testAt}>
                            <button type="button" tabIndex={-1} className={i === testAt ? "on" : undefined} onClick={() => { addTest(m); }}>
                              <span>{m.name}</span><span className="mo">{m.code}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>

              <div className="box pc-card">
                <label htmlFor="scribe-note" className="pc-l">{t("scribe.note")}</label>
                <input id="scribe-note" className="in" data-testid="scribe-note" value={note} placeholder={t("scribe.noteHint")} onChange={(e) => { setNote(e.target.value); }} />
              </div>
            </div>
          </div>
        )}

        {back !== null && done === null && (
          <div className="pc-dock" data-testid="scribe-dock">
            <div className="pc-dock-say">
              {error !== null ? <span className="pc-bad" data-testid="scribe-error" role="alert">{error}</span>
                : incomplete.length > 0 && !doctorIssued ? <span className="pc-bad" data-testid="scribe-incomplete">{t("scribe.dock.incomplete", { count: incomplete.length })}</span>
                : nothing ? <span>{t("scribe.dock.nothing")}</span>
                : (
                  <span data-testid="scribe-summary">
                    {[
                      Math.max(0, medicines.length - heldCount) > 0 ? t("scribe.dock.meds", { count: Math.max(0, medicines.length - heldCount) }) : null,
                      tests.length > 0 ? t("scribe.dock.tests", { count: tests.length }) : null,
                    ].filter((x) => x !== null).join(" · ")}
                    {heldCount > 0 && <b className="pc-held">{medicines.length - heldCount > 0 || tests.length > 0 ? " · " : ""}{t("scribe.dock.held", { count: heldCount })}</b>}
                  </span>
                )}
              <small>{t("scribe.dock.sub")}</small>
            </div>
            <button type="button" className="pri" data-testid="scribe-save" disabled={!canSave} onClick={() => { void save(); }}>
              {busy ? t("scribe.saving") : t("scribe.save")} <span className="kb">Ctrl ⏎</span>
            </button>
          </div>
        )}
      </div>
    </PaperScreen>
  );
}
