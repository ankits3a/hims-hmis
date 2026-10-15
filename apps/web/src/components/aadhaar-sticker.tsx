import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { aadhaarTyped, savedNotice, selfRefusal } from "../../../../packages/contracts/src/self-identity";
import { DeskModal } from "./desk-modal";
import { SubmitButton } from "./submit-button";
import { useAuth } from "../lib/auth";
import { adminErrorCode, getMyIdentity, saveMyAadhaar } from "../lib/admin-api";

export const MY_IDENTITY_KEY = ["me", "identity"] as const;

/**
 * ═══ "ADD YOUR AADHAAR" — THE STICKER (owner 2026-10-09) ═══
 *
 * "When the user logs in, a sticker on top of the window/screen will be there till the Aadhar number
 * is input and saved by the user. If it matches with the data from attendance API then good."
 *
 * A slim strip at the top of every signed-in screen while the server says `needsAadhaar` (the key is
 * set up, this person has saved none, is a person and not a machine, and is not already linked). It
 * cannot be dismissed — it goes when the number is saved. The number lives only in the box while it
 * is typed: it is never logged, never kept in state after the save, and the server answers masked.
 *
 * After a save one line says what happened: "Attendance linked", or "Saved · attendance team will
 * match" when the machine's list has no such number yet (or two people gave it).
 */
export function AadhaarSticker(): React.ReactElement | null {
  const { t } = useTranslation();
  const { actor } = useAuth();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: MY_IDENTITY_KEY, queryFn: getMyIdentity, enabled: actor !== null && actor.type === "user", retry: false, staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const close = (): void => { setOpen(false); setValue(""); setError(null); };
  const save = async (): Promise<void> => {
    setError(null);
    try {
      const next = await saveMyAadhaar(value);
      setValue("");
      setOpen(false);
      qc.setQueryData(MY_IDENTITY_KEY, next);
      setSaid(t(`aadhaarSticker.${savedNotice(next.attendance)}`));
      // Whatever reads attendance refreshes: the person may be linked now.
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    } catch (e) {
      // The refusal is a CODE mapped to a fixed line; nothing the server said is echoed.
      setError(t(`aadhaarSticker.error.${selfRefusal(adminErrorCode(e))}`));
    }
  };

  if (actor === null) return null;
  if (said !== null && me.data?.needsAadhaar !== true) {
    return (
      <div className="pp no-print" data-testid="aadhaar-saved" role="status"
        style={{ minHeight: 0, display: "flex", alignItems: "center", gap: 10, padding: "6px 16px", background: "var(--green-soft)", borderBottom: "1px solid var(--green-line)", fontSize: 13, fontWeight: 600, color: "var(--green)" }}>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{said}</span>
        <button type="button" className="sec" style={{ height: 28, padding: "0 10px", fontSize: 12 }} aria-label={t("adminUsers.drawer.close")} onClick={() => setSaid(null)}>×</button>
      </div>
    );
  }
  if (me.data?.needsAadhaar !== true) return null;

  return (
    <>
      <div className="pp no-print" data-testid="aadhaar-sticker" role="region" aria-label={t("aadhaarSticker.text")}
        style={{ minHeight: 0, display: "flex", alignItems: "center", gap: 10, padding: "6px 16px", background: "var(--gold-soft)", borderBottom: "1px solid var(--gold-line)" }}>
        {/* One line at 390 px; on a narrower phone it wraps rather than losing its last word. */}
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.3, fontWeight: 600, color: "#7a4c08" }}>
          {t("aadhaarSticker.text")}
        </span>
        <button type="button" className="pri" data-testid="aadhaar-sticker-open" style={{ height: 32, padding: "0 14px", fontSize: 12.5, flexShrink: 0 }} onClick={() => { setError(null); setOpen(true); }}>
          {t("aadhaarSticker.button")}
        </button>
      </div>
      {open && (
        <div className="pp" style={{ minHeight: 0 }}>
          <DeskModal open onClose={close} titleId="aadhaar-sticker-title" testId="aadhaar-sticker-panel" width={400} centred title={t("aadhaarSticker.title")}>
            <form style={{ display: "flex", flexDirection: "column", gap: 8 }} onSubmit={(e) => { e.preventDefault(); }}>
              <label className="tag" htmlFor="aadhaar-self">{t("aadhaarSticker.label")}</label>
              <input id="aadhaar-self" data-testid="aadhaar-self-input" className="in mo" inputMode="numeric" autoComplete="off" maxLength={14}
                placeholder="0000 0000 0000" style={{ fontSize: 16, letterSpacing: ".04em" }}
                value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d\s-]/g, ""))} />
              <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("aadhaarSticker.hint")}</span>
              {error !== null && <p role="alert" data-testid="aadhaar-self-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <SubmitButton plain type="button" className="pri" data-testid="aadhaar-self-save" disabled={!aadhaarTyped(value)} onClick={save}>{t("aadhaarSticker.save")}</SubmitButton>
                <button type="button" className="sec" style={{ height: 40 }} onClick={close}>{t("aadhaarSticker.cancel")}</button>
              </div>
            </form>
          </DeskModal>
        </div>
      )}
    </>
  );
}
