import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cleanRefusal, fetchWorkForm, finishWorkApi, uploadWorkPhoto } from "../lib/housekeeping-api";
import { photoBase64, readQrFromFile, tokenFromScan } from "../lib/hk-qr";
import type { TaskCard } from "@hmis/contracts";
import "./housekeeping.css";

/*
 * HK-1 (#973) — THE CHECKLIST (design board "Staff phone · Checklist"): scan the door QR at the place, answer every item
 * Yes or No, take one photo for a bed or a toilet (never a patient), then Done. Done stays disabled and says how many
 * items are left; the server refuses anything incomplete anyway. A task at a place with no area (an older bed clean)
 * has no form: Done is the plain tap.
 */
export function WorkSheet({ card, busy, onTap, onDone, onNotice }: {
  card: TaskCard; busy: boolean; onTap: () => void; onDone: () => void; onNotice: (text: string | null) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const form = useQuery({ queryKey: ["housekeeping", "work-form", card.id], queryFn: () => fetchWorkForm(card.id), staleTime: 60_000 });
  const [scan, setScan] = useState("");
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const f = form.data;

  if (f === undefined) return <span className="tk-empty">{t("tasks.loading")}</span>;
  if (!f.needsWork) {
    return <button type="button" className="tk-act" disabled={busy} onClick={onTap} data-testid="task-done">{t("tasks.act.done")}</button>;
  }
  const left = f.items.filter((i) => answers[i.id] === undefined).length;
  const photoLeft = f.photoNeeded && photoKey === null;
  const ready = scan.trim() !== "" && left === 0 && !photoLeft;
  const refuse = (e: unknown): void => { const r = cleanRefusal(e); onNotice(r === null ? t("tasks.refusal.failed") : `${r.message} ${r.fix}`.trim()); };

  const readQr = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const text = await readQrFromFile(file).catch(() => null);
    if (text === null) { onNotice(t("housekeeping.work.qrUnread")); return; }
    onNotice(null);
    setScan(tokenFromScan(text));
  };
  const takePhoto = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setWorking(true);
    try {
      const p = await photoBase64(file);
      setPhotoKey((await uploadWorkPhoto(card.id, p.mimeType, p.base64)).photoKey);
      onNotice(null);
    } catch (e) { refuse(e); } finally { setWorking(false); }
  };
  const finish = (): void => {
    setWorking(true);
    finishWorkApi(card.id, tokenFromScan(scan), f.items.map((i) => ({ itemId: i.id, ok: answers[i.id]! })), photoKey ?? undefined)
      .then(() => { setWorking(false); onNotice(null); onDone(); }, (e: unknown) => { setWorking(false); refuse(e); });
  };
  const doneLabel = left > 0 ? t("housekeeping.work.itemsLeft", { count: left })
    : photoLeft ? t("housekeeping.work.photoLeft") : scan.trim() === "" ? t("housekeeping.work.scanLeft") : t("tasks.act.done");

  return (
    <div className="hk-sheet" data-testid="hk-work">
      {f.lastReason !== null && <div className="hk-warn">{t("housekeeping.work.rework", { reason: f.lastReason })}</div>}
      <div className="hk-scan">
        <label className="hk-ghost" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {scan === "" ? t("housekeeping.work.scan") : t("housekeeping.work.scanned")}
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void readQr(e.target.files?.[0])} data-testid="hk-scan-photo" />
        </label>
        <input
          aria-label={t("housekeeping.work.code")} value={scan} onChange={(e) => setScan(e.target.value)} autoComplete="off"
          placeholder={t("housekeeping.work.codePlaceholder")} data-testid="hk-scan-code"
        />
      </div>
      {f.items.length > 0 && (
        <div className="hk-list">
          <div className="hk-ck" style={{ borderTop: 0, justifyContent: "space-between" }}>
            <span className="tag">{f.areaName ?? ""}</span>
            <span>{t("housekeeping.work.progress", { done: f.items.length - left, total: f.items.length })}</span>
          </div>
          {f.items.map((i) => (
            <div key={i.id} className="hk-ck">
              <span>{i.text}</span>
              <button type="button" className="hk-yn yes" aria-pressed={answers[i.id] === true} aria-label={t("housekeeping.work.yes", { item: i.text })}
                onClick={() => setAnswers((a) => ({ ...a, [i.id]: true }))}>✓</button>
              <button type="button" className="hk-yn no" aria-pressed={answers[i.id] === false} aria-label={t("housekeeping.work.no", { item: i.text })}
                onClick={() => setAnswers((a) => ({ ...a, [i.id]: false }))}>✕</button>
            </div>
          ))}
        </div>
      )}
      {f.photoNeeded && (
        <label className="hk-ghost" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {photoKey === null ? t("housekeeping.work.photo") : t("housekeeping.work.photoTaken")}
          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void takePhoto(e.target.files?.[0])} data-testid="hk-photo" />
        </label>
      )}
      {f.photoNeeded && <div className="sub">{t("housekeeping.work.noPatient")}</div>}
      <button type="button" className="tk-act" disabled={!ready || busy || working} onClick={finish} data-testid="task-done">{doneLabel}</button>
    </div>
  );
}
