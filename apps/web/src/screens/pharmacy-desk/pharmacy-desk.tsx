import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { ApiError, newIdempotencyKey } from "../../lib/api";
import { fetchCurrentSession } from "../../lib/billing-api";
import { usePaletteOptional } from "../../components/command-palette";
import { useCopilot } from "../../lib/use-copilot";
import {
  billDispense, claimDispense, confirmDispenseSlip, declineLine, fetchCounterSummary, fetchDispense, fetchMyRegistration, fetchMyShift, fetchQueue, findAtCounter, handOverDispense,
  pharmacyErrorCode, pharmacyErrorText, pickDispense, previewBill, verifyDispense,
} from "../../lib/pharmacy-api";
import { istClock, istDateLabel } from "../desk-one/model";
import { heldByAnother, holdOf, stageOf, ticketLabel, whoLabel } from "./model";
import { BillRail, heldUntil, holdEnded, rupees } from "./bill";
import { noteDraftSaved, say, useDeskLog, useDraftNotice } from "./log";
import { Dossier, QueueOverlay, QueueRail } from "./rails";
import { SlipSheet } from "./slip";
import { DraftCard, PaymentRunCard, PurchasePlanCard, ReturnPlanCard, ShortBookSheet, paymentRunPlanOf, purchasePlanOf, returnPlanOf, shortBookDraftOf } from "./short-book";
import type { PaymentRunCardData, PurchasePlanCardData, ReturnPlanCardData, ShortBookDraft, ShortDrug } from "./short-book";
import { TicketPanel } from "./ticket";
import type { DeskLog } from "./log";
import type { CollectResult } from "./lines";
import type { PickLine, Tender, VerifyLine, WireDispense, WireFindResult, WirePatientSummary } from "../../lib/pharmacy-api";
import "../../styles/paper-pine.css";
import "../desk-one/desk-one.css";
import "./pharmacy-desk.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE PD — THE PHARMACY DESK: ONE TICKET IN HAND, ONE SCREEN (PD-3, the shell)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's instruction of 2026-09-18: three columns, one ticket in hand, the line on the right
 * until you claim. The design is the canvas's `Desk.dc.html`; the rules are
 * `docs/superpowers/plans/2026-09-18-phase-pharmacy-desk.md`. This file is the FRAME — header,
 * columns, keys, dock — and the ticket in hand. The line list (PD-4), the substitute sheet (PD-5),
 * the bill (PD-6), the agent (PD-7) and the slip (PD-8) arrive into it.
 *
 * ═══ THE TICKET IN HAND IS THE URL ═══
 *
 * `/pharmacy/desk/<dispense id>` (PD-D7). The owner's queue opens a ticket in a NEW TAB, which
 * needs the ticket to be addressable, and a reload must not drop the patient at the window. The id
 * and not the `P` number: a waiting ticket has no number until verify (PD-D8, owner-gated).
 *
 * ═══ SCANNING IS TAKING ═══
 *
 * A slip scanned at this window is the pharmacist's intent, so a queued ticket found by the field is
 * CLAIMED at once rather than shown with a second button to press. If somebody else holds it the
 * refusal names them (PD-1) and nothing is taken.
 *
 * ═══ EVERY KEYCAP DRAWN IS BOUND (PD-D6) ═══
 *
 * `Q` the whole line · `F8` the hospital's command palette · `N` note a shortage in the short book
 * (parity P1) · `Esc` close, then clear the desk.
 * `S`, `1-4`, `Ctrl+⏎` and `F2` belong to the tasks that build what they press, and are not drawn
 * until then — a keycap that lies is worse than none (`desk-one.tsx`). `F2` is PD-7 C8's: it asks
 * the counter agent, in the dock.
 */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function PharmacyDesk({ ticketId }: { ticketId: string | null }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { actor, username } = useAuth();
  const me = actor?.type === "user" ? actor.id : null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const palette = usePaletteOptional();

  const [inHandId, setInHandId] = useState<string | null>(ticketId);
  useEffect(() => { setInHandId(ticketId); }, [ticketId]);
  const [candidates, setCandidates] = useState<WirePatientSummary[] | null>(null);
  const [overlay, setOverlay] = useState<"queue" | "slip" | "short" | null>(null);
  /* PARITY P1 — the hand-over that just happened HERE prints by itself; reopening an old ticket does not. */
  const [justHandedOver, setJustHandedOver] = useState<string | null>(null);
  /* PARITY P1 — the line the pharmacist is on, so `N` opens the short book prefilled with its drug. */
  const [focusedDrug, setFocusedDrug] = useState<ShortDrug | null>(null);
  useEffect(() => { setFocusedDrug(null); }, [inHandId]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [billError, setBillError] = useState<string | null>(null);
  /* Save draft's confirmation, said where the pharmacist is looking — the desk — until the next ticket is in hand. */
  const savedDraft = useDraftNotice();
  const [handOverError, setHandOverError] = useState<string | null>(null);
  /*
    E26 — ONE idempotency key per money act per ticket, kept across a NETWORK failure (no answer:
    the charge may or may not have landed, and the retry must be the same request) and dropped when
    the server ANSWERED (a refusal is final for that body; a corrected tender is a new request).
  */
  const moneyKeys = useRef(new Map<string, string>());
  const keyFor = (act: string, id: string): string => {
    const k = `${act}:${id}`;
    const existing = moneyKeys.current.get(k);
    if (existing !== undefined) return existing;
    const fresh = newIdempotencyKey();
    moneyKeys.current.set(k, fresh);
    return fresh;
  };
  const answered = (act: string, id: string, e: unknown): void => { if (e instanceof ApiError) moneyKeys.current.delete(`${act}:${id}`); };
  const log = useDeskLog();
  /*
    ═══ PD-7 C8 — THE ASK BOX, ON THE SHARED COPILOT ═══
    The hospital's questions ("kitni amoxicillin bachi hai", "kiska paisa pending hai") go to the one
    copilot every seat shares, and are answered by the pharmacy's tools by lookup. A question about
    THIS screen ("ye batch kab expire hoga") is answered from the ticket in hand and nothing is sent.
    Names on the screen are handed over to be masked by value — a name has no shape a pattern finds.
  */
  const [said, setSaid] = useState<string | null>(null);
  const [clock, setClock] = useState(() => istClock());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => { setClock(istClock()); setNow(new Date()); }, 15_000);
    return () => clearInterval(id);
  }, []);

  const queue = useQuery({ queryKey: ["pharmacy", "queue"], queryFn: fetchQueue, refetchInterval: 10_000 });
  const summary = useQuery({ queryKey: ["pharmacy", "summary"], queryFn: () => fetchCounterSummary(), refetchInterval: 60_000 });
  /* PARITY P1 — "your day" is this pharmacist's shift: their hand-overs, their money by tender, their drawer. */
  const shift = useQuery({ queryKey: ["pharmacy", "summary", "mine"], queryFn: fetchMyShift, refetchInterval: 60_000, retry: false });
  /*
    Polled while in hand, because the server can change the ticket under the pharmacist — the pick
    reservation sweep cancels an abandoned pick after 30 minutes (E13) — and the screen must learn
    that from a read, not from the next write failing.
  */
  const ticket = useQuery({
    queryKey: ["pharmacy", "dispense", inHandId],
    queryFn: () => fetchDispense(inHandId ?? ""),
    enabled: inHandId !== null,
    refetchInterval: 15_000,
  });
  const namesOnScreen = useCallback((): string[] => {
    const people = [ticket.data?.patient, ...(queue.data ?? []).map((r) => r.patient)];
    return [...new Set(people.flatMap((p) => (p === undefined || p.name === null ? [] : [p.name])))];
  }, [ticket.data?.patient, queue.data]);
  const screenAnswer = useCallback((q: string): string | null => {
    const d = ticket.data;
    if (d === undefined || !/\b(ye|yeh|is|this|iska|iski)\b/i.test(q) || !/(batch|expir|एक्सपायर)/i.test(q)) return null;
    const items = d.lines.filter((l) => l.status === "open").flatMap((l) => {
      const b = l.pickedBatch ?? l.batches?.[0];
      return b == null ? [] : [t("pharmacyDesk.ask.batchItem", { name: l.dispensedMedicine?.brandName ?? l.rxLine.drug, batch: b.batchNo, expiry: b.expiryDate ?? "—" })];
    });
    return items.length === 0 ? null : t("pharmacyDesk.ask.onTicket", { items: items.join("; ") });
  }, [ticket.data, t]);
  const copilot = useCopilot({ terms: namesOnScreen, fallback: screenAnswer });
  /* An answer is shown when the server's reply lands — keyed on the round trip, so the same answer twice still shows. */
  const asking = useRef(false);
  useEffect(() => {
    if (asking.current && !copilot.busy) setSaid(copilot.answer);
    asking.current = copilot.busy;
  }, [copilot.busy, copilot.answer]);
  const ask = (q: string): void => {
    const local = screenAnswer(q);
    if (local !== null) setSaid(local);
    else copilot.ask(q);
  };
  const status = ticket.data?.status ?? null;
  /* The pharmacist's OWN drawer — every receipt needs it, not only cash (E21, measured). A 403 reads as closed. */
  const drawer = useQuery({ queryKey: ["billing", "session", "current"], queryFn: fetchCurrentSession, refetchInterval: 60_000, retry: false });
  /* The header's other precondition: may this login verify (Pharmacy Act 1948 §42)? A 404 (older server) says nothing. */
  const registration = useQuery({ queryKey: ["pharmacy", "pharmacists", "me"], queryFn: fetchMyRegistration, staleTime: 5 * 60_000, retry: false });
  /* Priced at batch grain, so only once collected; the last answer stays in the cache after hand-over. */
  const preview = useQuery({
    queryKey: ["pharmacy", "bill", inHandId],
    queryFn: () => previewBill(inHandId ?? ""),
    enabled: inHandId !== null && (status === "picked" || status === "billed"),
    retry: false,
  });

  const hold = useCallback((id: string): void => {
    setInHandId(id);
    noteDraftSaved(null);
    setCandidates(null);
    setNote(null);
    void navigate({ to: "/pharmacy/desk/$ticketId", params: { ticketId: id } });
  }, [navigate]);

  const clearDesk = useCallback((): void => {
    setInHandId(null);
    setCandidates(null);
    setError(null);
    setNote(null);
    void navigate({ to: "/pharmacy/desk" });
  }, [navigate]);

  /** Claim, then hold. A refusal that names a holder says so in the pharmacist's words (PD-1). */
  const take = useCallback(async (dispenseId: string, door: string, who: string): Promise<boolean> => {
    setError(null);
    try {
      await claimDispense(dispenseId, door, newIdempotencyKey());
      say(t("pharmacyDesk.log.claimed", { who }));
      await qc.invalidateQueries({ queryKey: ["pharmacy"] });
      return true;
    } catch (e) {
      const holder = heldBy(e);
      const text = holder !== null ? t("pharmacyDesk.heldBy", { name: holder })
        : sealedRefusal(e) ? t("pharmacyDesk.sealedRefused")
          : pharmacyErrorText(e, t);
      setError(text);
      say(text, "err");
      await qc.invalidateQueries({ queryKey: ["pharmacy", "queue"] });
      return false;
    }
  }, [qc, t]);

  const find = useCallback(async (q: string): Promise<void> => {
    setError(null); setNote(null); setCandidates(null);
    let r: WireFindResult;
    try { r = await findAtCounter(q); } catch (e) { setError(pharmacyErrorText(e, t)); return; }
    if (r.kind === "patients") { setCandidates(r.patients); return; }
    if (r.kind === "none") {
      if (r.reason === "restricted") { setError(t("pharmacyDesk.sealedRefused")); return; }
      const key = r.reason === "qr_invalid" ? "qrInvalid" : r.reason === "no_prescription_today" ? "noRx" : "notFound";
      setNote(t(`pharmacyDesk.find.${key}`));
      return;
    }
    const d = r.dispense;
    if (d.status === "queued") {
      if (!(await take(d.id, r.door, d.patient.alias ?? d.patient.name ?? d.patient.uhid))) return;
    }
    hold(d.id);
  }, [hold, t, take]);

  /* A ticket already yours opens without a second claim — the server would refuse it, naming you. */
  const openInTab = useCallback(async (dispenseId: string, who: string, mine: boolean): Promise<void> => {
    if (mine || await take(dispenseId, "token", who)) window.open(`/pharmacy/desk/${dispenseId}`, "_blank", "noopener");
  }, [take]);

  const takeHere = useCallback(async (dispenseId: string, who: string, claimed: boolean): Promise<void> => {
    if (claimed || await take(dispenseId, "token", who)) hold(dispenseId);
  }, [hold, take]);

  const settle = useCallback((d: WireDispense): void => {
    qc.setQueryData(["pharmacy", "dispense", d.id], d);
    void qc.invalidateQueries({ queryKey: ["pharmacy", "queue"] });
    void qc.invalidateQueries({ queryKey: ["pharmacy", "summary"] });
  }, [qc]);

  /**
   * PD-4 — the last settle: verify (skipped when a previous attempt got that far) and then pick. A
   * refusal that names a line is handed back ON that line; the ticket is re-read either way, because
   * a verify that succeeded before a pick that failed has changed the ticket (it now has a number).
   */
  const collect = useCallback(async (verify: VerifyLine[] | null, pick: PickLine[]): Promise<CollectResult> => {
    if (inHandId === null) return { ok: false, lineErrors: {}, message: null };
    setBusy(true);
    try {
      if (verify !== null) {
        const v = await verifyDispense(inHandId, verify, newIdempotencyKey());
        settle(v);
        say(t("pharmacyDesk.log.verified", { no: v.dispenseNo ?? "" }));
      }
      const p = await pickDispense(inHandId, pick, newIdempotencyKey());
      settle(p);
      /* PD-7 C6 — the hold is said by its END, the time the strips go back on the shelf by themselves. */
      const held = p.lines.filter((l) => l.pickedBatch != null).length;
      const until = heldUntil(p.pickedAt);
      say(until === null ? t("pharmacyDesk.log.collected", { count: held }) : t("pharmacyDesk.log.collectedUntil", { count: held, time: until }));
      return { ok: true };
    } catch (e) {
      await qc.invalidateQueries({ queryKey: ["pharmacy", "dispense", inHandId] });
      const text = pharmacyErrorText(e, t);
      say(text, "err");
      return { ok: false, lineErrors: lineErrorsOf(e, text), message: text };
    } finally {
      setBusy(false);
    }
  }, [inHandId, qc, settle, t]);

  const takeMoney = useCallback(async (tenders: Tender[], changePaise: number): Promise<void> => {
    if (inHandId === null) return;
    setBusy(true); setBillError(null);
    try {
      const d = await billDispense(inHandId, { tenders, ...(changePaise > 0 ? { changeGivenPaise: changePaise } : {}) }, keyFor("bill", inHandId));
      moneyKeys.current.delete(`bill:${inHandId}`);
      settle(d);
      /* what was BILLED: a cash tender is the note handed over, so the change comes off it */
      const total = tenders.reduce((n, x) => n + x.amountPaise, 0) - changePaise;
      say(t("pharmacyDesk.log.billed", { amount: rupees(total), modes: tenders.map((x) => x.mode).join(" + ") }));
    } catch (e) {
      answered("bill", inHandId, e);
      const text = e instanceof ApiError ? pharmacyErrorText(e, t) : t("pharmacyDesk.bill.networkRetry");
      setBillError(text);
      say(text, "err");
      await qc.invalidateQueries({ queryKey: ["pharmacy", "dispense", inHandId] });
    } finally {
      setBusy(false);
    }
  }, [inHandId, qc, settle, t]);

  const handOver = useCallback(async (identity: { via: "token" | "phone_last4"; value: string } | null): Promise<void> => {
    if (inHandId === null) return;
    setBusy(true); setHandOverError(null);
    try {
      const d = await handOverDispense(inHandId, identity, keyFor("handover", inHandId));
      moneyKeys.current.delete(`handover:${inHandId}`);
      settle(d);
      setJustHandedOver(d.id);
      say(t("pharmacyDesk.log.handedOver", { who: d.patient.alias ?? d.patient.name ?? d.patient.uhid }));
    } catch (e) {
      answered("handover", inHandId, e);
      const text = pharmacyErrorText(e, t);
      setHandOverError(text);
      say(text, "err");
    } finally {
      setBusy(false);
    }
  }, [inHandId, settle, t]);

  /* E27 — a draft keeps the claim and whatever is held; the sentence names the deadline. */
  /*
    It makes no server call because none is needed: the claim IS the draft (the ticket stays this
    pharmacist's, and a collected one keeps its strips until the hold ends). What was missing was the
    SAYING of it — the owner pressed it and saw the desk empty. So the desk says which ticket was
    saved, what was kept, and where to find it; the line shows it first as "your draft · resume".
  */
  const draft = useCallback((): void => {
    const d = ticket.data;
    const until = heldUntil(d?.pickedAt ?? null);
    /* E13 — a hold already over keeps nothing but the claim, and the log says only that. */
    const claimOnly = until === null || holdEnded(d?.pickedAt ?? null, new Date());
    say(claimOnly ? t("pharmacyDesk.log.draftClaimOnly") : t("pharmacyDesk.log.draftHeld", { time: until }), "warn");
    const label = d === undefined ? "" : (ticketLabel(d.dispenseNo) ?? whoLabel(d.patient));
    clearDesk();
    noteDraftSaved(claimOnly ? t("pharmacyDesk.draftSaved.claimOnly", { ticket: label }) : t("pharmacyDesk.draftSaved.held", { ticket: label, time: until }));
  }, [clearDesk, t, ticket.data]);

  /* FD-31 / E28 — the cross-confirmation, asked for when the ticket is opened rather than at the till. */
  const confirmSlip = useCallback(async (): Promise<void> => {
    if (inHandId === null) return;
    setError(null);
    try {
      await confirmDispenseSlip(inHandId);
      await qc.invalidateQueries({ queryKey: ["pharmacy", "dispense", inHandId] });
      say(t("pharmacyDesk.log.slipConfirmed"));
    } catch (e) {
      const text = pharmacyErrorText(e, t);
      setError(text);
      say(text, "err");
    }
  }, [inHandId, qc, t]);

  const decline = useCallback(async (lineIdx: number, reason: string): Promise<boolean> => {
    if (inHandId === null) return false;
    setError(null);
    try {
      const d = await declineLine(inHandId, lineIdx, reason);
      settle(d);
      say(t("pharmacyDesk.log.declined", { line: lineIdx + 1, reason }), "warn");
      return true;
    } catch (e) {
      const text = pharmacyErrorText(e, t);
      setError(text);
      say(text, "err");
      return false;
    }
  }, [inHandId, settle, t]);

  /* PD-D6 — the keys this desk draws, and no others. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (overlay !== null) { setOverlay(null); return; }
        /* Esc in a field lets go of the field; a second Esc clears the desk. A half-ticked ticket is
           one keystroke from being thrown away otherwise. */
        if (typingIn(e.target)) { (e.target as HTMLElement).blur(); return; }
        if (inHandId !== null || candidates !== null) clearDesk();
        return;
      }
      if (e.key === "F8") { e.preventDefault(); palette?.open(); return; }
      if (typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "q" || e.key === "Q") { e.preventDefault(); setOverlay((o) => (o === "queue" ? null : "queue")); return; }
      /* PARITY P1 — `N`: note a shortage. One field, prefilled with the drug of the line in hand. */
      if ((e.key === "n" || e.key === "N") && document.querySelector("[role=dialog]") === null) { e.preventDefault(); setOverlay("short"); return; }
      /* `S` exists only where there is paper to see: a ticket typed from the doctor's slip. */
      if ((e.key === "s" || e.key === "S") && ticket.data?.transcribedBy != null) { e.preventDefault(); setOverlay("slip"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [candidates, clearDesk, inHandId, overlay, palette, ticket.data?.transcribedBy]);

  const rows = queue.data ?? [];
  const waiting = rows.filter((r) => r.status === "queued" && holdOf(r, me).kind === "free").length;
  const inHand = ticket.data ?? null;

  return (
    <div className="d1" data-lang={i18n.language.startsWith("hi") ? "hi" : "en"} data-seat="pharmacy-desk">
      <div className="frame">
        <div className="top">
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)", transform: "rotate(45deg)" }} />
            <span className="mo" style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: ".08em" }}>{t("pharmacyDesk.wordmark")}</span>
          </div>
          <span style={{ color: "var(--line)" }}>/</span>
          <span style={{ fontSize: 12.5, color: "var(--dim)" }}>
            {t("pharmacyDesk.where")} · <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{username ?? t("pharmacyDesk.thisDesk")}</strong>
          </span>
          {registration.data === undefined ? null : registration.data.registration === null ? (
            <span className="pill rd" style={{ height: 22 }} data-testid="desk-registered">{t("pharmacyDesk.header.notRegistered")}</span>
          ) : (
            <span className="pill on" style={{ height: 22 }} data-testid="desk-registered" title={registration.data.registration.council}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z" /></svg>
              {t("pharmacyDesk.header.registered", { no: registration.data.registration.registrationNo })}
            </span>
          )}
          {drawer.isPending ? null : drawer.data?.session?.status === "open" ? (
            <span className="pill" style={{ height: 22 }} data-testid="desk-drawer">
              {t("pharmacyDesk.header.drawerOpen", { float: `₹${(drawer.data.session.openingFloatPaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` })}
            </span>
          ) : (
            <span data-testid="desk-drawer" style={{ display: "inline-flex" }}>
              <button type="button" className="pill gd" style={{ height: 22 }} onClick={() => void navigate({ to: "/billing/session" })}>{t("pharmacyDesk.header.noDrawer")}</button>
            </span>
          )}
          <span className="pill">PHARM-OPD</span>
          <div style={{ flexGrow: 1 }} />
          <span className="mo" style={{ fontSize: 11.5, color: "var(--faint)", letterSpacing: ".04em" }}>{istDateLabel()} · {clock}</span>
          <button
            className={waiting > 0 ? "pill gd" : "pill"}
            style={{ height: 24 }}
            data-testid="desk-waiting"
            onClick={() => setOverlay("queue")}
          >
            {t("pharmacyDesk.waiting", { count: waiting })} <span className="kb">Q</span>
          </button>
          {palette === null ? null : (
            <button className="pill" style={{ height: 24, borderColor: "var(--ink)" }} onClick={() => palette.open()}>
              {t("pharmacyDesk.command")} <span className="kb">F8</span>
            </button>
          )}
        </div>

        <div style={{ display: "flex", flexGrow: 1, minHeight: 0 }}>
          <Dossier inHand={inHand} me={me} summary={summary.data ?? null} shift={shift.data ?? null} queued={rows.length} onClear={clearDesk} paletteBound={palette !== null} />

          <main style={{ flexGrow: 1, minWidth: 0, overflowY: "auto", padding: "24px 30px 30px 30px" }}>
            {savedDraft === null || inHandId !== null ? null : (
              <div role="status" data-testid="desk-draft-saved" className="draft-saved">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}><path d="M5 12l5 5L19 7" /></svg>
                <span style={{ flexGrow: 1 }}>{savedDraft}</span>
                <button type="button" aria-label={t("pharmacyDesk.draftSaved.dismiss")} onClick={() => noteDraftSaved(null)} style={{ color: "var(--dim)", fontSize: 15, lineHeight: "15px" }}>×</button>
              </div>
            )}
            <TicketPanel
              inHand={inHand}
              loading={inHandId !== null && ticket.isPending}
              loadError={ticket.error === null ? null : pharmacyErrorText(ticket.error, t)}
              me={me}
              candidates={candidates}
              error={error}
              note={note}
              busy={busy}
              onCollect={collect}
              onDecline={decline}
              handOverError={handOverError}
              takenLabel={preview.data === undefined ? null : rupees(preview.data.totals.netPayablePaise)}
              onHandOver={(identity) => void handOver(identity)}
              onOpenSlip={() => setOverlay("slip")}
              queue={rows}
              onShowLine={() => setOverlay("queue")}
              onConfirmSlip={() => void confirmSlip()}
              onFind={(q) => void find(q)}
              onTake={(id, who) => void takeHere(id, who, false)}
              onClear={clearDesk}
              autoPrint={inHand !== null && justHandedOver === inHand.id}
              onFocusDrug={setFocusedDrug}
            />
          </main>

          {/* PD-D5 — the bill takes the line's place once a ticket of MINE is past "found". */}
          {inHand !== null && !heldByAnother(inHand, me) && stageOf(inHand, me) !== "found" ? (
            <BillRail
              dispense={inHand}
              preview={preview.data ?? null}
              previewError={preview.error === null ? null : pharmacyErrorText(preview.error, t)}
              drawerOpen={drawer.isPending ? null : drawer.data?.session?.status === "open"}
              busy={busy}
              error={billError}
              now={now}
              onTake={(tenders, change) => void takeMoney(tenders, change)}
              onDraft={draft}
              onOpenDrawer={() => void navigate({ to: "/billing/session" })}
            />
          ) : (
            <QueueRail
              rows={rows} me={me} now={now} inHandId={inHandId}
              onTake={(id, who, mine) => void takeHere(id, who, mine)}
              onOpenTab={(id, who, mine) => void openInTab(id, who, mine)}
            />
          )}
        </div>

        <DeskDock log={log} said={said} busy={copilot.busy} onAsk={ask} onDismiss={() => setSaid(null)} draft={shortBookDraftOf(copilot.payload)} plan={purchasePlanOf(copilot.payload)} payPlan={paymentRunPlanOf(copilot.payload)} returnPlan={returnPlanOf(copilot.payload)} onDraftDone={copilot.clearPayload} />
      </div>

      {overlay === "slip" && inHand !== null ? <SlipSheet dispense={inHand} onClose={() => setOverlay(null)} /> : null}
      {overlay === "short" ? <ShortBookSheet prefill={inHand === null ? null : focusedDrug} dispenseId={inHandId} onClose={() => setOverlay(null)} /> : null}
      {overlay === "queue" ? (
        <QueueOverlay rows={rows} me={me} now={now} onOpen={(id, who, mine) => void openInTab(id, who, mine)} onResume={(id) => { setOverlay(null); hold(id); }} onClose={() => setOverlay(null)} />
      ) : null}
    </div>
  );
}

