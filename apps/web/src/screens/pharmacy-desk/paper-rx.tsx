import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../../lib/api";
import { useDebounced } from "../../lib/format";
import { enterPaperRx, fetchPaperRxContext, pharmacyErrorText, searchPaperRxShelf } from "../../lib/pharmacy-api";
import { istToday } from "./work";
import type { WireDispense, WireRetailShelfEntry } from "../../lib/pharmacy-api";
import "./paper-rx.css";

/**
 * ═══ 2026-09-30 — DISPENSE FROM A PAPER PRESCRIPTION (the owner at the live counter) ═══
 *
 * A registered patient at the window with a hospital doctor's PAPER prescription and no
 * e-prescription. The desk found them (`no_prescription_today`) and offered this door. ONE sheet:
 * the doctor written on the paper, its date, the photo (required when a line is Schedule H/H1), and
 * the medicines off the OPD shelf with the quantity counted. Save makes an ordinary ticket, claimed by
 * this pharmacist, and the desk opens it — verify, pick, bill, hand over are the desk's own.
 *
 * Everything the law or the clinic refuses is refused by the SERVER (`paper-rx.ts`), and said here in
 * the pharmacist's words: X/NDPS, an H1 without the prescriber's registration, an allergy.
 */
type Line = { entry: WireRetailShelfEntry; qty: string; dose: string; frequency: string; days: string };
type Photo = { mimeType: string; imageBase64: string; name: string };

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

