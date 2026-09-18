import { useState } from "react";
import { useTranslation } from "react-i18next";
import { heldByAnother, stageOf, ticketLabel, whoLabel } from "./model";
import type { WireDispense, WireDispenseLine, WirePatientSummary } from "../../lib/pharmacy-api";

/**
 * THE MIDDLE COLUMN — the only one that changes with the stage (PD-D1). Idle: whose prescription is
 * in your hand. Found: a ticket that is not yet yours, or a name that matched several people. Working
 * and after: the ticket, line by line, as WHAT THE DOCTOR WROTE → WHAT YOU ARE GIVING (PD-D3).
 *
 * PD-3 draws the lines as they stand. Ticking, picking and scanning them is PD-4; substituting is
 * PD-5. Nothing here pretends to do either.
 */
export function TicketPanel({
  inHand, loading, loadError, me, candidates, error, note, onFind, onTake, onClear,
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
  const settled = inHand.lines.filter((l) => l.status !== "open").length;
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

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 15 }}>
        <div style={{ flexGrow: 1, height: 6, borderRadius: 3, background: "var(--line2)", overflow: "hidden" }}>
          <span style={{ display: "block", width: `${String(inHand.lines.length === 0 ? 0 : (settled * 100) / inHand.lines.length)}%`, height: "100%", background: "var(--green)" }} />
        </div>
        <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }} data-testid="desk-settled">
          {t("pharmacyDesk.settled", { n: settled, of: inHand.lines.length })}
        </span>
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 11, padding: "9px 15px", marginTop: 13, background: "var(--wash)",
        border: "1px solid var(--line)", borderRadius: "7px 7px 0 0",
      }}>
        <span className="tag" style={{ width: 220, flexShrink: 0 }}>{t("pharmacyDesk.wrote")}</span>
        <span style={{ width: 14, flexShrink: 0 }} />
        <span className="tag" style={{ flexGrow: 1 }}>{t("pharmacyDesk.giving")}</span>
        <span className="tag" style={{ width: 90, textAlign: "right", flexShrink: 0 }}>{t("pharmacyDesk.qty")}</span>
      </div>
      <div style={{ border: "1px solid var(--line)", borderTop: "none", borderRadius: "0 0 7px 7px", background: "var(--card)" }}>
        {inHand.lines.map((l) => <LineRow key={l.lineIdx} line={l} />)}
      </div>
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

/**
 * PD-D3 — the gap between the two columns is the pharmacist's whole job, so both are always drawn:
 * the doctor's words on the left, exactly as written, and on the right what the counter resolved
 * them to — or an amber row that says the catalogue could not place the line (PD-D4), in place.
 */
function LineRow({ line }: { line: WireDispenseLine }): React.ReactElement {
  const { t } = useTranslation();
  const rx = line.rxLine;
  const sig = [rx.dose, rx.frequency, rx.durationDays === null ? null : `× ${String(rx.durationDays)}d`].filter((x) => x !== null && x !== "").join(" · ");
  const given = line.dispensedMedicine;
  const unresolved = given === null;
  return (
    <section
      data-testid={`desk-line-${String(line.lineIdx)}`}
      style={{
        display: "flex", alignItems: "flex-start", gap: 11, padding: "12px 15px", borderTop: line.lineIdx === 0 ? "none" : "1px solid var(--line2)",
        boxShadow: unresolved || line.status === "declined" ? "inset 3px 0 0 var(--gold)" : line.status === "open" ? "none" : "inset 3px 0 0 var(--green)",
      }}
    >
      <span style={{ width: 220, flexShrink: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{rx.drug}</span>
        <span className="mo" style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 2 }}>{sig}</span>
        {rx.instructions === null || rx.instructions === "" ? null : (
          <span style={{ display: "block", fontSize: 11, color: "var(--dim)", marginTop: 1 }}>{rx.instructions}</span>
        )}
      </span>
      <span style={{ width: 14, flexShrink: 0, paddingTop: 3, color: "var(--dim)" }} aria-hidden="true">→</span>
      <span style={{ flexGrow: 1, minWidth: 0 }}>
        {unresolved ? (
          <span className="pill gd">{t("pharmacyDesk.unresolved")}</span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{given.brandName}</span>
            {line.substitutionType === "generic" ? <span className="pill on">{t("pharmacyDesk.generic")}</span> : null}
            {line.scheduleFlag === "H1" ? <span className="pill rd">H1</span> : null}
            {line.scheduleFlag === "X" ? <span className="pill rd">{t("pharmacyDesk.scheduleX")}</span> : null}
            {line.partlyChecked === true ? <span className="pill gd">{t("pharmacyDesk.notChecked")}</span> : null}
          </span>
        )}
        {line.status === "declined" ? (
          <span style={{ display: "block", marginTop: 5, fontSize: 11.5, color: "var(--gold)" }}>{t("pharmacyDesk.declined", { reason: line.declinedReason ?? "" })}</span>
        ) : null}
        {!unresolved && line.item === null ? (
          <span style={{ display: "block", marginTop: 5, fontSize: 11.5, color: "var(--gold)" }}>{t("pharmacyDesk.notStocked")}</span>
        ) : null}
        {!unresolved && line.item !== null && line.available !== null ? (
          <span className="mo" style={{ display: "block", marginTop: 3, fontSize: 11, color: line.available === 0 ? "var(--red)" : "var(--dim)" }}>
            {t("pharmacyDesk.onShelf", { n: line.available })}
          </span>
        ) : null}
      </span>
      <span className="mo" style={{ width: 90, flexShrink: 0, textAlign: "right", fontSize: 13.5, fontWeight: 600 }}>
        {line.qtyBase === null ? "—" : String(line.qtyBase)}
      </span>
    </section>
  );
}
