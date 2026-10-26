import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HK_FAIL_REASONS, cleanRefusal, confirmCleanApi, fetchProof } from "../lib/housekeeping-api";
import type { TaskCard } from "@hmis/contracts";
import "../styles/paper-pine.css";
import "./housekeeping.css";

/*
 * HK-1 (#973) — CONFIRM (design board "Nurse / supervisor · Confirm"): the photo, the checklist with any item answered No,
 * when the place was scanned, then Fail (with a reason, required) or Pass. Pass on a bed frees it for admission. The
 * server refuses the person who did any round of the work and, for a terminal clean, anyone but the supervisor or
 * infection control; its words are shown as they come.
 */
const BED_KINDS = new Set(["bed_clean_routine", "bed_clean_terminal"]);

export function ConfirmSheet({ card, onClose }: { card: TaskCard; onClose: (outcome: string | null) => void }): React.ReactElement {
  const { t } = useTranslation();
  const proof = useQuery({ queryKey: ["housekeeping", "proof", card.id], queryFn: () => fetchProof(card.id) });
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const p = proof.data?.proof ?? null;
  const said = reason === "other" ? other.trim() : reason ?? "";

  const send = (result: "pass" | "fail"): void => {
    if (result === "fail" && said === "") { setRefused(t("housekeeping.confirm.needReason")); return; }
    setBusy(true); setRefused(null);
    confirmCleanApi(card.id, result, result === "fail" ? said : undefined).then(
      () => { setBusy(false); onClose(result === "pass" ? t("housekeeping.confirm.passed") : t("housekeeping.confirm.failed")); },
      (e: unknown) => {
        setBusy(false);
        const r = cleanRefusal(e);
        setRefused(r === null ? t("tasks.refusal.failed") : `${r.message} ${r.fix}`.trim());
      },
    );
  };
  const noItems = p?.answers.filter((a) => !a.ok) ?? [];
  const at = (iso: string): string =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(null); }}>
      <DialogContent className="max-w-[420px]">
        <div className="pp hk-sheet" data-testid="hk-confirm">
          <DialogHeader>
            <DialogTitle>{t("housekeeping.confirm.title", { place: card.placeName ?? card.placeCode ?? "" })}</DialogTitle>
          </DialogHeader>
          {p !== null && (
            <div className="sub">{t("housekeeping.confirm.by", { who: p.doneByName, company: p.company, at: at(p.scannedAt) })}</div>
          )}
          {p?.photo != null && (
            <img src={`data:${p.photo.mimeType};base64,${p.photo.imageBase64}`} alt={t("housekeeping.confirm.photoAlt")} style={{ maxHeight: 200, borderRadius: 12, objectFit: "cover" }} />
          )}
          {p !== null && p.answers.length > 0 && (
            <div className="hk-list" style={{ padding: "10px 14px" }}>
              <b>{t("housekeeping.confirm.checklist", { ok: p.answers.length - noItems.length, total: p.answers.length })}</b>
              {noItems.map((a) => <div key={a.text} className="hk-warn">✕ {a.text}</div>)}
            </div>
          )}
          {p === null && proof.isSuccess && <div className="hk-empty">{t("housekeeping.confirm.noProof")}</div>}
          {p !== null && p.fails > 0 && <div className="hk-warn">{t("housekeeping.confirm.failedBefore", { count: p.fails, reason: p.lastReason ?? "" })}</div>}
          <div className="hk-list" style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            <b>{t("housekeeping.confirm.why")}</b>
            <div className="hk-reasons">
              {HK_FAIL_REASONS.map((r) => (
                <button key={r} type="button" className="hk-reason" aria-pressed={reason === r} onClick={() => setReason(r)}>
                  {t(`housekeeping.reason.${r.replace(/\s+/g, "_").toLowerCase()}`, { defaultValue: r })}
                </button>
              ))}
              <button type="button" className="hk-reason" aria-pressed={reason === "other"} onClick={() => setReason("other")}>{t("housekeeping.reason.other")}</button>
            </div>
            {reason === "other" && (
              <input aria-label={t("housekeeping.confirm.otherReason")} value={other} maxLength={280} onChange={(e) => setOther(e.target.value)} />
            )}
          </div>
          <div className="sub">{t(BED_KINDS.has(card.kind) ? "housekeeping.confirm.bedNote" : "housekeeping.confirm.note")}</div>
          {refused !== null && <p role="alert" className="hk-hint bad">{refused}</p>}
          <div className="hk-pf">
            <button type="button" className="hk-fail" disabled={busy} onClick={() => send("fail")}>{t("housekeeping.confirm.fail")}</button>
            <button type="button" className="hk-primary" disabled={busy} onClick={() => send("pass")}>
              {t(BED_KINDS.has(card.kind) ? "housekeeping.confirm.passBed" : "housekeeping.confirm.pass")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