/** `detail.claimedByName` on a lost claim (PD-1) — the one refusal that should read as a name, not a code. */
function heldBy(e: unknown): string | null {
  if (pharmacyErrorCode(e) !== "dispense_not_in_state") return null;
  const body = (e as { body?: { detail?: { status?: unknown; claimedByName?: unknown } } }).body;
  const name = body?.detail?.claimedByName;
  return body?.detail?.status === "claimed" && typeof name === "string" ? name : null;
}

/**
 * The refusals that name a line — `detail.lineIdx` (short stock, a quantity, a scan, a batch) or the
 * allergy/interaction `hits` — as sentences on those lines. Anything else is the ticket's.
 */
function lineErrorsOf(e: unknown, text: string): Record<number, string> {
  const detail = (e as { body?: { detail?: { lineIdx?: unknown; hits?: unknown } } }).body?.detail;
  const out: Record<number, string> = {};
  if (typeof detail?.lineIdx === "number") out[detail.lineIdx] = text;
  if (Array.isArray(detail?.hits)) {
    for (const h of detail.hits as { lineIdx?: unknown }[]) if (typeof h.lineIdx === "number") out[h.lineIdx] = text;
  }
  return out;
}

/** PD-1 / E3 — a sealed record this reader may not open is refused as that, not as "not found". */
function sealedRefusal(e: unknown): boolean {
  if (pharmacyErrorCode(e) !== "permission_denied") return false;
  const body = (e as { body?: { detail?: { reason?: unknown } } }).body;
  return body?.detail?.reason === "patient_restricted";
}

