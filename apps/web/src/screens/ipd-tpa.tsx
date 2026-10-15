import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { fmtPaise } from "../lib/format";
import { getTpaBoard } from "../lib/ipd-tpa-api";
import { clockWords, tpaWhen } from "./ipd-tpa-panel";
import type React from "react";
import type { IpdTpaBoard, IpdTpaBoardRow, IpdTpaRowKind } from "@hmis/contracts";
import "../styles/paper-pine.css";
import "./ipd-bill.css";
import "./ipd-bill-desk.css";
import "./ipd-tpa.css";

/*
 * #604 (decision 0075) — THE TPA DESK BOARD (SPEC-tpa-desk-2026-10-15, surfaces): every stay and claim that needs the
 * desk, worst first — pre-auths waiting on the payer (with the clock), payer queries waiting on us, enhancements due,
 * claims to file, claims with the payer (ageing). Counts on top filter the list; each row opens the stay's bill page,
 * where the TPA panel acts. `ipd.payer.manage` — never a doctor (decision 0058). 16:9 first (the list scrolls inside its
 * card); at 390 px each row is a card. Severity is a word as well as a colour.
 */
const KINDS: readonly IpdTpaRowKind[] = ["query_open", "preauth_waiting", "enhancement_due", "claim_to_submit", "claim_with_payer"];

function Money({ r }: { r: IpdTpaBoardRow }): React.ReactElement {
  const { t } = useTranslation();
  if (r.kind === "enhancement_due") {
    return <span>{t("ipdTpa.claimableOf", { claimable: fmtPaise(r.claimablePaise ?? 0), approved: fmtPaise(r.approvedTotalPaise ?? 0) })}</span>;
  }
  if (r.claimedPaise !== null) return <span>{fmtPaise(r.claimedPaise)}</span>;
  if (r.approvedTotalPaise !== null) return <span>{t("ipdTpa.approved", { amount: fmtPaise(r.approvedTotalPaise) })}</span>;
  return <span className="dim">—</span>;
}

function Row({ r }: { r: IpdTpaBoardRow }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <tr className={`tpa-r ${r.severity}`} data-testid={`tpa-row-${r.id}`}>
      <td data-label={t("ipdTpa.col.patient")}>
        <div className="strong">{r.patientName}</div>
        <div className="mono dim small">{r.admissionNo ?? "—"}</div>
      </td>
      <td data-label={t("ipdTpa.col.payer")}>
        <div>{r.payerKind === null ? "—" : t(`ipdBill.payerKind.${r.payerKind}`, r.payerKind)}</div>
        <div className="mono dim small">{r.preAuthNumber ?? ""}</div>
      </td>
      <td data-label={t("ipdTpa.col.what")}>
        <span className="tpa-chip">{t(`ipdTpa.kind.${r.kind}`)}</span>
        {r.stage === null || r.kind.startsWith("claim") ? null : <span className="dim small"> {t(`ipdTpa.stage.${r.stage}`)}</span>}
      </td>
      <td data-label={t("ipdTpa.col.clock")}>
        <div>{clockWords(t, r.waitMinutes)}</div>
        <div className="dim small">{t("ipdTpa.since", { at: tpaWhen(r.since) })}</div>
      </td>
      <td data-label={t("ipdTpa.col.state")}><span className={`tpa-sev ${r.severity}`}>{t(`ipdTpa.sev.${r.severity}`)}</span></td>
      <td data-label={t("ipdTpa.col.amount")} className="num"><Money r={r} /></td>
      <td className="tpa-act">
        <Link to="/ipd/admissions/$admissionId/bill" params={{ admissionId: r.admissionId }} className="ipdb-btn">{t("ipdTpa.open")}</Link>
      </td>
    </tr>
  );
}

export function IpdTpaScreen(): React.ReactElement {
  const { t } = useTranslation();
  const [board, setBoard] = useState<IpdTpaBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IpdTpaRowKind | null>(null);
  const load = useCallback((): Promise<void> => getTpaBoard().then(
    (b) => { setBoard(b); setError(null); },
    (e: unknown) => setError(e instanceof ApiError && e.status === 403 ? t("ipdTpa.forbidden") : t("ipdTpa.loadFailed")),
  ), [t]);
  useEffect(() => { void load(); }, [load]);

  if (error !== null) return <main className="ipdb tpa-board"><p role="alert" className="ipdb-error">{error}</p></main>;
  if (board === null) return <main className="ipdb tpa-board"><p className="dim">{t("ipdTpa.loading")}</p></main>;
  const rows = filter === null ? board.rows : board.rows.filter((r) => r.kind === filter);
  return (
    <main className="ipdb tpa-board" aria-labelledby="tpa-title">
      <header className="ipdb-head">
        <div className="ipdb-title">
          <h1 id="tpa-title">{t("ipdTpa.title")}</h1>
          <span>{t("ipdTpa.subtitle")}</span>
          <span className="dim small">{t("ipdTpa.asOf", { at: tpaWhen(board.asOf) })}</span>
        </div>
        <div className="ipdb-actions">
          <Link to="/ipd/bill-desk" className="ipdb-btn">{t("ipdTpa.billDesk")}</Link>
          <button type="button" className="ipdb-btn" onClick={() => { void load(); }}>{t("ipdTpa.refresh")}</button>
        </div>
      </header>
      <nav className="ipdbd-counts tpa-counts" aria-label={t("ipdTpa.countsLabel")}>
        <button type="button" className={`ipdbd-count ${filter === null ? "on" : ""}`} aria-pressed={filter === null} onClick={() => setFilter(null)}>
          <span className="n">{board.rows.length}</span><span>{t("ipdTpa.all")}</span>
        </button>
        {KINDS.map((k) => {
          const hot = board.rows.some((r) => r.kind === k && r.severity === "hot");
          return (
            <button key={k} type="button" className={`ipdbd-count ${filter === k ? "on" : ""} ${hot ? "hot" : ""}`} aria-pressed={filter === k}
              disabled={board.counts[k] === 0} onClick={() => setFilter(filter === k ? null : k)}>
              <span className="n">{board.counts[k]}</span><span>{t(`ipdTpa.kind.${k}`)}</span>
            </button>
          );
        })}
      </nav>
      <section className="ipdb-card tpa-list-card" aria-label={t("ipdTpa.listLabel")}>
        {rows.length === 0 ? <p className="dim">{t("ipdTpa.empty")}</p> : (
          <table className="tpa-board-table">
            <thead>
              <tr>
                <th scope="col">{t("ipdTpa.col.patient")}</th><th scope="col">{t("ipdTpa.col.payer")}</th><th scope="col">{t("ipdTpa.col.what")}</th>
                <th scope="col">{t("ipdTpa.col.clock")}</th><th scope="col">{t("ipdTpa.col.state")}</th>
                <th scope="col" className="num">{t("ipdTpa.col.amount")}</th><th scope="col"><span className="sr">{t("ipdTpa.open")}</span></th>
              </tr>
            </thead>
            <tbody>{rows.map((r) => <Row key={r.id} r={r} />)}</tbody>
          </table>
        )}
      </section>
      <p className="dim small">{t("ipdTpa.portalNote")}</p>
    </main>
  );
}

/** The routed screen: `/ipd/tpa`. */
export function IpdTpa(): React.ReactElement {
  return <IpdTpaScreen />;
}
