import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../lib/auth";
import { fmtIst } from "../lib/format";
import { radiologyErrorText } from "../lib/radiology-api";
import { attachUnmatched, dicomName, fetchPacsInbox, rejectUnmatched } from "../lib/radiology-pacs-api";
import type { WireInboxRow } from "../lib/radiology-pacs-api";
import { SeatLink } from "../components/radiology/imaging-counter";
import { RadiologyStation } from "./radiology-station";

/**
 * PLAN 18-S RS12 — **UNMATCHED IMAGES: the PACS inbox, a header view of the Rooms station.**
 *
 * The archive (Orthanc) holds a study that no accession + UHID could claim — a UHID typed with a
 * digit missing at a console with no worklist, a QA phantom, a scan the room forgot to Send. The
 * technologist who knows who was on the table (or the radiologist) attaches it to the study it
 * belongs to BY ACCESSION, with a reason, or rejects it. Nothing here offers a patient by name.
 *
 * Owner layout: right = ONE list (the open archive studies, newest first); left = the one in hand;
 * centre = the two identities side by side and the one next act (Attach) docked, Enter runs it.
 * With nothing in hand the centre shows where the archive stands and the dose reports that disagree
 * with a typed number (the RSO's to review; the typed number stands).
 */
const field = "w-full rounded border bg-background px-2 py-1 text-sm";