export function PaperRxSheet({ patient, onClose, onDone }: {
  patient: { id: string; uhid: string; label: string };
  onClose: () => void;
  onDone: (d: WireDispense) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const today = istToday();
  const [rxDate, setRxDate] = useState(today);
  const [doctorId, setDoctorId] = useState<string>("");
  const [lines, setLines] = useState<Line[]>([]);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [q, setQ] = useState("");
  const typed = useDebounced(q.trim(), 200);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());

  const ctx = useQuery({
    queryKey: ["pharmacy", "paper-rx", "context", patient.id, rxDate],
    queryFn: () => fetchPaperRxContext(patient.id, rxDate),
    enabled: rxDate !== "" && rxDate <= today,
    retry: false,
  });
  const shelf = useQuery({
    queryKey: ["pharmacy", "paper-rx", "shelf", typed],
    queryFn: () => searchPaperRxShelf(typed),
    enabled: typed.length >= 2,
    retry: false,
  });
  /* The visit the paper attaches to: the doctor's own that day, else the last free one — the server's rule. */
  const free = (ctx.data?.visits ?? []).filter((v) => !v.hasPrescription);
  const visit = free.find((v) => v.doctorId === doctorId) ?? free[free.length - 1];
  useEffect(() => {
    if (doctorId === "" && visit?.doctorId != null) setDoctorId(visit.doctorId);
  }, [doctorId, visit?.doctorId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const needsPhoto = lines.some((l) => l.entry.scheduleFlag !== null && SCHEDULED.has(l.entry.scheduleFlag));
  const qtyOk = lines.every((l) => /^\d+$/.test(l.qty) && Number(l.qty) > 0);
  const canSave = !busy && lines.length > 0 && qtyOk && doctorId !== "" && visit !== undefined && (!needsPhoto || photo !== null);

  const add = (entry: WireRetailShelfEntry): void => {
    setLines((ls) => (ls.some((l) => l.entry.itemId === entry.itemId) ? ls : [...ls, { entry, qty: "", dose: "", frequency: "", days: "" }]));
    setQ("");
  };
  const edit = (i: number, patch: Partial<Line>): void => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      const d = await enterPaperRx({
        patientId: patient.id, doctorId, rxDate,
        ...(photo === null ? {} : { photo: { mimeType: photo.mimeType, imageBase64: photo.imageBase64 } }),
        lines: lines.map((l) => ({
          itemId: l.entry.itemId, qtyBase: Number(l.qty),
          ...(l.dose.trim() === "" ? {} : { dose: l.dose.trim() }),
          ...(l.frequency.trim() === "" ? {} : { frequency: l.frequency.trim() }),
          ...(/^\d+$/.test(l.days) && Number(l.days) > 0 ? { durationDays: Number(l.days) } : {}),
        })),
      }, key.current);
      onDone(d);
    } catch (e) {
      setError(pharmacyErrorText(e, t));
      key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ovl" role="dialog" aria-modal="true" aria-label={t("pharmacyDesk.paperRx.title")} onClick={onClose}>
      <div
        className="box paper-rx"
        data-testid="paper-rx-sheet"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }}
      >
        <div className="paper-rx-head">
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flexGrow: 1 }}>{t("pharmacyDesk.paperRx.title")}</h2>
          <span className="pill" data-testid="paper-rx-patient">{patient.label} · <span className="mo">{patient.uhid}</span></span>
          <button type="button" className="pill" onClick={onClose}>{t("pharmacyDesk.close")} <span className="kb">Esc</span></button>
        </div>
        <div className="paper-rx-body">
          <p style={{ margin: "0 0 14px 0", fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.paperRx.sub")}</p>

          <div className="paper-rx-grid">
            <label className="paper-rx-field">
              <span className="tag">{t("pharmacyDesk.paperRx.prescriber")}</span>
              <select className="in" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} data-testid="paper-rx-doctor">
                <option value="">{t("pharmacyDesk.paperRx.chooseDoctor")}</option>
                {(ctx.data?.doctors ?? []).map((d) => (
                  <option key={d.id} value={d.id}>{d.displayName}{d.registrationNo === null ? "" : ` · ${d.registrationNo}`}</option>
                ))}
              </select>
              <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.paperRx.prescriberHint")}</span>
            </label>
            <label className="paper-rx-field">
              <span className="tag">{t("pharmacyDesk.paperRx.rxDate")}</span>
              <input className="in" type="date" max={today} value={rxDate} onChange={(e) => setRxDate(e.target.value)} data-testid="paper-rx-date" />
              <span style={{ fontSize: 11.5, color: visit === undefined && ctx.data !== undefined ? "var(--red)" : "var(--dim)" }} data-testid="paper-rx-visit">
                {ctx.data === undefined ? " " : visit === undefined ? t("pharmacyDesk.paperRx.noVisit") : t("pharmacyDesk.paperRx.visit", { visitNo: visit.visitNo })}
              </span>
            </label>
          </div>

          <div className="paper-rx-photo">
            <span className="tag">{t("pharmacyDesk.paperRx.photo")}</span>
            <label className="sec paper-rx-upload">
              {t("pharmacyDesk.paperRx.photoButton")}
              <input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                capture="environment"
                data-testid="paper-rx-photo"
                onChange={(e) => { const f = e.target.files?.[0]; if (f !== undefined) void readPhoto(f).then(setPhoto, (err: unknown) => setError(String(err))); }}
              />
            </label>
            <span style={{ fontSize: 11.5, color: needsPhoto && photo === null ? "var(--red)" : "var(--dim)" }} data-testid="paper-rx-photo-state">
              {photo !== null ? `${t("pharmacyDesk.paperRx.photoTaken")} · ${photo.name}` : needsPhoto ? t("pharmacyDesk.paperRx.photoRequired") : t("pharmacyDesk.paperRx.photoOptional")}
            </span>
          </div>

          <label htmlFor="paper-rx-search" className="tag" style={{ display: "block", marginTop: 16 }}>{t("pharmacyDesk.paperRx.medicine")}</label>
          <input
            id="paper-rx-search"
            className="in"
            autoFocus
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey && shelf.data?.[0] !== undefined) { e.preventDefault(); add(shelf.data[0]); } }}
            placeholder={t("pharmacyDesk.paperRx.search")}
            style={{ marginTop: 6, width: "100%" }}
          />
          {typed.length >= 2 && (shelf.data ?? []).length > 0 ? (
            <div className="box" style={{ marginTop: 6 }} data-testid="paper-rx-results">
              {(shelf.data ?? []).slice(0, 8).map((s) => (
                <button key={s.itemId} type="button" className="drow" style={{ width: "100%", textAlign: "left" }} onClick={() => add(s)}>
                  <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 500 }}>{s.brandName}{s.strengthLabel === null ? "" : ` ${s.strengthLabel}`}</span>
                  {s.scheduleFlag !== null && s.scheduleFlag !== "OTC" ? <span className="pill gd">{s.scheduleFlag}</span> : null}
                  <span className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("pharmacyDesk.paperRx.available", { count: s.available })}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div style={{ marginTop: 14 }} data-testid="paper-rx-lines">
            {lines.length === 0 ? <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("pharmacyDesk.paperRx.noLines")}</p> : null}
            {lines.map((l, i) => (
              <div key={l.entry.itemId} className="paper-rx-line">
                <div className="paper-rx-drug">
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{l.entry.brandName}{l.entry.strengthLabel === null ? "" : ` ${l.entry.strengthLabel}`}</span>
                  {l.entry.scheduleFlag !== null && l.entry.scheduleFlag !== "OTC" ? <span className="pill gd" style={{ marginLeft: 6 }}>{l.entry.scheduleFlag}</span> : null}
                </div>
                <label className="paper-rx-cell"><span className="tag">{t("pharmacyDesk.paperRx.qty")}</span>
                  <input className="in" inputMode="numeric" placeholder={l.entry.baseUom} aria-label={`${t("pharmacyDesk.paperRx.qty")} ${l.entry.brandName}`} value={l.qty} onChange={(e) => edit(i, { qty: e.target.value.replace(/\D/g, "") })} />
                </label>
                <label className="paper-rx-cell"><span className="tag">{t("pharmacyDesk.paperRx.dose")}</span>
                  <input className="in" value={l.dose} placeholder="1 tab" onChange={(e) => edit(i, { dose: e.target.value })} />
                </label>
                <label className="paper-rx-cell"><span className="tag">{t("pharmacyDesk.paperRx.frequency")}</span>
                  <input className="in" value={l.frequency} placeholder="1-0-1" onChange={(e) => edit(i, { frequency: e.target.value })} />
                </label>
                <label className="paper-rx-cell narrow"><span className="tag">{t("pharmacyDesk.paperRx.days")}</span>
                  <input className="in" inputMode="numeric" value={l.days} onChange={(e) => edit(i, { days: e.target.value.replace(/\D/g, "") })} />
                </label>
                <button type="button" className="pill" aria-label={`${t("pharmacyDesk.paperRx.remove")} ${l.entry.brandName}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>


          {error !== null ? <p role="alert" style={{ margin: "12px 0 0 0", fontSize: 12.5, color: "var(--red)" }}>{error}</p> : null}
        </div>
        <div className="paper-rx-foot">
          <a href="/pharmacy/retail" style={{ fontSize: 12, color: "var(--dim)", marginRight: "auto" }}>{t("pharmacyDesk.paperRx.walkIn")}</a>
          <button type="button" className="sec" onClick={onClose}>{t("pharmacyDesk.paperRx.cancel")}</button>
          <button type="button" className="pri" disabled={!canSave} onClick={() => void save()} data-testid="paper-rx-save">
            {busy ? t("pharmacyDesk.paperRx.saving") : t("pharmacyDesk.paperRx.save")} <span className="kb" style={{ borderColor: "rgba(255,255,255,.35)", background: "rgba(255,255,255,.12)", color: "#d6ece1" }}>Ctrl ⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
}
