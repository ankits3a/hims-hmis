import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { noteShortBook, pharmacyErrorText } from "../../lib/pharmacy-api";
import { LineSheet } from "./lines";
import { say } from "./log";
import type { WireShortBookEntry } from "../../lib/pharmacy-api";

/**
 * ═══ PARITY P1 — THE SHORT BOOK, FROM THE DESK ═══
 *
 * Three doors, one act (`POST /pharmacy/short-book`), always a person's:
 *   - `N` opens {@link ShortBookSheet}: ONE field, prefilled with the drug of the line the pharmacist
 *     is on, ⏎ notes it;
 *   - a declined line's sheet offers "also note it in the short book" when the reason reads as a
 *     shortage (`lines.tsx`);
 *   - the counter agent's DRAFT ("Pan 40 khatam" on F2) is a card on the dock ({@link DraftCard}),
 *     confirmed with one tap. The agent never writes; the tap does, as the person who tapped.
 */
export type ShortDrug = { itemId: string | null; name: string };

/** A decline reason that says the drug is not there — the sheet then offers the short book, ticked. */
export function readsAsShortage(reason: string): boolean {
  return /(not\s*stocked|out\s*of\s*stock|no\s*stock|stock\s*(nahi|nhi|out)|short|khatam|khatm|nahi\s*hai|not\s*available|unavailable|स्टॉक\s*नहीं|खत्म)/i.test(reason);
}

/** What the dock says after a note: "noted", or that somebody already had. */
export function sayNoted(t: (k: string, o?: Record<string, unknown>) => string, r: { entry: WireShortBookEntry; created: boolean }): string {
  return r.created ? t("pharmacyDesk.short.noted", { name: r.entry.drugName }) : t("pharmacyDesk.short.already", { name: r.entry.drugName });
}

export function ShortBookSheet({ prefill, dispenseId, onClose }: {
  prefill: ShortDrug | null;
  dispenseId: string | null;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(prefill?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const note = async (): Promise<void> => {
    const drugName = name.trim();
    if (drugName === "" || busy) return;
    setBusy(true); setError(null);
    try {
      /* The line's item travels only while the name is still the line's — an edited name is a different drug. */
      const itemId = prefill !== null && prefill.itemId !== null && drugName === prefill.name ? prefill.itemId : undefined;
      const r = await noteShortBook({ drugName, source: "desk", ...(itemId === undefined ? {} : { itemId }), ...(dispenseId === null ? {} : { dispenseId }) });
      say(sayNoted(t, r), r.created ? "ok" : "warn");
      void qc.invalidateQueries({ queryKey: ["pharmacy", "short-book"] });
      onClose();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <LineSheet title={t("pharmacyDesk.short.title")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void note(); }}>
        <label className="tag" htmlFor="short-book-drug">{t("pharmacyDesk.short.label")}</label>
        <input
          id="short-book-drug"
          className="in"
          autoFocus
          autoComplete="off"
          value={name}
          placeholder={t("pharmacyDesk.short.placeholder")}
          onChange={(e) => setName(e.target.value)}
          style={{ marginTop: 6 }}
        />
        {error !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12, color: "var(--red)" }}>{error}</p> : null}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button type="submit" className="pri" style={{ flexGrow: 1 }} disabled={busy || name.trim() === ""}>
            {t("pharmacyDesk.short.note")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>⏎</span>
          </button>
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyDesk.rack.cancel")}</button>
        </div>
      </form>
    </LineSheet>
  );
}

/** The agent's draft, as the copilot hands it over in its answer's `payload`. */
export type ShortBookDraft = { kind: "short_book_draft"; itemId: string | null; drugName: string; available: number | null; alreadyOpen: boolean };

export function shortBookDraftOf(payload: unknown): ShortBookDraft | null {
  const p = payload as Partial<ShortBookDraft> | null | undefined;
  return p != null && p.kind === "short_book_draft" && typeof p.drugName === "string" ? (p as ShortBookDraft) : null;
}

/**
 * THE DRAFT CARD, on pine because it is the agent's (PD-D16): what it drafted, and the one tap that
 * makes it true. Dismissed, nothing happened; confirmed, the note is the pharmacist's act.
 */
export function DraftCard({ draft, onDone }: { draft: ShortBookDraft; onDone: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const r = await noteShortBook({ drugName: draft.drugName, source: "agent", ...(draft.itemId === null ? {} : { itemId: draft.itemId }) });
      say(sayNoted(t, r), r.created ? "ok" : "warn");
      void qc.invalidateQueries({ queryKey: ["pharmacy", "short-book"] });
      onDone();
    } catch (e) {
      setError(pharmacyErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="desk-draft-card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: "1px solid #24413631" }}>
      <span className="tag" style={{ color: "var(--mint)", flexShrink: 0 }}>{t("pharmacyDesk.short.draftTag")}</span>
      <span style={{ flexGrow: 1, fontSize: 12.5, lineHeight: "18px" }}>
        {t("pharmacyDesk.short.draftBody", { name: draft.drugName })}
        {draft.available !== null ? <span style={{ color: "var(--agent-dim)" }}> · {t("pharmacyDesk.short.draftShelf", { count: draft.available })}</span> : null}
        {error !== null ? <span role="alert" style={{ display: "block", color: "#f1a39b" }}>{error}</span> : null}
      </span>
      <button type="button" className="agdo" disabled={busy} onClick={() => void confirm()}>{t("pharmacyDesk.short.confirm")}</button>
      <button type="button" onClick={onDone} aria-label={t("pharmacyDesk.short.dismiss")} style={{ color: "var(--agent-dim)", fontSize: 15, lineHeight: "15px" }}>×</button>
    </div>
  );
}