/**
 * The dock, on pine (PD-D16). It carries what HAPPENED at this desk — every server answer with the
 * time it landed — and, since PD-7 C8, the ask box: `F2` focuses it (bound here, locally, as the
 * shared `AgentDock` binds it), and an answer is said IN FULL above the bar, never cut to a ticker.
 */
function DeskDock({ log, said, busy, onAsk, onDismiss, draft: agentDraft, plan, payPlan, returnPlan, onDraftDone }: {
  log: readonly DeskLog[];
  said: string | null;
  busy: boolean;
  onAsk: (question: string) => void;
  onDismiss: () => void;
  /** PARITY P1 — the agent's short-book draft, confirmed on the card with one tap. */
  draft: ShortBookDraft | null;
  /** PARITY P2 — the agent's order plan ("order karo"), a card that opens the office. */
  plan: PurchasePlanCardData | null;
  /** PARITY P3 — the agent's payment-run plan ("payment run bana do"), a card that opens the office's pay side. */
  payPlan: PaymentRunCardData | null;
  /** PARITY P4 — the agent's return plan ("expiry return bana do"), a card that opens the office's returns side. */
  returnPlan: ReturnPlanCardData | null;
  onDraftDone: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const latest = log[0];
  const [draft, setDraft] = useState("");
  const askRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "F2") return;
      e.preventDefault();
      askRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div style={{ flexShrink: 0, background: "var(--agent)", color: "var(--agent-fg)" }}>
      {agentDraft === null || agentDraft.alreadyOpen ? null : <DraftCard draft={agentDraft} onDone={onDraftDone} />}
      {plan === null ? null : <PurchasePlanCard plan={plan} onDone={onDraftDone} />}
      {payPlan === null ? null : <PaymentRunCard plan={payPlan} onDone={onDraftDone} />}
      {returnPlan === null ? null : <ReturnPlanCard plan={returnPlan} onDone={onDraftDone} />}
      {/* The card IS the answer to a draft; saying it again above the bar is the same sentence twice. */}
      {said === null || (agentDraft !== null && !agentDraft.alreadyOpen) || plan !== null || payPlan !== null || returnPlan !== null ? null : (
        <div data-testid="desk-answer" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 18px", borderBottom: "1px solid #24413631" }}>
          <span style={{ flexGrow: 1, fontSize: 12.5, lineHeight: "18px" }}>{said}</span>
          <button onClick={onDismiss} aria-label={t("pharmacyDesk.ask.dismiss")} style={{ color: "var(--agent-dim)", fontSize: 15, lineHeight: "15px" }}>×</button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 13, height: 54, padding: "0 18px" }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, background: "var(--mint)", flexShrink: 0 }} />
        <span className="tag" style={{ color: "var(--agent-dim)", flexShrink: 0 }}>{t("pharmacyDesk.dock")}</span>
        <span
          className="mo"
          data-testid="desk-ticker"
          style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexGrow: 1, color: latest?.kind === "err" ? "#f1a39b" : "var(--agent-fg)" }}
        >
          {latest === undefined ? t("pharmacyDesk.dockQuiet") : `${latest.at}  ${latest.text}`}
        </span>
        <form
          style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}
          onSubmit={(e) => { e.preventDefault(); const q = draft.trim(); if (q !== "") { onAsk(q); setDraft(""); } }}
        >
          <input
            ref={askRef}
            aria-label={t("pharmacyDesk.ask.label")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={busy ? "…" : t("pharmacyDesk.ask.placeholder")}
            autoComplete="off"
            style={{ width: 290, height: 32, padding: "0 10px", borderRadius: 6, border: "1px solid #3a5a4e", background: "#0f2a22", color: "var(--agent-fg)", fontSize: 12.5 }}
          />
          <span className="kb" style={{ borderColor: "#3a5a4e", background: "transparent", color: "var(--agent-dim)" }}>F2</span>
        </form>
      </div>
    </div>
  );
}
