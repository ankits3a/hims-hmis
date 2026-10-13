import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type React from "react";
import type { MaintenanceItemKind, MaintenancePlace, MaintenanceUrgency, RaiseTicketResult } from "@hmis/contracts";
import { ITEM_KINDS, URGENCIES, maintenanceRefusal, raiseTicketApi, searchPlaces } from "../lib/maintenance-api";
import "./maintenance.css";

/**
 * ═══ E1.5 MAINTENANCE (issue #722) — "REPORT A FAULT", THE RAISE SHEET (390 px first) ═══
 *
 * Opened from the Beds board's drawer (the bed already picked) or from the maintenance board (a place picker). Four
 * things and a button, big targets, Hindi first: the place, the item (nine buttons), the urgency (three buttons, each
 * saying when the bed is expected back), a short note. The answer says what happened to the bed in words —
 * blocked now, blocked when the patient leaves, joined an existing repair block — and the repair's number.
 */
export type FixedPlace = { id: string; code: string; name: string };

export function RaiseTicketSheet(p: { place?: FixedPlace; onClose: () => void; onDone?: (r: RaiseTicketResult) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [place, setPlace] = useState<FixedPlace | null>(p.place ?? null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MaintenancePlace[]>([]);
  const [item, setItem] = useState<MaintenanceItemKind | null>(null);
  const [urgency, setUrgency] = useState<MaintenanceUrgency>("urgent");
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RaiseTicketResult | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent): void => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [p]);
  useEffect(() => {
    if (place !== null || q.trim().length < 2) { setFound([]); return; }
    let live = true;
    const id = setTimeout(() => { searchPlaces(q.trim()).then((r) => { if (live) setFound(r); }, () => { if (live) setFound([]); }); }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [q, place]);

  const ready = place !== null && item !== null && note.trim() !== "" && !busy;
  const submit = (): void => {
    if (!ready) return;
    setBusy(true); setRefusal(null);
    raiseTicketApi({ placeResourceId: place.id, itemKind: item, urgency, description: note.trim(), ...(tag.trim() === "" ? {} : { itemTag: tag.trim() }) })
      .then((r) => { setBusy(false); setResult(r); p.onDone?.(r); }, (e: unknown) => {
        setBusy(false);
        const r = maintenanceRefusal(e);
        setRefusal(r === null ? t("maintenance.raise.failed") : `${t(`maintenance.refusal.${r.code}`, { defaultValue: r.message })} ${r.fix}`.trim());
      });
  };

  return (
    <>
      <div className="mt-scrim" onClick={p.onClose} aria-hidden="true" />
      <section className="mt-sheet" role="dialog" aria-modal="true" aria-label={t("maintenance.raise.title")} data-testid="maintenance-raise">
        <header>
          <h2>{t("maintenance.raise.title")}</h2>
          <button type="button" className="mt-x" onClick={p.onClose}>{t("maintenance.close")}</button>
        </header>
        {result !== null ? (
          <div className="mt-done" role="status" data-testid="maintenance-raised">
            <b>{result.merged ? t("maintenance.raise.merged", { n: result.number }) : t("maintenance.raise.raised", { n: result.number })}</b>
            <span>{t(`maintenance.bedEffect.${result.bed}`)}</span>
            {result.replacementFlag ? <span className="mt-flag">{t("maintenance.replace.flagged")}</span> : null}
            <button type="button" className="mt-go" onClick={p.onClose}>{t("maintenance.done")}</button>
          </div>
        ) : (
          <form className="mt-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="mt-field">
              <span className="mt-lbl">{t("maintenance.raise.place")}</span>
              {place !== null ? (
                <div className="mt-place" data-testid="maintenance-place">
                  <b className="mono">{place.code}</b><span>{place.name !== place.code ? place.name : ""}</span>
                  {p.place === undefined ? <button type="button" className="mt-link" onClick={() => setPlace(null)}>{t("maintenance.raise.change")}</button> : null}
                </div>
              ) : (
                <>
                  <input className="mt-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("maintenance.raise.placeHint")}
                    aria-label={t("maintenance.raise.place")} autoComplete="off" />
                  {found.length > 0 ? (
                    <div className="mt-found" role="listbox">
                      {found.slice(0, 6).map((f) => (
                        <button key={f.id} type="button" role="option" aria-selected={false} onClick={() => { setPlace(f); setFound([]); }}>
                          <b className="mono">{f.code}</b> <span>{t(`maintenance.placeKind.${f.kind}`, { defaultValue: f.kind })}{f.floorName ? ` · ${f.floorName}` : ""}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="mt-field">
              <span className="mt-lbl">{t("maintenance.raise.item")}</span>
              <div className="mt-grid" role="group" aria-label={t("maintenance.raise.item")}>
                {ITEM_KINDS.map((k) => (
                  <button key={k} type="button" className="mt-opt" aria-pressed={item === k} onClick={() => setItem(k)}>{t(`maintenance.item.${k}`)}</button>
                ))}
              </div>
            </div>
            <div className="mt-field">
              <span className="mt-lbl">{t("maintenance.raise.urgency")}</span>
              <div className="mt-seg" role="group" aria-label={t("maintenance.raise.urgency")}>
                {URGENCIES.map((u) => (
                  <button key={u} type="button" className={`mt-opt u-${u}`} aria-pressed={urgency === u} onClick={() => setUrgency(u)}>
                    <b>{t(`maintenance.urgency.${u}`)}</b><small>{t(`maintenance.urgencyBack.${u}`)}</small>
                  </button>
                ))}
              </div>
            </div>
            <label className="mt-field">
              <span className="mt-lbl">{t("maintenance.raise.note")}</span>
              <textarea className="mt-input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("maintenance.raise.noteHint")} />
            </label>
            <label className="mt-field">
              <span className="mt-lbl">{t("maintenance.raise.tag")}</span>
              <input className="mt-input" maxLength={64} value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t("maintenance.raise.tagHint")} />
            </label>
            {refusal !== null ? <p className="mt-refusal" role="alert">{refusal}</p> : null}
            <button type="submit" className="mt-go" disabled={!ready}>{busy ? t("maintenance.raise.sending") : t("maintenance.raise.send")}</button>
          </form>
        )}
      </section>
    </>
  );
}
