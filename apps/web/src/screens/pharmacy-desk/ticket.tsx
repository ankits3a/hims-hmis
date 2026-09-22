import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Closed } from "./closed";
import { heldByAnother, lineVerdict, stageOf, ticketLabel, whoLabel } from "./model";
import { LineList } from "./lines";
import { hindiRefusal, hindiSig } from "./phrasebook";
import { istToday, sigOf } from "./work";
import type { CollectResult } from "./lines";
import type { PickLine, VerifyLine, WireDispense, WirePatientSummary, WireQueueRow } from "../../lib/pharmacy-api";

/**
 * THE MIDDLE COLUMN — the only one that changes with the stage (PD-D1). Idle: whose prescription is
 * in your hand. Found: a ticket that is not yet yours, or a name that matched several people. Working
 * and after: the ticket, line by line, as WHAT THE DOCTOR WROTE → WHAT YOU ARE GIVING (PD-D3).
 *
 * The lines are `lines.tsx` (PD-4): ticked, scanned, declined, and collected by the last settle.
 * Substituting is PD-5.
 */
export function TicketPanel({
  inHand, loading, loadError, me, candidates, error, note, busy, handOverError, takenLabel, onFind, onTake, onClear, onCollect, onDecline, onHandOver,
  onOpenSlip, onConfirmSlip, queue, onShowLine,
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
  handOverError: string | null;
  /** What was taken, as the bill rail printed it — the done line repeats the server's figure, never a sum of its own. */
  takenLabel: string | null;
  onHandOver: (identity: { via: "token" | "phone_last4"; value: string } | null) => void;
  onOpenSlip: () => void;
  onConfirmSlip: () => void;
  /** The line as the rail reads it — the agent's C1 sentence is said over it while nobody is in hand. */
  queue: readonly WireQueueRow[];
  onShowLine: () => void;
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
        <LineVerdict queue={queue} onShowLine={onShowLine} />
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
  const label = ticketLabel(inHand.dispenseNo, istToday());

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
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700 }} data-testid="desk-done">{t("pharmacyDesk.doneTitle", { who })}</h1>
        <p className="mo" style={{ margin: "3px 0 0 0", fontSize: 12, color: "var(--dim)" }}>
          {[label, takenLabel, t("pharmacyDesk.lines", { count: inHand.lines.length })].filter((x) => x !== null).join(" · ")}
        </p>
        <Closed dispenseId={inHand.id} />
        <button className="pri" style={{ marginTop: 16 }} onClick={onClear}>
          {t("pharmacyDesk.nextTicket")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Esc</span>
        </button>
      </div>
    );
  }

  const h1Lines = inHand.lines.filter((l) => l.scheduleFlag === "H1").map((l) => l.lineIdx + 1);
  /* PD-7 C11 / PD-D13 — a line the books could read only in part raised no warning, and silence there is not a result. */
  const partlyRead = inHand.lines.filter((l) => l.status === "open" && l.partlyChecked === true).length;
  /* E28 — typed from paper and not yet confirmed: the attestation is asked for FIRST, not at the till. */
  const typed = inHand.transcribedBy != null;
  const slipOwed = typed && inHand.slipConfirmedBy == null;
  return (
    <div data-testid="desk-ticket">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {label === null ? t("pharmacyDesk.ticketFor", { who }) : t("pharmacyDesk.ticket", { label })}
        </h1>
        <span className="pill on">{inHand.status === "claimed" ? t("pharmacyDesk.claimedByYou") : t(`pharmacyDesk.status.${inHand.status}`)}</span>
        {h1Lines.length > 0 ? <span className="pill rd">{t("pharmacyDesk.h1On", { lines: h1Lines.join(", ") })}</span> : null}
        <span style={{ flexGrow: 1 }} />
        {/* While the cross-check is owed the banner carries this control; one control, not two. */}
        {typed && !slipOwed ? <button className="sec" onClick={onOpenSlip}>{t("pharmacyDesk.slip.see")} <span className="kb">S</span></button> : null}
      </div>
      <p style={{ margin: "5px 0 0 0", fontSize: 12.5, color: "var(--dim)" }}>
        {t("pharmacyDesk.rxVersion", { version: inHand.prescriptionVersion })}
        {typed ? ` · ${t("pharmacyDesk.slip.typedBy", { name: inHand.transcribedByName ?? "—" })}` : ""}
      </p>
      {partlyRead > 0 ? (
        <p data-testid="desk-not-checked" style={{ margin: "5px 0 0 0", fontSize: 12.5, color: "var(--gold)" }}>{t("pharmacyDesk.notCheckedCount", { count: partlyRead })}</p>
      ) : null}
      {slipOwed ? (
        <div role="status" data-testid="desk-slip-owed" style={{ marginTop: 13, padding: "11px 14px", borderRadius: 7, background: "var(--gold-soft)", border: "1px solid var(--gold-line)" }}>
          <span style={{ fontSize: 12.5, lineHeight: "18px" }}>{t("pharmacyDesk.slip.owed", { name: inHand.transcribedByName ?? "—" })}</span>
          <span style={{ display: "flex", gap: 8, marginTop: 9 }}>
            <button className="sec" onClick={onOpenSlip}>{t("pharmacyDesk.slip.see")} <span className="kb">S</span></button>
            <button className="sec grn" disabled={busy} onClick={onConfirmSlip}>{t("pharmacyDesk.slip.confirm")}</button>
          </span>
        </div>
      ) : null}
      <LineList
        dispense={inHand}
        editable={(inHand.status === "claimed" || inHand.status === "verified") && !slipOwed}
        busy={busy}
        onCollect={onCollect}
        onDecline={onDecline}
      />
      {inHand.status === "billed" ? <HandOver dispense={inHand} busy={busy} error={handOverError} onHandOver={onHandOver} /> : null}
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
 * PD-6 — THE HAND-OVER, after the money. A paid ticket can stand uncollected (E25), so handing it
 * over is its own act. For a scheduled drug the pharmacist confirms who is collecting, and the box
 * STARTS EMPTY for every ticket (E18): a box already holding the last patient's token is the second
 * confirmation answered before anyone looked up — the C3 finding of the 16c close review.
 */
export function HandOver({
  dispense, busy, error, onHandOver,
}: {
  dispense: WireDispense;
  busy: boolean;
  error: string | null;
  onHandOver: (identity: { via: "token" | "phone_last4"; value: string } | null) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [via, setVia] = useState<"token" | "phone_last4">("token");
  const [value, setValue] = useState("");
  useEffect(() => { setVia("token"); setValue(""); }, [dispense.id]);
  const needsId = dispense.scheduled;
  const ready = !busy && (!needsId || value.trim() !== "");
  const go = (): void => { if (ready) onHandOver(needsId ? { via, value: value.trim() } : null); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  /* PD-7 C10 — what to say, line by line, for what is actually being handed over. */
  const given = dispense.lines.filter((l) => l.status === "open" && l.pickedBatch != null);
  const refused = dispense.lines.filter((l) => l.status === "declined");
  return (
    <div className="box" data-testid="desk-handover" style={{ marginTop: 16, padding: "14px 16px" }}>
      <div className="tag">{t("pharmacyDesk.handover.title")}</div>
      {given.length === 0 ? null : (
        <div className="agchip" data-testid="desk-say" style={{ display: "block", marginTop: 9 }}>
          <span style={{ display: "block", fontSize: 11, opacity: 0.8 }}>{t("pharmacyDesk.say.title")}</span>
          <ul style={{ margin: "5px 0 0 0", paddingLeft: 17 }}>
            {given.map((l) => {
              const brand = l.dispensedMedicine?.brandName ?? l.rxLine.drug;
              const said = hindiSig(l.rxLine);
              const words = `${sigOf(l.rxLine)}${l.rxLine.instructions === null || l.rxLine.instructions.trim() === "" ? "" : ` · ${l.rxLine.instructions.trim()}`}`;
              return (
                <li key={l.lineIdx} style={{ fontSize: 13, lineHeight: "20px" }}>
                  <b>{brand}</b>: {said ?? t("pharmacyDesk.say.own", { words })}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {refused.length === 0 ? null : (
        <div className="agchip" data-testid="desk-say-not-given" style={{ display: "block", marginTop: 7 }}>
          <span style={{ display: "block", fontSize: 11, opacity: 0.8 }}>{t("pharmacyDesk.say.notGiven")}</span>
          <ul style={{ margin: "5px 0 0 0", paddingLeft: 17 }}>
            {refused.map((l) => (
              <li key={l.lineIdx} style={{ fontSize: 13, lineHeight: "20px" }}>
                <b>{l.rxLine.drug}</b>: {hindiRefusal(l.declinedReason ?? "") ?? t("pharmacyDesk.say.why", { reason: l.declinedReason ?? "" })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {needsId ? (
        <div style={{ display: "flex", gap: 8, marginTop: 9, alignItems: "flex-end" }}>
          <label>
            <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.via")}</span>
            <select className="in" value={via} onChange={(e) => setVia(e.target.value as "token" | "phone_last4")} style={{ height: 38, marginTop: 4, width: 170 }}>
              <option value="token">{t("pharmacyDesk.handover.token")}</option>
              <option value="phone_last4">{t("pharmacyDesk.handover.phone")}</option>
            </select>
          </label>
          <label style={{ flexGrow: 1 }}>
            <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.value")}</span>
            <input className="in mo" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("pharmacyDesk.handover.placeholder")} style={{ height: 38, marginTop: 4 }} />
          </label>
        </div>
      ) : (
        <p style={{ margin: "7px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.handover.noId")}</p>
      )}
      <button className="pri" style={{ marginTop: 12 }} disabled={!ready} onClick={go}>
        {t("pharmacyDesk.handover.button")}{" "}
        <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Ctrl ⏎</span>
      </button>
      {error !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
    </div>
  );
}

/**
 * PD-7 / C1, SAID BY THE AGENT — ON PINE, because it is the agent's (PD-D16): what it DID (checked
 * every waiting ticket against this shelf) and what it found. It changes nothing and asks nothing.
 */
function LineVerdict({ queue, onShowLine }: { queue: readonly WireQueueRow[]; onShowLine: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const v = lineVerdict(queue);
  if (v === null) return null;
  return (
    <div className="agchip" data-testid="desk-line-verdict" style={{ marginTop: 20, display: "flex" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--mint)", flexShrink: 0 }} />
      <span style={{ flexGrow: 1 }}>
        {t("pharmacyDesk.agent.checked", { count: v.waiting })}{" "}
        <b>{t("pharmacyDesk.agent.complete", { count: v.complete })}</b>
        {v.incomplete > 0 ? `, ${t("pharmacyDesk.agent.incomplete", { count: v.incomplete })}` : ""}
        {v.refused > 0 ? `, ${t("pharmacyDesk.agent.refused", { count: v.refused })}` : ""}.
      </span>
      <button className="agdo" onClick={onShowLine}>{t("pharmacyDesk.agent.show")}</button>
    </div>
  );
}
