import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { labErrorText } from "../lib/lab-api";
import {
  quickCatalogue, quickCollect, quickCollectQueue, quickHandOver, quickQueue, quickReady, quickReadyReport, quickSendBack,
} from "../lib/lab-quick-api";
import { LabStation, sexAge } from "./lab-seat";
import { ResultsPanel } from "./lab-quick";
import { istStamp, printQuickReport } from "./lab-quick-reports";
import type { QuickCollectRow, QuickReport, QuickRow } from "../lib/lab-quick-api";

/**
 * OWNER 2026-10-11 — THE QUICK CHAIN after the counter (spec `SPEC-lab-quick-chain-2026-10-11.md`):
 *
 *   /lab/qcollect  — orders waiting for blood; staff confirm **Blood collected** themselves, which
 *                    stamps a sample number and sends the patient to the bench.
 *   /lab/qbench    — collected samples; the results form with **Save draft** and **Save & Complete**.
 *   /lab/qreports  — completed reports; **Print & Hand over**, or **Send back to Quick Bench** as a draft.
 *
 * No signature for now (owner's answer; decision 0061's quick mode). Drawn in /counter's paper-and-pine.
 */

const PP = { fontFamily: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', color: "var(--ink)" } as const;

function initialsOf(name: string): string {
  return name.split(/\s+/).filter((w) => w !== "").slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

function PersonCell({ p, sub }: { p: { display: string; uhid: string; administrativeGender: string; dob: string | null }; sub?: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 220px" }}>
      <div aria-hidden style={{
        width: 40, height: 40, borderRadius: 7, background: "var(--wash)", display: "flex", alignItems: "center",
        justifyContent: "center", fontWeight: 600, color: "var(--dim)", flexShrink: 0,
      }}>{initialsOf(p.display)}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>{p.display}</div>
        <div className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{sexAge(p.administrativeGender, p.dob)} · {p.uhid}</div>
        {sub}
      </div>
    </div>
  );
}

function Title({ title, note }: { title: string; note: string }): React.ReactElement {
  return (
    <div>
      <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>{note}</div>
    </div>
  );
}

/* ═══════════════════════════════ /lab/qcollect ═══════════════════════════════ */

export function LabQCollect(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ["lab-quick", "collect"], queryFn: quickCollectQueue, refetchInterval: 20_000 });
  const [done, setDone] = useState<QuickRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const collect = useMutation({
    mutationFn: (row: QuickCollectRow) => quickCollect(row.orderId),
    onSuccess: (r) => {
      setError(null);
      setDone((d) => [r, ...d].slice(0, 20));
      void qc.invalidateQueries({ queryKey: ["lab-quick"] });
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const rows = queue.data ?? [];

  const list = (
    <section className="space-y-2" aria-label={t("lab.qchain.collectedNow")}>
      <h2 className="text-sm font-semibold">{t("lab.qchain.collectedNow")}</h2>
      <ul className="divide-y divide-border rounded border border-border text-sm" data-testid="collected-now">
        {done.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="truncate font-medium">{r.patient.display}</span>
            <span className="shrink-0 font-mono text-xs">{r.sampleNo}</span>
          </li>
        ))}
        {done.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">{t("lab.qchain.noneCollected")}</li>}
      </ul>
    </section>
  );

  return (
    <LabStation station="qcollect" title={t("lab.qchain.collectTitle")} place={t("lab.desk.place")}
      stats={[{ label: t("lab.qchain.waitingBlood"), value: rows.length, tone: rows.length > 0 ? "live" : undefined }]} list={list}>
      <div className="pp" style={{ ...PP, display: "flex", flexDirection: "column", gap: 14 }}>
        <Title title={t("lab.qchain.collectTitle")} note={t("lab.qchain.collectNote")} />
        {error !== null && <div role="alert" className="box" style={{ padding: 12, color: "var(--red)", borderColor: "var(--red-line)" }}>{error}</div>}
        {done[0] !== undefined && (
          <div className="box" role="status" data-testid="collected-toast"
            style={{ padding: "12px 14px", borderColor: "var(--green)", color: "var(--green)", fontWeight: 600 }}>
            ✓ {t("lab.qchain.collectedToast", { name: done[0].patient.display, sample: done[0].sampleNo ?? "" })}
          </div>
        )}
        <ul style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="collect-queue">
          {rows.map((r) => (
            <li key={r.orderId} className="box" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 15px", flexWrap: "wrap" }}>
              <PersonCell p={r.patient} sub={
                <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
                  <span className="mo">{r.orderNo}</span> · <span className="mo">{r.encounterNo}</span> · {t("lab.qchain.waitingFor", { minutes: minutesSince(r.placedAt) })}
                </div>
              } />
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: "2 1 200px" }}>
                {r.priority !== "routine" && <span className="pill rd" style={{ height: 22 }}>{r.priority.toUpperCase()}</span>}
                {r.tests.map((x) => <span key={x.serviceId} className="pill on" style={{ height: 22 }}>{x.code}</span>)}
              </div>
              <button type="button" className="pri" style={{ height: 44, minWidth: 180 }}
                aria-label={`${t("lab.qchain.bloodCollected")} ${r.patient.display}`}
                disabled={collect.isPending} onClick={() => collect.mutate(r)}>
                ✓ {t("lab.qchain.bloodCollected")}
              </button>
            </li>
          ))}
          {queue.isSuccess && rows.length === 0 && (
            <li className="box" style={{ padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed" }}>{t("lab.qchain.nobodyWaiting")}</li>
          )}
        </ul>
      </div>
    </LabStation>
  );
}

/* ═══════════════════════════════ /lab/qbench ═══════════════════════════════ */

export function LabQBench(): React.ReactElement {
  const { t } = useTranslation();
  const queue = useQuery({ queryKey: ["lab-quick", "queue"], queryFn: quickQueue, refetchInterval: 20_000 });
  const catalogue = useQuery({ queryKey: ["lab-quick", "catalogue"], queryFn: quickCatalogue, staleTime: 10 * 60_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  const rows = queue.data?.waiting ?? [];

  const list = (
    <section className="space-y-2" aria-label={t("lab.qchain.benchQueue")}>
      <h2 className="text-sm font-semibold">{t("lab.qchain.benchQueue")} <span className="text-muted-foreground">({rows.length})</span></h2>
      <ul className="divide-y divide-border rounded border border-border text-sm">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted ${r.id === openId ? "bg-muted" : ""}`}
              onClick={() => { setOpenId(r.id); setCompleted(null); }}>
              <span className="truncate font-medium">{r.patient.display}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{r.status === "draft" ? t("lab.qchain.draft") : r.sampleNo ?? ""}</span>
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">{t("lab.qchain.benchEmpty")}</li>}
      </ul>
    </section>
  );

  return (
    <LabStation station="qbench" title={t("lab.qchain.benchTitle")} place={t("lab.desk.place")}
      stats={[{ label: t("lab.qchain.toReport"), value: rows.length, tone: rows.length > 0 ? "live" : undefined }]} list={list}>
      {openId !== null ? (
        <ResultsPanel key={openId} id={openId} catalogue={catalogue.data} mode="bench"
          onBack={() => setOpenId(null)}
          onCompleted={(r: QuickReport) => { setOpenId(null); setCompleted(r.patient.display); }} />
      ) : (
        <div className="pp" style={{ ...PP, display: "flex", flexDirection: "column", gap: 14 }}>
          <Title title={t("lab.qchain.benchTitle")} note={t("lab.qchain.benchNote")} />
          {completed !== null && (
            <div className="box" role="status" data-testid="completed-toast" style={{ padding: "12px 14px", borderColor: "var(--green)", color: "var(--green)", fontWeight: 600 }}>
              ✓ {t("lab.qchain.completedToast", { name: completed })}
            </div>
          )}
          <ul style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="bench-queue">
            {rows.map((r) => (
              <li key={r.id} className="box" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 15px", flexWrap: "wrap" }}>
                <PersonCell p={r.patient} sub={
                  <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
                    {r.sampleNo !== null && r.sampleNo !== undefined && <><span className="mo">{r.sampleNo}</span> · </>}
                    {t("lab.qchain.collectedAt", { at: istStamp(r.collectedAt) })}
                  </div>
                } />
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: "2 1 200px" }}>
                  {r.status === "draft" && <span className="pill gd" style={{ height: 22 }}>{t("lab.qchain.draft")}</span>}
                  {r.tests.map((x) => <span key={x.serviceId} className="pill on" style={{ height: 22 }}>{x.code}</span>)}
                </div>
                <button type="button" className="pri" style={{ height: 42, minWidth: 150 }}
                  aria-label={`${t("lab.qchain.enterResults")} ${r.patient.display}`}
                  onClick={() => { setOpenId(r.id); setCompleted(null); }}>
                  {r.status === "draft" ? t("lab.qchain.continue") : t("lab.qchain.enterResults")}
                </button>
              </li>
            ))}
            {queue.isSuccess && rows.length === 0 && (
              <li className="box" style={{ padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed" }}>{t("lab.qchain.benchEmpty")}</li>
            )}
          </ul>
        </div>
      )}
    </LabStation>
  );
}

/* ═══════════════════════════════ /lab/qreports ═══════════════════════════════ */

const FLAG_COLOUR: Record<string, string> = { L: "var(--gold)", H: "var(--gold)", LL: "var(--red)", HH: "var(--red)" };

function ReportPreview({ report }: { report: QuickReport }): React.ReactElement {
  const { t } = useTranslation();
  const byId = new Map(report.lines.map((l) => [l.analyteId, l]));
  return (
    <div className="box" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }} data-testid="report-preview">
      {report.groups.map((g, gi) => {
        const lines = g.analyteIds.map((id) => byId.get(id)).filter((l) => l !== undefined);
        if (lines.length === 0) return null;
        return (
          <div key={gi}>
            <div className="tag" style={{ marginBottom: 6 }}>{g.title ?? t("lab.qchain.otherParams")}</div>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <tbody>
                {lines.map((l) => (
                  <tr key={l!.analyteId} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "5px 4px" }}>{l!.nameEn}</td>
                    <td className="mo" style={{ padding: "5px 4px", fontWeight: 700, color: l!.flag ? FLAG_COLOUR[l!.flag] : undefined }}>
                      {l!.value}{l!.flag !== null && l!.flag !== "N" ? ` ${l!.flag}` : ""}
                    </td>
                    <td style={{ padding: "5px 4px", color: "var(--dim)" }}>{l!.unit ?? ""}</td>
                    <td style={{ padding: "5px 4px", color: "var(--dim)" }}>{l!.refText ?? (l!.low !== null || l!.high !== null ? `${l!.low ?? ""} – ${l!.high ?? ""}` : "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {report.summary !== "" && <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}><b>{t("lab.qchain.summary")}:</b> {report.summary}</div>}
      <div style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("lab.qchain.notSigned")}</div>
    </div>
  );
}

export function LabQReports(): React.ReactElement {
  const { t } = useTranslation();
  const { can, username } = useAuth();
  const qc = useQueryClient();
  const desk = useQuery({ queryKey: ["lab-quick", "ready"], queryFn: quickReady, refetchInterval: 30_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useQuery({ queryKey: ["lab-quick", "ready", openId], queryFn: () => quickReadyReport(openId!), enabled: openId !== null });
  const done = (message: string) => () => {
    setError(null); setOpenId(null); setNote(message);
    void qc.invalidateQueries({ queryKey: ["lab-quick"] });
  };
  const handOver = useMutation({
    mutationFn: async (r: QuickReport) => { printQuickReport(r, username); return quickHandOver(r.id); },
    onSuccess: (row) => done(t("lab.qchain.handedOverToast", { name: row.patient.display }))(),
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const sendBack = useMutation({
    mutationFn: (id: string) => quickSendBack(id),
    onSuccess: (row) => done(t("lab.qchain.sentBackToast", { name: row.patient.display }))(),
    onError: (e: unknown) => setError(labErrorText(e)),
  });
  const ready = desk.data?.ready ?? [];
  const handed = desk.data?.handedOverToday ?? [];

  const list = (
    <section className="space-y-2" aria-label={t("lab.qchain.handedToday")}>
      <h2 className="text-sm font-semibold">{t("lab.qchain.handedToday")} <span className="text-muted-foreground">({handed.length})</span></h2>
      <ul className="divide-y divide-border rounded border border-border text-sm">
        {handed.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="truncate font-medium">{r.patient.display}</span>
            <button type="button" className="shrink-0 rounded border border-input px-2 py-0.5 text-xs"
              onClick={async () => { printQuickReport(await quickReadyReport(r.id), username); }}>{t("lab.qchain.reprint")}</button>
          </li>
        ))}
        {handed.length === 0 && <li className="px-2 py-1.5 text-muted-foreground">{t("lab.qchain.noneHanded")}</li>}
      </ul>
    </section>
  );

  return (
    <LabStation station="qreports" title={t("lab.qchain.reportsTitle")} place={t("lab.desk.place")}
      stats={[{ label: t("lab.qchain.readyToHand"), value: ready.length, tone: ready.length > 0 ? "live" : undefined }]} list={list}>
      <div className="pp" style={{ ...PP, display: "flex", flexDirection: "column", gap: 14 }}>
        <Title title={t("lab.qchain.reportsTitle")} note={t("lab.qchain.reportsNote")} />
        {note !== null && openId === null && (
          <div className="box" role="status" data-testid="reports-toast" style={{ padding: "12px 14px", borderColor: "var(--green)", color: "var(--green)", fontWeight: 600 }}>✓ {note}</div>
        )}
        {error !== null && <div role="alert" className="box" style={{ padding: 12, color: "var(--red)", borderColor: "var(--red-line)" }}>{error}</div>}
        {openId !== null && report.data !== undefined ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="sec" onClick={() => setOpenId(null)}>← {t("lab.desk.flow.backToSummary")}</button>
              <PersonCell p={report.data.patient} sub={
                <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
                  {report.data.sampleNo != null && <><span className="mo">{report.data.sampleNo}</span> · </>}
                  {report.data.reportedAt !== null && t("lab.qchain.completedAt", { at: istStamp(report.data.reportedAt) })}
                </div>
              } />
            </div>
            <ReportPreview report={report.data} />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="pri" style={{ height: 46, minWidth: 200 }} disabled={handOver.isPending}
                onClick={() => handOver.mutate(report.data!)}>🖨 {t("lab.qchain.printHandOver")}</button>
              {can("lab.results.enter") && (
                <button type="button" className="sec" style={{ height: 46 }} disabled={sendBack.isPending}
                  onClick={() => sendBack.mutate(report.data!.id)}>↩ {t("lab.qchain.sendBack")}</button>
              )}
            </div>
          </>
        ) : (
          <ul style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="ready-list">
            {ready.map((r) => (
              <li key={r.id} className="box" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 15px", flexWrap: "wrap" }}>
                <PersonCell p={r.patient} sub={
                  <div style={{ fontSize: 11.5, color: "var(--faint)" }}>
                    {r.sampleNo != null && <><span className="mo">{r.sampleNo}</span> · </>}
                    {r.reportedAt !== null && t("lab.qchain.completedAt", { at: istStamp(r.reportedAt) })}
                  </div>
                } />
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: "2 1 200px" }}>
                  {r.tests.map((x) => <span key={x.serviceId} className="pill on" style={{ height: 22 }}>{x.code}</span>)}
                </div>
                <button type="button" className="pri" style={{ height: 42, minWidth: 140 }}
                  aria-label={`${t("lab.qchain.open")} ${r.patient.display}`}
                  onClick={() => { setOpenId(r.id); setNote(null); }}>{t("lab.qchain.open")}</button>
              </li>
            ))}
            {desk.isSuccess && ready.length === 0 && (
              <li className="box" style={{ padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed" }}>{t("lab.qchain.noneReady")}</li>
            )}
          </ul>
        )}
      </div>
    </LabStation>
  );
}
