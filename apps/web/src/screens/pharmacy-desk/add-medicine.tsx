import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../../lib/api";
import { useDebounced } from "../../lib/format";
import { addDispenseLine, pharmacyErrorText, searchPaperRxShelf } from "../../lib/pharmacy-api";
import { strengthShown } from "../../../../../packages/contracts/src/drug-strength";
import type { WireDispense, WireRetailShelfEntry } from "../../lib/pharmacy-api";

/**
 * ═══ SPEC #1055, RULING 0094 — "+ ADD A MEDICINE", BY HAND (key A) ═══
 *
 * Owner 2026-11-13: *"allow manual addition of drugs to the list even if the drug is not prescribed by the doctor or
 * doctor has written on paper but is not fed in the system."* The board is `AddMedicine.dc.html`: the counter's shelf
 * searched (the paper-prescription search, `paper-rx/shelf`), one medicine chosen, WHY it is added, the dose and the
 * quantity, and for a paper slip its photo. The owner chose any schedule but X and narcotics for both reasons (0094,
 * which overrules the board's "only medicines with no schedule"). Everything the law or the books refuse is refused
 * by the SERVER (`add-line.ts`) and said here: X / NDPS, an H1 without its prescriber, an allergy, a short shelf.
 */
type Photo = { mimeType: string; imageBase64: string; name: string };
type Reason = "not_prescribed" | "paper";

const SCHEDULED = new Set(["H", "H1"]);

function readPhoto(file: File): Promise<Photo> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ mimeType: file.type || "image/jpeg", imageBase64: url.slice(url.indexOf(",") + 1), name: file.name });
    };
    r.onerror = () => reject(r.error ?? new Error("could not read the photo"));
    r.readAsDataURL(file);
  });
}

const nameOf = (e: WireRetailShelfEntry): string => [e.brandName, strengthShown(e.strengthLabel)].filter((x) => x !== null && x !== "").join(" ");