export function PacsInboxView({ views }: { views: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayReconcile = can("radiology.pacs.reconcile");
  const q = useQuery({ queryKey: ["radiology", "pacs-inbox"], queryFn: fetchPacsInbox, enabled: mayReconcile });
  const data = q.data;
  const [openId, setOpenId] = useState<string | null>(null);
  const inHand = data?.unmatched.find((r) => r.id === openId) ?? null;

  const list = (
    <section aria-label={t("radiology.pacs.listTitle")}>
      <h2 className="tag m-0 mb-2">{t("radiology.pacs.listTitle")} · {data?.unmatched.length ?? 0}</h2>
      {(data?.unmatched.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">{t("radiology.pacs.listEmpty")}</p>}
      <ul className="m-0 list-none space-y-1 p-0" data-testid="pacs-list">
        {(data?.unmatched ?? []).map((r) => (
          <li key={r.id}>
            <button
              type="button" onClick={() => setOpenId(r.id)} data-testid={`pacs-row-${r.id}`}
              aria-current={r.id === openId ? "true" : undefined}
              className={`w-full rounded border p-2 text-left text-sm ${r.id === openId ? "border-green-700 bg-green-50" : "bg-card"}`}
            >
              <b className="block truncate">{dicomName(r.dicomPatientName) || t("radiology.pacs.noName")}</b>
              <span className="block truncate text-xs text-muted-foreground">
                {[r.modality, r.accessionNumber ?? t("radiology.pacs.noAccession"), t("radiology.pacs.images", { count: r.instanceCount })].filter(Boolean).join(" · ")}
              </span>
              <span className="block text-xs text-amber-800">{t(`radiology.pacs.reason.${r.reason}`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const lane = inHand === null ? null : (
    <div className="mt-3 space-y-1 border-t pt-3 text-sm" data-testid="pacs-in-hand">
      <p className="tag m-0">{t("radiology.pacs.inHand")}</p>
      <p className="m-0 font-semibold">{dicomName(inHand.dicomPatientName) || t("radiology.pacs.noName")}</p>
      <p className="m-0 text-xs">{t("radiology.pacs.dicomId")}: <span className="mo">{inHand.dicomPatientId ?? "—"}</span></p>
      <p className="m-0 text-xs">{t("radiology.pacs.accession")}: <span className="mo">{inHand.accessionNumber ?? "—"}</span></p>
      <p className="m-0 text-xs">{t("radiology.pacs.arrived", { at: fmtIst(inHand.receivedAt) })}</p>
      <button type="button" className="text-xs underline" onClick={() => setOpenId(null)}>{t("radiology.pacs.putDown")}</button>
    </div>
  );

  return (
    <RadiologyStation
      station="room" views={views}
      title={t("radiology.pacs.title")}
      place={data === undefined ? "" : data.configured
        ? t("radiology.pacs.lastArrival", { at: data.lastArrivalAt === null ? "—" : fmtIst(data.lastArrivalAt) })
        : t("radiology.pacs.notConfigured")}
      stats={[
        { label: t("radiology.pacs.statOpen"), value: data?.unmatched.length ?? 0, tone: (data?.unmatched.length ?? 0) > 0 ? "waiting" : "plain" },
        { label: t("radiology.pacs.statConflicts"), value: data?.doseConflicts.length ?? 0, tone: (data?.doseConflicts.length ?? 0) > 0 ? "danger" : "plain" },
        { label: t("radiology.pacs.statDoseUnplaced"), value: data?.doseUnmatched ?? 0 },
      ]}
      lane={lane}
      list={list}
      inHand={inHand !== null}
      closeListOn={openId}
    >
      <div className="space-y-3" data-testid="pacs-inbox">
        {!mayReconcile && <p role="alert" className="text-sm text-amber-800">{t("radiology.pacs.noGrant")}</p>}
        {q.isError && <p role="alert" className="text-sm text-red-700">{radiologyErrorText(q.error)}</p>}
        {inHand === null
          ? <Overview data={data} />
          : <Reconcile key={inHand.id} row={inHand} onDone={() => { setOpenId(null); void qc.invalidateQueries({ queryKey: ["radiology", "pacs-inbox"] }); }} />}
      </div>
    </RadiologyStation>
  );
}

function Overview({ data }: { data: Awaited<ReturnType<typeof fetchPacsInbox>> | undefined }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <section className="rounded border bg-card p-3 text-sm" data-testid="pacs-status">
        <h3 className="m-0 mb-1 text-sm font-semibold">{t("radiology.pacs.archive")}</h3>
        <p className="m-0">{data?.configured === true ? t("radiology.pacs.configuredNote") : t("radiology.pacs.notConfiguredNote")}</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.pacs.howItMatches")}</p>
      </section>
      <section className="rounded border bg-card" data-testid="dose-conflicts">
        <h3 className="m-0 border-b px-3 py-2 text-sm font-semibold">{t("radiology.pacs.conflictsTitle")}</h3>
        {(data?.doseConflicts.length ?? 0) === 0
          ? <p className="px-3 py-2 text-sm text-muted-foreground">{t("radiology.pacs.noConflicts")}</p>
          : (
            <ul className="m-0 list-none divide-y p-0 text-sm">
              {data!.doseConflicts.map((c) => (
                <li key={c.id} className="px-3 py-2">
                  <span className="mo">{c.accessionNo ?? "—"}</span>{" · "}
                  {Object.entries(c.conflict).map(([k, v]) => t("radiology.pacs.conflictLine", { quantity: t(`radiology.pacs.quantity.${k}`, { defaultValue: k }), typed: v.typed, sr: v.sr })).join("; ")}
                </li>
              ))}
            </ul>
          )}
        <p className="m-0 px-3 pb-2 text-xs text-muted-foreground">{t("radiology.pacs.conflictsNote")}</p>
      </section>
    </>
  );
}

function Reconcile({ row, onDone }: { row: WireInboxRow; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const [accession, setAccession] = useState(row.candidate?.accessionNo ?? row.accessionNumber ?? "");
  const [reason, setReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [refusal, setRefusal] = useState<{ text: string; code: string | null } | null>(null);
  const fail = (e: unknown) => setRefusal({ text: radiologyErrorText(e), code: (e as { body?: { code?: string } }).body?.code ?? null });
  const attach = useMutation({ mutationFn: () => attachUnmatched(row.id, accession.trim(), reason.trim()), onSuccess: onDone, onError: fail });
  const reject = useMutation({ mutationFn: () => rejectUnmatched(row.id, rejectReason.trim()), onSuccess: onDone, onError: fail });
  const ready = accession.trim() !== "" && reason.trim() !== "" && !attach.isPending;
  const run = useRef<(() => void) | null>(null);
  run.current = ready ? () => attach.mutate() : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target !== null && ["TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) return;
      if (e.key === "Enter" && run.current !== null) { e.preventDefault(); run.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const c = row.candidate;
  const idsDiffer = c !== null && (row.dicomPatientId ?? "").trim().toUpperCase() !== c.uhid.toUpperCase();

  return (
    <div className="flex min-h-full flex-col gap-3" data-testid="pacs-reconcile">
      <p className="m-0 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{t(`radiology.pacs.explain.${row.reason}`)}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded border bg-card p-3 text-sm">
          <h3 className="m-0 mb-1 text-sm font-semibold">{t("radiology.pacs.fromArchive")}</h3>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t("radiology.pacs.name")}</dt><dd className="m-0">{dicomName(row.dicomPatientName) || "—"}</dd>
            <dt className="text-muted-foreground">{t("radiology.pacs.dicomId")}</dt><dd className={`m-0 mo ${idsDiffer ? "text-red-700" : ""}`}>{row.dicomPatientId ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("radiology.pacs.accession")}</dt><dd className="m-0 mo">{row.accessionNumber ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("radiology.pacs.studyDate")}</dt><dd className="m-0">{row.studyDate ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("radiology.pacs.content")}</dt><dd className="m-0">{[row.modality, t("radiology.pacs.series", { count: row.seriesCount }), t("radiology.pacs.images", { count: row.instanceCount })].filter(Boolean).join(" · ")}</dd>
            <dt className="text-muted-foreground">UID</dt><dd className="m-0 mo break-all text-xs">{row.studyInstanceUid}</dd>
          </dl>
        </section>
        <section className="rounded border bg-card p-3 text-sm" data-testid="pacs-candidate">
          <h3 className="m-0 mb-1 text-sm font-semibold">{t("radiology.pacs.candidate")}</h3>
          {c === null
            ? <p className="m-0 text-muted-foreground">{t("radiology.pacs.noCandidate")}</p>
            : (
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t("radiology.pacs.name")}</dt><dd className="m-0">{c.patientName}</dd>
                <dt className="text-muted-foreground">UHID</dt><dd className={`m-0 mo ${idsDiffer ? "text-red-700" : ""}`}>{c.uhid || "—"}</dd>
                <dt className="text-muted-foreground">{t("radiology.pacs.accession")}</dt><dd className="m-0 mo">{c.accessionNo}</dd>
                <dt className="text-muted-foreground">{t("radiology.pacs.study")}</dt><dd className="m-0">{c.studyTypeCode} · {t(`radiology.room.state.${c.status}`, { defaultValue: c.status.replace("_", " ") })}</dd>
              </dl>
            )}
        </section>
      </div>

      <section className="rounded border bg-card p-3 text-sm">
        <label className="block">
          {t("radiology.pacs.attachTo")}
          <input className={`${field} mo`} value={accession} onChange={(e) => setAccession(e.target.value.toUpperCase())} data-testid="attach-accession" />
        </label>
        <label className="mt-2 block">
          {t("radiology.pacs.reasonLabel")}
          <input className={field} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="attach-reason" placeholder={t("radiology.pacs.reasonHint")} />
        </label>
        <p className="m-0 mt-1 text-xs text-muted-foreground">{t("radiology.pacs.attachNote")}</p>
      </section>

      {refusal !== null && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900" data-testid="pacs-refusal">
          <p className="m-0">{refusal.text}</p>
          {refusal.code === "not_acquired" && <SeatLink to="/radiology/room">{t("radiology.pacs.toRoom")}</SeatLink>}
        </div>
      )}

      <details className="rounded border bg-card p-3 text-sm" data-testid="pacs-reject">
        <summary className="cursor-pointer">{t("radiology.pacs.rejectTitle")}</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${field} min-w-0 flex-1`} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t("radiology.pacs.rejectHint")} data-testid="reject-reason" />
          <button type="button" className="rounded border border-red-400 bg-red-50 px-3 py-1 text-red-900 disabled:opacity-50"
            disabled={rejectReason.trim() === "" || reject.isPending} onClick={() => reject.mutate()} data-testid="reject">{t("radiology.pacs.reject")}</button>
        </div>
      </details>

      <div className="sticky bottom-0 -mx-1 mt-auto flex flex-wrap items-center gap-3 rounded border bg-card p-3 shadow-sm" data-testid="pacs-dock">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">{ready ? t("radiology.pacs.dockReady", { accession: accession.trim() }) : t("radiology.pacs.dockHint")}</span>
        <button type="button" data-testid="dock-attach" disabled={!ready} onClick={() => attach.mutate()}
          className="rounded bg-green-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {t("radiology.pacs.attach")} <span className="kb">Enter</span>
        </button>
      </div>
    </div>
  );
}
