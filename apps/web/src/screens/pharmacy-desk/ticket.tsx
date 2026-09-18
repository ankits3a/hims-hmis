import { useState } from "react";
import { useTranslation } from "react-i18next";
import { heldByAnother, stageOf, ticketLabel, whoLabel } from "./model";
import { LineList } from "./lines";
import type { CollectResult } from "./lines";
import type { PickLine, VerifyLine, WireDispense, WirePatientSummary } from "../../lib/pharmacy-api";

/**
 * THE MIDDLE COLUMN — the only one that changes with the stage (PD-D1). Idle: whose prescription is
 * in your hand. Found: a ticket that is not yet yours, or a name that matched several people. Working
 * and after: the ticket, line by line, as WHAT THE DOCTOR WROTE → WHAT YOU ARE GIVING (PD-D3).
 *
 * The lines are `lines.tsx` (PD-4): ticked, scanned, declined, and collected by the last settle.
 * Substituting is PD-5.
 */
export function TicketPanel({
  inHand, loading, loadError, me, candidates, error, note, busy, onFind, onTake, onClear, onCollect, onDecline,
}: {
  inHand: WireDispense | null;
  loading: boolean;
  loadError: string | null;
  me: string | null;
  candidates: WirePatientSummary[] | null;
  error: string | null;
  note: string | null;
  onFind: (q: string) => void;
  onTake: (dispenseId: string, who: string) => void;
  onClear: () => void;
  busy: boolean;
  onCollect: (verify: VerifyLine[] | null, pick: PickLine[]) => Promise<CollectResult>;
  onDecline: (lineIdx: number, reason: string) => Promise<boolean>;
}): React.ReactElement {
  const { t } = useTranslation();
  const alerts = (
    <>
      {error !== null ? <p role="alert" style={{ margin: "14px 0 0 0", fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
      {note !== null ? <p role="status" style={{ margin: "14px 0 0 0", fontSize: 12.5, color: "var(--dim)" }}>{note}</p> : null}
    </>
  );

  if (loading) return <p style={{ color: "var(--dim)" }}>{t("pharmacyDesk.loading")}</p>;
  if (loadError !== null) {
    return (
      <div style={{ maxWidth: 660 }}>
        <p role="alert" style={{ margin: 0, color: "var(--red)" }}>{loadError}</p>
        <button className="sec" style={{ marginTop: 12 }} onClick={onClear}>{t("pharmacyDesk.clear")} <span className="kb">Esc</span></button>
      </div>
    );
  }

  if (inHand === null) {
    return (
      <div style={{ maxWidth: 660 }}>
        <FindField onFind={onFind} />
        {alerts}
        {candidates !== null ? (
          <div className="box" style={{ marginTop: 18 }} data-testid="desk-candidates">
            <div style={{ padding: "12px 14px" }} className="tag">{t("pharmacyDesk.whichPatient")}</div>
            {candidates.map((p) => (
              <button key={p.id} className="drow" style={{ width: "100%" }} onClick={() => onFind(p.uhid)}>
                <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 500 }}>{whoLabel(p)}</span>
                <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{p.uhid}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const stage = stageOf(inHand, me);
  const who = whoLabel(inHand.patient);
  const label = ticketLabel(inHand.dispenseNo);

  if (stage === "found") {
    const cancelled = inHand.status === "cancelled";
    /* PD-1 — somebody else's ticket says whose it is and offers nothing to press. */
    const theirs = heldByAnother(inHand, me) ? (inHand.claimedByName ?? t("pharmacyDesk.anotherPharmacist")) : null;
    return (
      <div style={{ maxWidth: 660 }} data-testid="desk-found">
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {theirs !== null ? t("pharmacyDesk.theirsTitle", { name: theirs, who })
            : cancelled ? t("pharmacyDesk.cancelledTitle", { who }) : t("pharmacyDesk.notYoursTitle", { who })}
        </h1>
        <p style={{ margin: "6px 0 0 0", fontSize: 12.5, color: "var(--dim)" }}>
          {theirs !== null ? t("pharmacyDesk.theirsHint", { name: theirs })
            : cancelled ? inHand.cancelReason ?? "" : t("pharmacyDesk.notYoursHint", { count: inHand.lines.length })}
        </p>
        {cancelled || theirs !== null ? null : (
          <button className="pri" style={{ marginTop: 16 }} onClick={() => onTake(inHand.id, who)}>{t("pharmacyDesk.takeIt")}</button>
        )}
        {alerts}
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div style={{ maxWidth: 720 }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>{t("pharmacyDesk.doneTitle", { who })}</h1>
        <p className="mo" style={{ margin: "3px 0 0 0", fontSize: 12, color: "var(--dim)" }}>
          {label ?? ""}{label === null ? "" : " · "}{t("pharmacyDesk.lines", { count: inHand.lines.length })}
        </p>
        <button className="pri" style={{ marginTop: 16 }} onClick={onClear}>
          {t("pharmacyDesk.nextTicket")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Esc</span>
        </button>
      </div>
    );
  }

  const h1Lines = inHand.lines.filter((l) => l.scheduleFlag === "H1").map((l) => l.lineIdx + 1);
  return (
    <div data-testid="desk-ticket">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {label === null ? t("pharmacyDesk.ticketFor", { who }) : t("pharmacyDesk.ticket", { label })}
        </h1>
        <span className="pill on">{inHand.status === "claimed" ? t("pharmacyDesk.claimedByYou") : t(`pharmacyDesk.status.${inHand.status}`)}</span>
        {h1Lines.length > 0 ? <span className="pill rd">{t("pharmacyDesk.h1On", { lines: h1Lines.join(", ") })}</span> : null}
      </div>
      <p style={{ margin: "5px 0 0 0", fontSize: 12.5, color: "var(--dim)" }}>
        {t("pharmacyDesk.rxVersion", { version: inHand.prescriptionVersion })}
      </p>
      <LineList
        dispense={inHand}
        editable={inHand.status === "claimed" || inHand.status === "verified"}
        busy={busy}
        onCollect={onCollect}
        onDecline={onDecline}
      />
      {error !== null || note !== null ? alerts : null}
    </div>
  );
}

function FindField({ onFind }: { onFind: (q: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") { onFind(q.trim()); setQ(""); } }}>
      <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{t("pharmacyDesk.idleTitle")}</h1>
      <p style={{ margin: "6px 0 16px 0", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.idleHint")}</p>
      <label htmlFor="desk-find" className="tag">{t("pharmacyDesk.findLabel")}</label>
      <div style={{ display: "flex", gap: 9, marginTop: 7 }}>
        <input
          id="desk-find"
          className="in"
          autoFocus
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("pharmacyDesk.findPlaceholder")}
          style={{ height: 52, fontSize: 16 }}
        />
        <button type="submit" className="pri" style={{ height: 52, flexShrink: 0 }}>
          {t("pharmacyDesk.find.button")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>⏎</span>
        </button>
      </div>
    </form>
  );
}