export function AddMedicineSheet({ dispense, ticketLabel, quick, me, onClose, onDone }: {
  dispense: WireDispense;
  /** "P-4", or the patient's name on a ticket not numbered yet. */
  ticketLabel: string;
  /** Owner ruling 2026-10-02 — quick desk mode: a paper slip's photo is not asked for (0022). */
  quick: boolean;
  /** Who is adding it — the sheet says the line will carry "added at the counter by <name>". */
  me: string;
  onClose: () => void;
  onDone: (d: WireDispense) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const typed = useDebounced(q.trim(), 200);
  const [chosen, setChosen] = useState<WireRetailShelfEntry | null>(null);
  const [reason, setReason] = useState<Reason | null>(null);
  const [dose, setDose] = useState("");
  const [frequency, setFrequency] = useState("");
  const [days, setDays] = useState("");
  const [qty, setQty] = useState("");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [prescriber, setPrescriber] = useState("");
  const [regNo, setRegNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const shelf = useQuery({
    queryKey: ["pharmacy", "paper-rx", "shelf", typed],
    queryFn: () => searchPaperRxShelf(typed),
    enabled: typed.length >= 2 && chosen === null,
    retry: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const flag = chosen?.scheduleFlag ?? null;
  const scheduled = flag !== null && SCHEDULED.has(flag);
  const paper = reason === "paper";
  const needsPhoto = paper && scheduled && !quick;
  const needsPrescriber = paper && flag === "H1";
  const qtyOk = /^\d+$/.test(qty) && Number(qty) > 0;
  const canAdd = !busy && chosen !== null && reason !== null && qtyOk
    && (!needsPhoto || photo !== null) && (!needsPrescriber || (prescriber.trim() !== "" && regNo.trim() !== ""));

  const choose = (e: WireRetailShelfEntry): void => { setChosen(e); setQ(nameOf(e)); setError(null); };
  const save = async (): Promise<void> => {
    if (!canAdd || chosen === null || reason === null) return;
    setBusy(true); setError(null);
    try {
      const d = await addDispenseLine(dispense.id, {
        itemId: chosen.itemId, reason, qtyBase: Number(qty),
        ...(dose.trim() === "" ? {} : { dose: dose.trim() }),
        ...(frequency.trim() === "" ? {} : { frequency: frequency.trim() }),
        ...(/^\d+$/.test(days) && Number(days) > 0 ? { durationDays: Number(days) } : {}),
        ...(paper && photo !== null ? { photo: { mimeType: photo.mimeType, imageBase64: photo.imageBase64 } } : {}),
        ...(paper && (prescriber.trim() !== "" || regNo.trim() !== "")
          ? { prescriber: { name: prescriber.trim() === "" ? null : prescriber.trim(), registrationNo: regNo.trim() === "" ? null : regNo.trim() } } : {}),
      }, key.current);
      onDone(d);
    } catch (e) {
      setError(pharmacyErrorText(e, t));
      key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };
  const title = t("pharmacyDesk.add.title", { ticket: ticketLabel });

  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        className="box pd-add"
        data-testid="add-medicine-sheet"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey) return;
          if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type === "file") return;
          /* ⏎ in the search takes the first match; anywhere else it adds the line. */
          if (chosen === null && (e.target as HTMLElement).id === "add-med-search") {
            const top = shelf.data?.[0];
            if (top !== undefined) { e.preventDefault(); choose(top); }
            return;
          }
          if ((e.target as HTMLElement).tagName === "BUTTON") return;
          e.preventDefault();
          void save();
        }}
      >
        <div className="pd-add-head">
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, flexGrow: 1 }}>{title}</h2>
          <button type="button" className="pill" aria-label={t("pharmacyDesk.close")} onClick={onClose}>✕</button>
        </div>
        <div className="pd-add-body">
          <label htmlFor="add-med-search" className="tag">{t("pharmacyDesk.add.medicine")}</label>
          <input
            id="add-med-search"
            className="in"
            autoFocus
            autoComplete="off"
            value={q}
            onChange={(e) => { setQ(e.target.value); setChosen(null); }}
            placeholder={t("pharmacyDesk.add.search")}
            style={{ marginTop: 6 }}
          />
          {chosen === null && typed.length >= 2 && (shelf.data ?? []).length > 0 ? (
            <div className="box" style={{ marginTop: 6 }} data-testid="add-med-results">
              {(shelf.data ?? []).slice(0, 8).map((s) => (
                <button key={s.itemId} type="button" className="drow" style={{ width: "100%", textAlign: "left" }} onClick={() => choose(s)}>
                  <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 500 }}>{nameOf(s)}</span>
                  {s.scheduleFlag !== null && s.scheduleFlag !== "OTC" ? <span className="pill gd">{t("pharmacyDesk.add.schedule", { flag: s.scheduleFlag })}</span> : null}
                  <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.paperRx.available", { count: s.available })}</span>
                </button>
              ))}
            </div>
          ) : null}
          {chosen === null && typed.length >= 2 && shelf.data !== undefined && shelf.data.length === 0 ? (
            <p role="status" style={{ margin: "6px 0 0 0", fontSize: 12, color: "var(--dim)" }}>{t("pharmacyDesk.add.none")}</p>
          ) : null}
          {chosen === null ? null : (
            <div className="pd-add-chosen" data-testid="add-med-chosen">
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 13.5 }}>{nameOf(chosen)}</strong>
                <span style={{ fontSize: 12, color: "var(--dim)" }}> · {chosen.itemName}</span>
              </span>
              {flag !== null && flag !== "OTC" ? <span className="pill gd">{t("pharmacyDesk.add.schedule", { flag })}</span> : null}
              <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.paperRx.available", { count: chosen.available })}</span>
            </div>
          )}

          <fieldset className="pd-add-why">
            <legend className="tag">{t("pharmacyDesk.add.why")}</legend>
            <div role="radiogroup" aria-label={t("pharmacyDesk.add.why")} className="pd-add-opts">
              {(["not_prescribed", "paper"] as const).map((r) => (
                <button
                  key={r} type="button" role="radio" aria-checked={reason === r} className="pd-add-opt"
                  data-testid={`add-med-${r}`} onClick={() => setReason(r)}
                >
                  <strong>{t(`pharmacyDesk.add.reason.${r}`)}</strong>
                  <span>{t(`pharmacyDesk.add.reasonHint.${r}`)}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="pd-add-grid">
            <label className="pd-add-cell"><span className="tag">{t("pharmacyDesk.paperRx.dose")}</span>
              <input className="in" value={dose} placeholder="1 tab" onChange={(e) => setDose(e.target.value)} />
            </label>
            <label className="pd-add-cell"><span className="tag">{t("pharmacyDesk.paperRx.frequency")}</span>
              <input className="in" value={frequency} placeholder="1-0-1" onChange={(e) => setFrequency(e.target.value)} />
            </label>
            <label className="pd-add-cell narrow"><span className="tag">{t("pharmacyDesk.paperRx.days")}</span>
              <input className="in" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="pd-add-cell"><span className="tag">{t("pharmacyDesk.add.qty")}</span>
              <input
                className="in" inputMode="numeric" aria-label={t("pharmacyDesk.add.qty")} placeholder={chosen?.baseUom ?? ""}
                value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
              />
            </label>
          </div>

          {paper ? (
            <div className="pd-add-paper" data-testid="add-med-paper">
              <div className="paper-rx-photo" style={{ marginTop: 0 }}>
                <span className="tag">{t("pharmacyDesk.add.photo")}</span>
                <label className="sec paper-rx-upload">
                  {t("pharmacyDesk.paperRx.photoButton")}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    capture="environment"
                    aria-label={t("pharmacyDesk.add.photo")}
                    data-testid="add-med-photo"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void readPhoto(f).then(setPhoto, (err: unknown) => setError(String(err))); }}
                  />
                </label>
                <span style={{ fontSize: 11.5, color: needsPhoto && photo === null ? "var(--red)" : "var(--dim)" }} data-testid="add-med-photo-state">
                  {photo !== null ? `${t("pharmacyDesk.paperRx.photoTaken")} · ${photo.name}` : needsPhoto ? t("pharmacyDesk.add.photoRequired") : t("pharmacyDesk.add.photoOptional")}
                </span>
              </div>
              <div className="pd-add-grid" style={{ marginTop: 10 }}>
                <label className="pd-add-cell wide"><span className="tag">{t("pharmacyDesk.add.prescriber")}</span>
                  <input className="in" value={prescriber} onChange={(e) => setPrescriber(e.target.value)} />
                </label>
                <label className="pd-add-cell"><span className="tag">{t("pharmacyDesk.add.regNo")}</span>
                  <input className="in mo" value={regNo} onChange={(e) => setRegNo(e.target.value)} />
                </label>
              </div>
              <p style={{ margin: "6px 0 0 0", fontSize: 11.5, color: needsPrescriber && (prescriber.trim() === "" || regNo.trim() === "") ? "var(--red)" : "var(--dim)" }}>
                {needsPrescriber ? t("pharmacyDesk.add.h1Prescriber") : t("pharmacyDesk.add.prescriberOptional")}
              </p>
            </div>
          ) : null}

          <p className="pd-add-note">{t("pharmacyDesk.add.note", { name: me })}</p>
          {error !== null ? <p role="alert" style={{ margin: "10px 0 0 0", fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
        </div>
        <div className="pd-add-foot">
          <button type="button" className="pri" disabled={!canAdd} onClick={() => void save()} data-testid="add-med-save">
            {busy ? t("pharmacyDesk.add.adding") : t("pharmacyDesk.add.save")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>⏎</span>
          </button>
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyDesk.add.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
