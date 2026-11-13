import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { dateLocale } from "../../lib/date-locale";
import { useDebounced } from "../../lib/format";
import { GUARDIAN_NAME_MAX, GUARDIAN_RELATIONS, SELF_RELATION } from "../../lib/opd-api";
import { suggestAtCounter } from "../../lib/pharmacy-api";
import { Closed } from "./closed";
import { ControlledStep } from "./controlled";
import { heldByAnother, initialsOf, lineVerdict, stageOf, ticketLabel, whoLabel } from "./model";
import { AddMedicineSheet } from "./add-medicine";
import { TakeOver } from "./takeover";
import { LineList } from "./lines";
import { DonePaper } from "./paper";
import { TicketMenu } from "./returns";
import type { ShortDrug } from "./short-book";
import { hindiRefusal, hindiSig } from "./phrasebook";
import { istToday, sigOf } from "./work";
import type { CollectResult } from "./lines";
import type { ControlledHandover, HandoverIdentity, PickLine, VerifyLine, WireDispense, WirePatientSummary, WireQueueRow } from "../../lib/pharmacy-api";

/**
 * THE MIDDLE COLUMN — the only one that changes with the stage (PD-D1). Idle: whose prescription is
 * in your hand. Found: a ticket that is not yet yours, or a name that matched several people. Working
 * and after: the ticket, line by line, as WHAT THE DOCTOR WROTE → WHAT YOU ARE GIVING (PD-D3).
 *
 * The lines are `lines.tsx` (PD-4): ticked, scanned, declined, and collected by the last settle.
 * Substituting is PD-5.
 */
/** DESK FIXES 2026-09-30 — the prescription's lines: a split's further batches are the same line, not another. */
function rxLinesOf(d: WireDispense): WireDispense["lines"] {
  return d.lines.filter((l) => l.splitFromLineIdx == null);
}

