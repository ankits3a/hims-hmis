import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../lib/auth";
import { newIdempotencyKey } from "../../lib/api";
import { usePaletteOptional } from "../../components/command-palette";
import {
  claimDispense, fetchCounterSummary, fetchDispense, fetchQueue, findAtCounter, pharmacyErrorCode, pharmacyErrorText,
} from "../../lib/pharmacy-api";
import { istClock, istDateLabel } from "../desk-one/model";
import { holdOf } from "./model";
import { say, useDeskLog } from "./log";
import { Dossier, QueueOverlay, QueueRail } from "./rails";
import { TicketPanel } from "./ticket";
import type { DeskLog } from "./log";
import type { WireFindResult, WirePatientSummary } from "../../lib/pharmacy-api";
import "../../styles/paper-pine.css";
import "../desk-one/desk-one.css";

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
 * `Q` the whole line · `F8` the hospital's command palette · `Esc` close, then clear the desk.
 * `S`, `1-4`, `Ctrl+⏎` and `F2` belong to the tasks that build what they press, and are not drawn
 * until then — a keycap that lies is worse than none (`desk-one.tsx`).
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
  const [overlay, setOverlay] = useState<"queue" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const log = useDeskLog();
  const [clock, setClock] = useState(() => istClock());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => { setClock(istClock()); setNow(new Date()); }, 15_000);
    return () => clearInterval(id);
  }, []);

  const queue = useQuery({ queryKey: ["pharmacy", "queue"], queryFn: fetchQueue, refetchInterval: 10_000 });
  const summary = useQuery({ queryKey: ["pharmacy", "summary"], queryFn: () => fetchCounterSummary(), refetchInterval: 60_000 });
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

  const hold = useCallback((id: string): void => {
    setInHandId(id);
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

  /* PD-D6 — the keys this desk draws, and no others. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (overlay !== null) { setOverlay(null); return; }
        if (inHandId !== null || candidates !== null) clearDesk();
        return;
      }
      if (e.key === "F8") { e.preventDefault(); palette?.open(); return; }
      if (typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "q" || e.key === "Q") { e.preventDefault(); setOverlay((o) => (o === "queue" ? null : "queue")); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [candidates, clearDesk, inHandId, overlay, palette]);

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
          <Dossier inHand={inHand} me={me} summary={summary.data ?? null} queued={rows.length} onClear={clearDesk} paletteBound={palette !== null} />

          <main style={{ flexGrow: 1, minWidth: 0, overflowY: "auto", padding: "24px 30px 30px 30px" }}>
            <TicketPanel
              inHand={inHand}
              loading={inHandId !== null && ticket.isPending}
              loadError={ticket.error === null ? null : pharmacyErrorText(ticket.error, t)}
              me={me}
              candidates={candidates}
              error={error}
              note={note}
              onFind={(q) => void find(q)}
              onTake={(id, who) => void takeHere(id, who, false)}
              onClear={clearDesk}
            />
          </main>

          <QueueRail rows={rows} me={me} now={now} inHandId={inHandId} onTake={(id, who, mine) => void takeHere(id, who, mine)} />
        </div>

        <DeskDock log={log} />
      </div>

      {overlay === "queue" ? (
        <QueueOverlay rows={rows} me={me} now={now} onOpen={(id, who, mine) => void openInTab(id, who, mine)} onClose={() => setOverlay(null)} />
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

/** PD-1 / E3 — a sealed record this reader may not open is refused as that, not as "not found". */
function sealedRefusal(e: unknown): boolean {
  if (pharmacyErrorCode(e) !== "permission_denied") return false;
  const body = (e as { body?: { detail?: { reason?: unknown } } }).body;
  return body?.detail?.reason === "patient_restricted";
}

/**
 * The dock, on pine (PD-D16). In PD-3 it carries what HAPPENED at this desk — every server answer
 * with the time it landed. The ask box is PD-7's, with the agent that answers it; drawing it now
 * would be a field that does nothing, which is the keycap that lies in another form.
 */
function DeskDock({ log }: { log: readonly DeskLog[] }): React.ReactElement {
  const { t } = useTranslation();
  const latest = log[0];
  return (
    <div style={{ flexShrink: 0, background: "var(--agent)", color: "var(--agent-fg)" }}>
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
      </div>
    </div>
  );
}
