import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api";
import { fmtIst } from "../../lib/format";
import { istDay } from "./desk-time";
import { fetchReport, openImages, radiologyErrorCode, radiologyErrorText } from "../../lib/radiology-api";
import { ACTED_OUTCOMES, fetchImagingResults, markReportActed, readBackCritical } from "../../lib/radiology-release-api";
import type { ActedOutcome, WireInboxRow } from "../../lib/radiology-release-api";

/**
 * PLAN 18-S RS9 T3 — **THE DOCTOR'S IMAGING RESULTS** (board: "Doctor's door → Results / Report").
 *
 * Mounted by ONE line in `opd-consult.tsx`, in the centre the doctor sees between patients — where
 * the consult already answers "who is next" — so it is not a new department station and the consult
 * lane's screen carries no imaging logic.
 *
 * Criticals not yet read back come FIRST (red), then unread, then read-not-acted, then acted (the
 * server's order, `GET /radiology/results`). Opening a report is the read that lands: the server
 * stamps the first read for the TREATING doctor only and the 24-hour Unread Watchman stops.
 * "Mark acted upon" records what the report changed — the department's north-star clock stops there.
 *
 * The read-back goes through `POST /radiology/reports/:id/read-back`, which calls the same
 * `acknowledgeCritical` the reading room's route does: `radiology.criticals.ack` is the radiologist's
 * alone, and the doctor's own read-back is a treating-doctor act (RS9 DECIDED). A doctor who holds no
 * `radiology.reports.read` gets a 403 and the panel renders nothing.
 */

type Open = { row: WireInboxRow; mode: "report" | "acted" | "readback" };

function Pill({ tone, children }: { tone: "rd" | "gd" | "on" | ""; children: React.ReactNode }): React.ReactElement {
  return <span className={`pill ${tone}`} style={{ fontSize: 10.5 }}>{children}</span>;
}