export function TicketPanel({
  inHand, loading, loadError, me, candidates, error, note, busy, handOverError, takenLabel, onFind, onTake, onClear, onCollect, onDecline, onHandOver,
  onOpenSlip, onConfirmSlip, queue, onShowLine, autoPrint = false, labelsOnly = false, onFocusDrug, onLiveQty, paperDoor = null, registerDoor = null,
  quick = false, onOpenBalance = null, onDraft = null, onAdded = null, onPaper = null, meName = null,
}: {
  /** Spec #1055 — "Save draft" sits at the ticket's foot while the lines are collected (the bill column is not open yet). */
  onDraft?: (() => void) | null;
  /** Spec #1055 — a medicine added by hand: the ticket as the server answered it. */
  onAdded?: ((d: WireDispense) => void) | null;
  /** Owner 2026-11-13 — the find stage's "no slip? · paper prescription" pill (Desk One's row), and key P. */
  onPaper?: (() => void) | null;
  /** Who is at this desk, for the add sheet's "added at the counter by <name>". */
  meName?: string | null;
  /** Owner ruling 2026-10-02 — quick desk mode: no slip to see, none to confirm (`settings.ts` on the server). */
  quick?: boolean;
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
  onHandOver: (identity: HandoverIdentity | null, controlled?: ControlledHandover) => void;
  onOpenSlip: () => void;
  onConfirmSlip: () => void;
  /** The line as the rail reads it — the agent's C1 sentence is said over it while nobody is in hand. */
  queue: readonly WireQueueRow[];
  onShowLine: () => void;
  /** PARITY P1 — the hand-over that just happened at this desk: its paper goes out by itself. */
  autoPrint?: boolean;
  /** Spec #1046 D3 — this desk already sent the bill at payment: the hand-over sends the labels alone. */
  labelsOnly?: boolean;
  /** Spec #1046 D6 — open the balance ticket of a handed-over ticket that still owes ("rest tomorrow"). */
  onOpenBalance?: ((dispenseId: string) => void) | null;
  /** PARITY P1 — the line the pharmacist is on, for the desk's `N`. */
  onFocusDrug?: (drug: ShortDrug | null) => void;
  /** The quantities being given as typed, for the bill rail (`LineList`). */
  onLiveQty?: (dispenseId: string, qty: Readonly<Record<number, number | null>>) => void;
  /** 2026-09-30 — a patient found with no e-prescription today: dispense from their paper prescription. */
  paperDoor?: {
    who: string; onOpen: () => void; /** 2026-10-02 — today's finished ticket, when there is one. */ onSeeLast?: () => void;
    /** Spec #1046 D6 — a ticket of this patient still owes a balance: open it. */ onBalance?: () => void;
  } | null;
  /** 2026-09-30 (owner) — nobody found: register the person here and dispense from their paper prescription. */
  registerDoor?: { onOpen: () => void } | null;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
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
      <div style={{ maxWidth: 860 }}>
        <FindField onFind={onFind} onPaper={onPaper} />
        {alerts}
        {paperDoor === null ? null : (
          <div className="box paper-rx-door" data-testid="desk-paper-door">
            <span style={{ flexGrow: 1, minWidth: 200, fontSize: 12.5 }}>{t(paperDoor.onSeeLast === undefined ? "pharmacyDesk.paperRx.doorHint" : "pharmacyDesk.paperRx.doorHintAgain", { who: paperDoor.who })}</span>
            {paperDoor.onSeeLast === undefined ? null : <button type="button" className="sec" data-testid="desk-see-last" onClick={paperDoor.onSeeLast}>{t("pharmacyDesk.paperRx.seeLast")}</button>}
            {paperDoor.onBalance === undefined ? null : <button type="button" className="sec" data-testid="desk-balance-door" onClick={paperDoor.onBalance}>{t("pharmacyDesk.balance.open")}</button>}
            <button type="button" className="pri" onClick={paperDoor.onOpen}>{t("pharmacyDesk.paperRx.door")}</button>
          </div>
        )}
        {registerDoor === null ? null : (
          <div className="box paper-rx-door" data-testid="desk-register-door">
            <span style={{ flexGrow: 1, minWidth: 200, fontSize: 12.5 }}>{t("pharmacyDesk.register.doorHint")}</span>
            <button type="button" className="pri" onClick={registerDoor.onOpen}>{t("pharmacyDesk.register.door")}</button>
          </div>
        )}
        <LineVerdict queue={queue} onShowLine={onShowLine} />
        {candidates !== null ? (
          <div style={{ marginTop: 18 }} data-testid="desk-candidates">
            <div className="tag" style={{ marginBottom: 8 }}>{t("pharmacyDesk.whichPatient")}</div>
            <div className="pd-hits">
              {candidates.map((p, i) => (
                <HitCard key={p.id} first={i === 0} initials={initialsOf(p)} name={whoLabel(p)} hint={null} uhid={p.uhid} onTake={() => onFind(p.uhid)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const stage = stageOf(inHand, me);
  const who = whoLabel(inHand.patient);
  const label = ticketLabel(inHand.dispenseNo, istToday(), i18n.language);

  if (stage === "found") {
    const cancelled = inHand.status === "cancelled";
    /* PD-1 — somebody else's ticket says whose it is; owner 2026-10-03 — and offers to take it over, with a reason. */
    const theirs = heldByAnother(inHand, me) ? (inHand.claimedByName ?? t("pharmacyDesk.anotherPharmacist")) : null;
    return (
      <div style={{ maxWidth: 660 }} data-testid="desk-found">
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {theirs !== null ? t("pharmacyDesk.theirsTitle", { name: theirs, who })
            : cancelled ? t("pharmacyDesk.cancelledTitle", { who }) : t("pharmacyDesk.notYoursTitle", { who })}
        </h1>
        <p style={{ margin: "6px 0 0 0", fontSize: 12.5, color: "var(--dim)" }}>
          {theirs !== null ? t("pharmacyDesk.theirsHint", { name: theirs })
            : cancelled ? inHand.cancelReason ?? "" : t("pharmacyDesk.notYoursHint", { count: rxLinesOf(inHand).length })}
        </p>
        {theirs !== null && !cancelled ? <TakeOver dispenseId={inHand.id} holder={theirs} /> : null}
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
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, flexGrow: 1 }} data-testid="desk-done">{t("pharmacyDesk.doneTitle", { who })}</h1>
          <TicketMenu dispense={inHand} />
        </div>
        <p className="mo" style={{ margin: "3px 0 0 0", fontSize: 12, color: "var(--dim)" }}>
          {[label, takenLabel, t("pharmacyDesk.lines", { count: rxLinesOf(inHand).length }), collectedLine(inHand, t)].filter((x) => x !== null).join(" · ")}
        </p>
        <DonePaper dispenseId={inHand.id} autoPrint={autoPrint} documents={labelsOnly ? ["pharmacy_labels"] : undefined} />
        <BalanceOwed dispense={inHand} onOpen={onOpenBalance} />
        <Closed dispenseId={inHand.id} />
        <button className="pri" style={{ marginTop: 16 }} onClick={onClear}>
          {t("pharmacyDesk.nextTicket")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Esc</span>
        </button>
      </div>
    );
  }

  const h1Lines = rxLinesOf(inHand).filter((l) => l.scheduleFlag === "H1").map((l) => l.lineIdx + 1);
  /* PD-7 C11 / PD-D13 — a line the books could read only in part raised no warning, and silence there is not a result. */
  const partlyRead = inHand.lines.filter((l) => l.status === "open" && l.partlyChecked === true).length;
  /* E28 — typed from paper and not yet confirmed: the attestation is asked for FIRST, not at the till. */
  const typed = inHand.transcribedBy != null;
  const slipOwed = !quick && typed && inHand.slipConfirmedBy == null;
  return (
    <div data-testid="desk-ticket" className="pd-ticket">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {label === null ? t("pharmacyDesk.ticketFor", { who }) : t("pharmacyDesk.ticket", { label })}
        </h1>
        <span className="pill on" data-testid="desk-ticket-state">
          {inHand.status === "claimed" ? t("pharmacyDesk.claimedByYou") : inHand.status === "picked" ? t("pharmacyDesk.allSettled") : t(`pharmacyDesk.status.${inHand.status}`)}
        </span>
        {h1Lines.length > 0 ? <span className="pill rd">{t("pharmacyDesk.h1On", { lines: h1Lines.join(", ") })}</span> : null}
        <span style={{ flexGrow: 1 }} />
        {/* While the cross-check is owed the banner carries this control; one control, not two. */}
        {typed && !slipOwed && !quick ? <button className="sec" onClick={onOpenSlip}>{t("pharmacyDesk.slip.see")} <span className="kb">S</span></button> : null}
        {/* Return / cancel — the ticket's exceptions behind ⋯ (`returns.tsx`). */}
        <TicketMenu dispense={inHand} />
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
        onFocusDrug={onFocusDrug}
        onLiveQty={onLiveQty}
        onDraft={onDraft}
        addRow={onAdded === null || !ADDABLE.has(inHand.status) ? null : (
          <AddMedicine dispense={inHand} label={label ?? who} quick={quick} me={meName ?? t("pharmacyDesk.thisDesk")} busy={busy} onAdded={onAdded} />
        )}
      />
      {/* Spec #1046 D3 — the bill prints when the money is taken (spec #1055: its paper is said in the bill column); the labels wait for the hand-over. */}
      {inHand.status === "billed" ? <HandOver dispense={inHand} busy={busy} error={handOverError} onHandOver={onHandOver} /> : null}
      {error !== null || note !== null ? alerts : null}
    </div>
  );
}

/**
 * OWNER 2026-11-13 — "make sure the pharmacy screen patient search input box in the main panel resembles OPD counter's
 * search box" and "match the border style of input box with what we have in OPD desk": Desk One's find stage
 * (`desk-one/stages.tsx` `StageFind`) — one full-width `.in` field (1px line border at rest, the green border and ring
 * only on focus), no separate button, and under it Desk One's row: a tag, a pill for the other door (here the paper
 * prescription, key P) and the faint line saying what is searched. ⏎ runs the find as before (a scan IS the find; a
 * name never auto-selects, the server's rule); the suggestions are Desk One's hit cards.
 */
function FindField({ onFind, onPaper }: { onFind: (q: string) => void; onPaper: (() => void) | null }): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [paperNote, setPaperNote] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  /*
    2026-10-01 (owner) — WHO THE WORDS COULD BE, AS THEY ARE TYPED. The field answered only on Enter,
    so a registered patient looked absent. A tap runs the ordinary find on that UHID; a QR or a token
    is not a name and the server suggests nothing for it. Enter still finds what was typed.
  */
  const typed = useDebounced(q.trim(), 200);
  const suggest = useQuery({
    queryKey: ["pharmacy", "find-suggest", typed],
    queryFn: () => suggestAtCounter(typed),
    enabled: typed.length >= 2,
    retry: false,
  });
  const hits = q.trim().length >= 2 && typed === q.trim() ? suggest.data ?? null : null;
  const paper = (): void => {
    if (onPaper !== null) { onPaper(); return; }
    setPaperNote(true);
    field.current?.focus();
  };
  return (
    <form style={{ position: "relative" }} onSubmit={(e) => { e.preventDefault(); if (q.trim() !== "") { onFind(q.trim()); setQ(""); } }}>
      <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{t("pharmacyDesk.idleTitle")}</h1>
      <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>{t("pharmacyDesk.idleHint")}</div>
      <input
        id="desk-find"
        ref={field}
        className="in"
        autoFocus
        autoComplete="off"
        aria-label={t("pharmacyDesk.findLabel")}
        value={q}
        onChange={(e) => { setQ(e.target.value); setPaperNote(false); }}
        placeholder={t("pharmacyDesk.findPlaceholder")}
        style={{ height: 52, marginTop: 16, fontSize: 16 }}
      />
      <div style={{ display: "flex", gap: 7, marginTop: 11, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag">{t("pharmacyDesk.find.noSlip")}</span>
        <button type="button" className="pill" data-testid="desk-paper-pill" style={{ borderColor: "var(--green)", color: "var(--green)", fontWeight: 700 }} onClick={paper}>
          {t("pharmacyDesk.find.paperPill")} <span className="kb">P</span>
        </button>
        <span style={{ fontSize: 11, color: "var(--faint)" }}>{t("pharmacyDesk.find.lanes")}</span>
      </div>
      {paperNote ? <p role="status" data-testid="desk-paper-first" style={{ margin: "8px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.find.paperFirst")}</p> : null}
      {hits === null ? null : hits.length === 0 ? (
        <div role="status" data-testid="desk-suggest-none" className="box" style={{ marginTop: 18, padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed", fontSize: 12.5 }}>
          {t("pharmacyDesk.find.suggestNone")}
        </div>
      ) : (
        <div className="pd-hits" data-testid="desk-suggest" style={{ marginTop: 18 }}>
          {hits.map((p, i) => (
            <HitCard
              key={p.id} testId={`desk-suggest-${p.uhid}`} first={i === 0} initials={initialsOf(p)} name={whoLabel(p)}
              hint={p.hint} uhid={p.uhid} onTake={() => { onFind(p.uhid); setQ(""); }}
            />
          ))}
        </div>
      )}
    </form>
  );
}

/** Desk One's hit card (`desk-one/stages.tsx`): initials, who, a quiet hint, the UHID, and "this is them". The card is the act. */
function HitCard({ testId, first, initials, name, hint, uhid, onTake }: {
  testId?: string; first: boolean; initials: string; name: string; hint: string | null; uhid: string; onTake: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <button type="button" className={first ? "box pd-hit first" : "box pd-hit"} data-testid={testId} onClick={onTake}>
      <span className="pd-hit-av" aria-hidden="true">{initials === "" ? "—" : initials}</span>
      <span className="pd-hit-who">
        <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{name}</span>
        {hint === null ? null : <span style={{ display: "block", fontSize: 11.5, color: "var(--dim)", marginTop: 1 }}>{hint}</span>}
      </span>
      <span className="mo pd-hit-uhid">{uhid}</span>
      <span className={first ? "sec grn pd-hit-go" : "sec pd-hit-go"}>{t("pharmacyDesk.find.thisIsThem")}{first ? <span className="kb">⏎</span> : null}</span>
    </button>
  );
}

/**
 * Spec #1055 D5, ruling 0094 — "+ Add a medicine" (key A) under the lines, while the ticket is claimed, checked or
 * collected (never after the bill): the sheet adds one by hand, not prescribed or written on the doctor's paper.
 */
const ADDABLE = new Set(["claimed", "verified", "picked"]);
function AddMedicine({ dispense, label, quick, me, busy, onAdded }: {
  dispense: WireDispense; label: string; quick: boolean; me: string; busy: boolean; onAdded: (d: WireDispense) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [dispense.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "a" && e.key !== "A") return;
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || busy || document.querySelector("[role=dialog]") !== null) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);
  return (
    <div className="pd-addrow" data-testid="desk-add-row">
      <button type="button" className="sec" disabled={busy} onClick={() => setOpen(true)} data-testid="desk-add-medicine">
        {t("pharmacyDesk.add.open")} <span className="kb">A</span>
      </button>
      <span style={{ fontSize: 12, color: "var(--dim)" }}>{dispense.status === "picked" ? t("pharmacyDesk.add.hintAtBill") : t("pharmacyDesk.add.hint")}</span>
      {open ? (
        <AddMedicineSheet
          dispense={dispense} ticketLabel={label} quick={quick} me={me}
          onClose={() => setOpen(false)}
          onDone={(d) => { setOpen(false); onAdded(d); }}
        />
      ) : null}
    </div>
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
  onHandOver: (identity: HandoverIdentity | null, controlled?: ControlledHandover) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [via, setVia] = useState<HandoverIdentity["via"]>("token");
  const [value, setValue] = useState("");
  /* Spec #1046 D1 — the third way: who collected it. Starts unchosen for every ticket, as the token box starts empty (E18). */
  const [who, setWho] = useState<"" | "self" | "attendant">("");
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  /* PHARMACY P6 — a controlled line's witness, retained prescription and collector (`controlled.tsx`). */
  const [controlled, setControlled] = useState<ControlledHandover | null>(null);
  useEffect(() => { setVia("token"); setValue(""); setWho(""); setName(""); setRelation(""); setControlled(null); }, [dispense.id]);
  const needsId = dispense.scheduled;
  const needsControlled = (dispense.controlled ?? null) !== null;
  const identity = identityOf(via, value, who, name, relation);
  const ready = !busy && (!needsId || identity !== null) && (!needsControlled || controlled !== null);
  const go = (): void => { if (ready) onHandOver(needsId ? identity : null, needsControlled && controlled !== null ? controlled : undefined); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  /* PD-7 C10 — what to say, line by line, for what is actually being handed over. */
  const given = rxLinesOf(dispense).filter((l) => l.status === "open" && l.pickedBatch != null);
  const refused = dispense.lines.filter((l) => l.status === "declined");
  const owedNow = owedLine(dispense, t);
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
      {owedNow === null ? null : (
        <p data-testid="desk-say-balance" style={{ margin: "7px 0 0 0", fontSize: 12.5, fontWeight: 600, color: "var(--gold)" }}>{owedNow}</p>
      )}
      {needsId ? (
        /* Walk 2026-11-13 — at 390 px the fixed widths made this row 592 px wide: `.pd-ids` wraps it, and stacks it below 600 px. */
        <div className="pd-ids" data-testid="desk-handover-ids">
          <label className="pd-id-via">
            <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.via")}</span>
            <select className="in" value={via} onChange={(e) => setVia(e.target.value as HandoverIdentity["via"])} style={{ height: 38, marginTop: 4 }}>
              <option value="token">{t("pharmacyDesk.handover.token")}</option>
              <option value="phone_last4">{t("pharmacyDesk.handover.phone")}</option>
              {/* A controlled line keeps the token or the phone, with its witness (P6): the server refuses this way there. */}
              {needsControlled ? null : <option value="collected_by">{t("pharmacyDesk.handover.collectedByWay")}</option>}
            </select>
          </label>
          {via === "collected_by" ? (
            <>
              <label className="pd-id-who">
                <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.collectedBy")}</span>
                <select className="in" value={who} onChange={(e) => setWho(e.target.value as "" | "self" | "attendant")} style={{ height: 38, marginTop: 4 }}>
                  <option value="">{t("pharmacyDesk.handover.choose")}</option>
                  <option value="self">{t("pharmacyDesk.handover.self")}</option>
                  <option value="attendant">{t("pharmacyDesk.handover.attendant")}</option>
                </select>
              </label>
              {who === "attendant" ? (
                <>
                  <label className="pd-id-grow">
                    <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.attendantName")}</span>
                    <input className="in" value={name} maxLength={GUARDIAN_NAME_MAX} onChange={(e) => setName(e.target.value)} style={{ height: 38, marginTop: 4 }} />
                  </label>
                  <label className="pd-id-rel">
                    <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.relation")}</span>
                    <select className="in" value={relation} onChange={(e) => setRelation(e.target.value)} style={{ height: 38, marginTop: 4 }}>
                      <option value="">{t("pharmacyDesk.handover.choose")}</option>
                      {ATTENDANT_RELATIONS.map((r) => <option key={r} value={r}>{t(`patientAbsent.relation.${r}`)}</option>)}
                    </select>
                  </label>
                </>
              ) : null}
            </>
          ) : (
            <label className="pd-id-grow">
              <span className="tag" style={{ display: "block" }}>{t("pharmacyDesk.handover.value")}</span>
              <input className="in mo" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("pharmacyDesk.handover.placeholder")} style={{ height: 38, marginTop: 4 }} />
            </label>
          )}
        </div>
      ) : (
        <p style={{ margin: "7px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.handover.noId")}</p>
      )}
      <ControlledStep dispense={dispense} onChange={setControlled} />
      <button className="pri" style={{ marginTop: 12 }} disabled={!ready} onClick={go}>
        {t("pharmacyDesk.handover.button")}{" "}
        <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Ctrl ⏎</span>
      </button>
      {error !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
    </div>
  );
}

/**
 * Spec #1046 D6, walk 2026-11-13 — the hand-over said nothing of what is still owed, so the patient left without
 * hearing it. One line: what (picked short, `owedQtyBase`) and the window. The window runs from the prescription's
 * FIRST hand-over (`BALANCE_WINDOW_DAYS` on the server), which this hand-over is unless the ticket is itself a balance;
 * a balance short again says what is owed without promising days it may not have.
 */
const BALANCE_WINDOW_DAYS = 30;
function owedLine(d: WireDispense, t: TFunction): string | null {
  const owed = d.lines.filter((l) => l.status === "open" && l.splitFromLineIdx == null && (l.owedQtyBase ?? 0) > 0);
  if (owed.length === 0) return null;
  const what = owed.map((l) => `${l.dispensedMedicine?.brandName ?? l.rxLine.drug} × ${String(l.owedQtyBase ?? 0)}${l.item === null ? "" : ` ${l.item.baseUom}`}`).join(", ");
  return d.balanceOf == null ? t("pharmacyDesk.balance.handover", { what, days: BALANCE_WINDOW_DAYS }) : t("pharmacyDesk.balance.handoverAgain", { what });
}

/** Spec #1046 D1 — the attendant's relation: OPD's "Who came?" list, less `self` (the patient is `who: self`). */
const ATTENDANT_RELATIONS = GUARDIAN_RELATIONS.filter((r) => r !== SELF_RELATION);

/** What the hand-over sends as the person at the window, or null while it is not complete. */
export function identityOf(via: HandoverIdentity["via"], value: string, who: "" | "self" | "attendant", name: string, relation: string): HandoverIdentity | null {
  if (via !== "collected_by") return value.trim() === "" ? null : { via, value: value.trim() };
  if (who === "self") return { via, who: "self" };
  if (who === "attendant" && name.trim() !== "" && relation !== "") return { via, who: "attendant", name: name.trim(), relation };
  return null;
}

/** Spec #1046 D1 — "collected by Ramesh Kumar (Son)" on the finished ticket; null when nobody was named. */
function collectedLine(d: WireDispense, t: TFunction): string | null {
  const c = d.collectedBy ?? null;
  if (c === null) return null;
  if (c.who === "self") return t("pharmacyDesk.handover.collectedSelf");
  return t("pharmacyDesk.handover.collectedAttendant", { name: c.name ?? "", relation: c.relation === null ? "" : t(`patientAbsent.relation.${c.relation}`) });
}

/**
 * Spec #1046 D6 — "REST TOMORROW": a finished ticket that still owes says what, and until when, and opens the
 * balance as a new ticket for only those quantities. Nothing is shown when nothing is owed (or the window passed).
 */
function BalanceOwed({ dispense, onOpen }: { dispense: WireDispense; onOpen: ((dispenseId: string) => void) | null }): React.ReactElement | null {
  const { t, i18n } = useTranslation();
  const owed = dispense.balanceOwed ?? null;
  if (owed === null || onOpen === null) return null;
  const until = new Intl.DateTimeFormat(dateLocale(i18n.language), { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(new Date(owed.until));
  return (
    <div className="box" data-testid="desk-balance" style={{ marginTop: 12, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ flexGrow: 1, fontSize: 12.5 }}>
        {t("pharmacyDesk.balance.owed", { what: owed.lines.map((l) => `${l.drug} × ${String(l.qtyBase)}${l.unit === null ? "" : ` ${l.unit}`}`).join(", "), until })}
      </span>
      <button type="button" className="pri" data-testid="desk-balance-open" onClick={() => onOpen(dispense.id)}>{t("pharmacyDesk.balance.open")}</button>
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
