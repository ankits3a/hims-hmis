import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchRecording } from "../lib/opd-reports-api";
import { useAuth } from "../lib/auth";
import { onRecord, recordedPercent, recordingState } from "../../../../packages/contracts/src/recording";
import type { RecordingCounts, RecordingRow } from "../../../../packages/contracts/src/recording";
import type { Selection } from "../lib/opd-reports-api";
import "./recording-card.css";

/**
 * "IS TODAY BEING RECORDED?" — owner, 2026-10-07: "Yes, show a daily count on the screens."
 *
 * Every figure is the server's (`/opd/reports/recording`); this only words them. The lead sentence
 * says the state in words — a bar alone would be colour — and the card draws NOTHING for a login the
 * server answers `none`, or while the read is unanswered, so a screen never waits on it.
 */
function useRecording(sel: Selection) {
  const { actor } = useAuth();
  const who = actor?.id ?? "";
  return useQuery({
    queryKey: ["opd-recording", who, sel.period, sel.date], queryFn: () => fetchRecording(sel),
    enabled: who !== "", refetchInterval: 60_000, retry: false,
  });
}

function Lead({ c, mine }: { c: RecordingCounts; mine: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const state = recordingState(c);
  if (state === "nothing_yet") return <span className="rec-lead" data-testid="rec-lead">{t(mine ? "recording.nothingYetMine" : "recording.nothingYet")}</span>;
  if (state === "all") return <span className="rec-lead ok" data-testid="rec-lead">{t("recording.allOnRecord", { count: c.consulted })}</span>;
  return <span className="rec-lead bad" data-testid="rec-lead">{t("recording.notRecorded", { count: c.notRecorded, of: c.consulted })}</span>;
}

function Facts({ c }: { c: RecordingCounts }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="rec-facts" data-testid="rec-facts">
      <span><b>{c.consulted}</b> {t("recording.f.consulted")}</span>
      <span><b>{c.issued}</b> {t("recording.f.issued")}</span>
      <span><b>{c.photographed}</b> {t("recording.f.photographed")}</span>
      <span><b>{c.typed}</b> {t("recording.f.typed")}</span>
      {c.toType > 0 ? <span><b>{c.toType}</b> {t("recording.f.toType")}</span> : null}
      {c.stillOpen > 0 ? <span><b>{c.stillOpen}</b> {t("recording.f.stillOpen")}</span> : null}
    </div>
  );
}

/** The compact card — My Day. */
export function RecordingCard({ date }: { date: string }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useRecording({ period: "day", date });
  const r = q.data;
  if (r === undefined || r.scope === "none" || r.totals === null) return null;
  const mine = r.scope === "mine";
  const c = r.totals;
  const pct = recordedPercent(c);
  return (
    <section className="rec" data-testid="rec-card" data-scope={r.scope}>
      <div className="rec-h"><h3>{t(mine ? "recording.titleMine" : "recording.title")}</h3><span>{t(mine ? "recording.scopeMine" : "recording.scopeHospital")}</span></div>
      <Lead c={c} mine={mine} />
      {pct === null ? null : (
        <div className="rec-bar" role="img" aria-label={t("recording.barLabel", { on: onRecord(c), of: c.consulted })}><i style={{ width: `${pct}%` }} /></div>
      )}
      <Facts c={c} />
      {!mine && r.mine !== null && r.mine.consulted > 0 ? (
        <p className="rec-note" data-testid="rec-mine">{t("recording.yours", { consulted: r.mine.consulted, issued: r.mine.issued, paper: r.mine.onPaper, photographed: r.mine.photographed, not: r.mine.notRecorded })}</p>
      ) : null}
      {r.doctors !== null ? <a className="rec-act" href="/opd/report">{t("recording.byDoctor")}</a> : null}
      <p className="rec-note">{t("recording.note")}</p>
    </section>
  );
}

function Row({ r, first }: { r: RecordingCounts; first: React.ReactNode }): React.ReactElement {
  const cell = (n: number, bad = false): React.ReactElement => <td className={n === 0 ? "zero" : bad ? "bad" : undefined}>{n}</td>;
  return <tr><td>{first}</td>{cell(r.consulted)}{cell(r.issued)}{cell(r.photographed)}{cell(r.typed)}{cell(r.notRecorded, true)}</tr>;
}

function Table({ rows, head, testId }: { rows: (RecordingCounts & { key: string; label: string })[]; head: string; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="rec-scroll">
      <table className="rec-table" data-testid={testId}>
        <thead><tr>
          <th>{head}</th><th>{t("recording.col.consulted")}</th><th>{t("recording.col.issued")}</th>
          <th>{t("recording.col.photographed")}</th><th>{t("recording.col.typed")}</th><th>{t("recording.col.notRecorded")}</th>
        </tr></thead>
        <tbody>{rows.map((r) => <Row key={r.key} r={r} first={r.label} />)}</tbody>
      </table>
    </div>
  );
}

const keyed = (rows: RecordingRow[]): (RecordingCounts & { key: string; label: string })[] => rows.map((r) => ({ ...r, key: r.id, label: r.name }));

/** The panel — the OPD report: the same card, then by day (a week or month), by department, by doctor. */
export function RecordingPanel({ sel }: { sel: Selection }): React.ReactElement | null {
  const { t } = useTranslation();
  const q = useRecording(sel);
  const r = q.data;
  if (r === undefined || r.scope !== "hospital" || r.totals === null) return null;
  const c = r.totals;
  const pct = recordedPercent(c);
  return (
    <section className="rec" data-testid="rec-panel">
      <div className="rec-h"><h3>{t("recording.title")}</h3><span>{t("recording.panelSub")}</span></div>
      <Lead c={c} mine={false} />
      {pct === null ? null : <div className="rec-bar" role="img" aria-label={t("recording.barLabel", { on: onRecord(c), of: c.consulted })}><i style={{ width: `${pct}%` }} /></div>}
      <Facts c={c} />
      {r.days.length > 0 ? (<><p className="rec-sub">{t("recording.byDay")}</p><Table testId="rec-days" head={t("recording.col.day")} rows={r.days.map((d) => ({ ...d, key: d.date, label: d.date.split("-").reverse().join("-") }))} /></>) : null}
      {r.doctors !== null && r.doctors.length > 0 ? (<><p className="rec-sub">{t("recording.byDoctorHead")}</p><Table testId="rec-doctors" head={t("recording.col.doctor")} rows={keyed(r.doctors)} /></>) : null}
      {r.departments !== null && r.departments.length > 0 ? (<><p className="rec-sub">{t("recording.byDepartment")}</p><Table testId="rec-departments" head={t("recording.col.department")} rows={keyed(r.departments)} /></>) : null}
      <p className="rec-note">{t("recording.note")} {t("recording.screenNote")}</p>
    </section>
  );
}