export function ImagingResultsInbox(): React.ReactElement | null {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Open | null>(null);
  const [outcome, setOutcome] = useState<ActedOutcome>("changed_treatment");
  const [note, setNote] = useState("");
  const [readBack, setReadBack] = useState("");
  const [error, setError] = useState<{ code: string | null; message: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [imagesMsg, setImagesMsg] = useState<{ acc: string; text: string; bad: boolean } | null>(null);

  const q = useQuery({ queryKey: ["radiology", "results"], queryFn: fetchImagingResults, retry: false });
  const reportQ = useQuery({
    queryKey: ["radiology", "results", "report", open?.row.reportId ?? ""],
    queryFn: () => fetchReport(open!.row.reportId),
    enabled: open !== null && open.mode === "report",
    retry: false,
  });
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["radiology", "results"] }); };
  const fail = (e: unknown): void => { setError({ code: radiologyErrorCode(e), message: radiologyErrorText(e) }); };

  const acted = useMutation({
    mutationFn: (row: WireInboxRow) => markReportActed(row.reportId, { outcome, note: note.trim() }),
    onSuccess: (_r, row) => { setDone(t("radiology.results.actedDone", { acc: row.accessionNo })); setOpen(null); setNote(""); refresh(); },
    onError: fail,
  });
  const ack = useMutation({
    mutationFn: (row: WireInboxRow) => readBackCritical(row.reportId, readBack.trim()),
    onSuccess: (_r, row) => { setDone(t("radiology.results.readBackDone", { acc: row.accessionNo })); setOpen(null); setReadBack(""); refresh(); },
    onError: fail,
  });
  const images = useMutation({
    mutationFn: (row: WireInboxRow) => openImages(row.studyId),
    onSuccess: (r, row) => {
      setImagesMsg({ acc: row.accessionNo, text: t("radiology.results.imagesOpened"), bad: false });
      window.open(r.url, "_blank", "noopener");
      refresh();
    },
    onError: (e, row) => setImagesMsg({ acc: row.accessionNo, text: radiologyErrorText(e), bad: true }),
  });

  if (q.isError && q.error instanceof ApiError && q.error.status === 403) return null;
  const rows = q.data?.rows ?? [];
  const openCrit = rows.filter((r) => r.critical !== null && r.critical.acknowledgedAt === null);
  const unread = rows.filter((r) => r.state === "unread").length;
  const readNotActed = rows.filter((r) => r.state === "read").length;

  const start = (row: WireInboxRow, mode: Open["mode"]): void => {
    setOpen({ row, mode }); setError(null); setDone(null);
    if (mode === "report") refresh();
  };

  const statePill = (r: WireInboxRow): React.ReactElement => {
    if (r.state === "acted") return <Pill tone="on">{t("radiology.results.state.acted")}</Pill>;
    if (r.state === "read") return <Pill tone="gd">{t("radiology.results.state.read")}</Pill>;
    return <Pill tone={r.chasedAt !== null ? "rd" : "gd"}>{r.chasedAt !== null ? t("radiology.results.state.chased") : t("radiology.results.state.unread")}</Pill>;
  };

  const row = (r: WireInboxRow): React.ReactElement => {
    const critOpen = r.critical !== null && r.critical.acknowledgedAt === null;
    return (
      <li
        key={r.reportId} data-acc={r.accessionNo} data-state={r.state} data-crit={r.critical?.criticalId}
        style={{
          display: "flex", flexDirection: "column", gap: 4, padding: "9px 11px", borderTop: "1px solid var(--line)",
          ...(critOpen ? { background: "var(--red-soft)", boxShadow: "inset 3px 0 0 var(--red)" } : {}),
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 7 }}>
          <b style={{ fontSize: 13 }}>{r.patientName}</b>
          <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{r.uhid} · {r.studyName}</span>
          {r.critical !== null && (
            <Pill tone={critOpen ? "rd" : "on"}>
              {critOpen ? t("radiology.results.critical", { cat: r.critical.category.toUpperCase() }) : t("radiology.results.readBackClosed")}
            </Pill>
          )}
          {statePill(r)}
          {r.amended && <Pill tone="gd">{t("radiology.results.amended", { v: r.version })}</Pill>}
        </div>
        {r.impression !== null && <div style={{ fontSize: 12.5 }}>{r.impression}</div>}
        <div style={{ fontSize: 11, color: "var(--dim)" }} className="mo">
          {t("radiology.results.signedBy", { acc: r.accessionNo, at: `${istDay(r.signedAt)} ${fmtIst(r.signedAt)}`, who: r.signerName ?? "—" })}
        </div>
        {r.critical?.readBack != null && r.critical.acknowledgedAt !== null && (
          <div style={{ fontSize: 11.5, color: "var(--green)" }}>✓ {t("radiology.results.youReadBack", { text: r.critical.readBack })}</div>
        )}
        {r.acted !== null && (
          <div style={{ fontSize: 11.5, color: "var(--green)" }}>
            ✓ {t(`radiology.results.outcome.${r.acted.outcome}`)} — {r.acted.note} · {fmtIst(r.acted.at)}
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 3 }}>
          {critOpen && (
            <button type="button" className="pri" style={{ background: "var(--red)", borderColor: "var(--red)", padding: "3px 10px", fontSize: 12, height: 30 }} onClick={() => start(r, "readback")}>
              {t("radiology.results.readBack")}
            </button>
          )}
          <button type="button" className="sec" style={{ padding: "3px 10px", fontSize: 12, height: 30 }} onClick={() => start(r, "report")}>{t("radiology.results.openReport")}</button>
          <button type="button" className="sec" style={{ padding: "3px 10px", fontSize: 12, height: 30 }} disabled={images.isPending} onClick={() => { setImagesMsg(null); images.mutate(r); }}>
            {t("radiology.results.openImages")}
          </button>
          {r.state !== "acted" && (
            <button type="button" className="sec" style={{ padding: "3px 10px", fontSize: 12, height: 30, color: "var(--green)" }} onClick={() => start(r, "acted")}>
              {t("radiology.results.markActed")}
            </button>
          )}
        </div>
        {imagesMsg !== null && imagesMsg.acc === r.accessionNo && (
          <p role={imagesMsg.bad ? "alert" : "status"} style={{ margin: 0, fontSize: 11.5, color: imagesMsg.bad ? "var(--red)" : "var(--dim)" }}>{imagesMsg.text}</p>
        )}
        {open !== null && open.row.reportId === r.reportId && panel(open)}
      </li>
    );
  };

  const panel = (o: Open): React.ReactElement => {
    const r = o.row;
    const errorBox = error !== null && (
      <p role="alert" data-refusal={error.code ?? "unknown"} style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{error.message}</p>
    );
    if (o.mode === "acted") {
      return (
        <div data-testid="acted-form" className="box" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <b style={{ fontSize: 12.5 }}>{t("radiology.results.actedTitle")}</b>
          <div role="radiogroup" aria-label={t("radiology.results.actedTitle")} style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {ACTED_OUTCOMES.map((k) => (
              <button
                key={k} type="button" role="radio" aria-checked={outcome === k} className={outcome === k ? "pri" : "sec"}
                style={{ padding: "3px 10px", fontSize: 12, height: 30 }} onClick={() => setOutcome(k)}
              >
                {t(`radiology.results.outcome.${k}`)}
              </button>
            ))}
          </div>
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5 }}>
            {t("radiology.results.actedNote")}
            <input
              className="in" value={note} maxLength={500} placeholder={t("radiology.results.actedNotePh")}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && note.trim().length >= 4) acted.mutate(r); }}
            />
          </label>
          <span style={{ fontSize: 11, color: "var(--dim)" }}>{t("radiology.results.actedHint")}</span>
          {errorBox}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="pri" disabled={note.trim().length < 4 || acted.isPending} onClick={() => acted.mutate(r)}>{t("radiology.results.save")}</button>
            <button type="button" className="sec" onClick={() => setOpen(null)}>{t("radiology.results.cancel")}</button>
          </div>
        </div>
      );
    }
    if (o.mode === "readback") {
      return (
        <div data-testid="readback-form" className="box" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <b style={{ fontSize: 12.5 }}>{t("radiology.results.readBackTitle")}</b>
          {r.impression !== null && <div style={{ fontSize: 12.5 }}>{r.impression}</div>}
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5 }}>
            {t("radiology.results.readBackLabel")}
            <textarea className="in" rows={2} value={readBack} maxLength={1000} onChange={(e) => setReadBack(e.target.value)} />
          </label>
          {errorBox}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="pri" disabled={readBack.trim() === "" || ack.isPending} onClick={() => ack.mutate(r)}>{t("radiology.results.readBackSave")}</button>
            <button type="button" className="sec" onClick={() => setOpen(null)}>{t("radiology.results.cancel")}</button>
          </div>
        </div>
      );
    }
    const rep = reportQ.data?.report ?? null;
    return (
      <section data-testid="inbox-report" className="box" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        {reportQ.isPending && <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("radiology.results.loading")}</span>}
        {reportQ.isError && <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{radiologyErrorText(reportQ.error)}</p>}
        {rep !== null && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 13 }}>{r.studyName.toUpperCase()}</b>
              <span className="mo" style={{ fontSize: 11 }}>{rep.accessionNo} · v{rep.version}</span>
            </div>
            {rep.criticalCategory !== null && <Pill tone="rd">{t("radiology.results.critical", { cat: rep.criticalCategory.toUpperCase() })}</Pill>}
            {Object.entries(rep.body).filter(([k, v]) => k !== "impression" && typeof v === "string" && v.trim() !== "").map(([k, v]) => (
              <div key={k} style={{ fontSize: 12.5 }}><b style={{ textTransform: "capitalize" }}>{k.replace(/_/g, " ")}.</b> {String(v)}</div>
            ))}
            {rep.impression !== null && (
              <div style={{ fontSize: 12.5 }}><b>{t("radiology.results.impression")}.</b> <span style={{ fontWeight: 500 }}>{rep.impression}</span></div>
            )}
            {rep.amendmentReason !== null && <div style={{ fontSize: 11.5, color: "var(--gold)" }}>{t("radiology.results.amendedWhy", { why: rep.amendmentReason })}</div>}
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 6, fontSize: 11.5 }}>
              {t("radiology.results.signer", { who: r.signerName ?? "—", at: rep.signedAt === null ? "—" : fmtIst(rep.signedAt) })}
              <div style={{ color: "var(--dim)" }}>{t("radiology.results.signerNote")}</div>
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {r.state !== "acted" && <button type="button" className="pri" onClick={() => start(r, "acted")}>{t("radiology.results.markActed")}</button>}
          <button type="button" className="sec" onClick={() => setOpen(null)}>{t("radiology.results.close")}</button>
        </div>
      </section>
    );
  };

  return (
    <section data-testid="imaging-results" className="box" style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 8, minWidth: 0, marginTop: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
        <h2 className="tag" style={{ margin: 0 }}>{t("radiology.results.title")}</h2>
        <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>
          {t("radiology.results.counts", { crit: openCrit.length, unread, read: readNotActed })}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("radiology.results.why")}</p>
      {done !== null && <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--green)" }}>{done}</p>}
      {q.isError && !(q.error instanceof ApiError && q.error.status === 403) && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{radiologyErrorText(q.error)}</p>
      )}
      {q.isSuccess && rows.length === 0 && <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>{t("radiology.results.empty")}</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{rows.map(row)}</ul>
    </section>
  );
}
