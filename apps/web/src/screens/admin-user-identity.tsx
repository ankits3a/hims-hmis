import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DeskModal } from "../components/desk-modal";
import { SubmitButton } from "../components/submit-button";
import { adminErrorCode, adminErrorMessage, setUserIdentity } from "../lib/admin-api";
import type { AttendanceLinkState, WireAdminUser, WireUserIdentity } from "../lib/admin-api";

/** The state is a WORD first; the colour only repeats it. */
export const LINK_COLOUR: Record<AttendanceLinkState, string> = { linked: "var(--green)", not_linked: "var(--dim)", two_matches: "var(--gold)" };

/**
 * ═══ MOBILE AND AADHAAR (owner 2026-10-09: "Match by mobile or Aadhaar only") ═══
 *
 * The two things the attendance machine's list is matched to a login by. The mobile is shown and
 * edited as it is. The Aadhaar is typed ONCE and is never shown again: the server validates it,
 * keeps a keyed hash and the last four digits, and answers `XXXX XXXX 0124` — so this panel holds
 * the number only while it is in the box, and empties the box the moment it is saved or cancelled.
 *
 * With no linking key on the server an Aadhaar cannot be hashed and so cannot be taken: the box is
 * disabled and one line says why. The mobile works regardless.
 */
export function UserIdentity({ user, identity, aadhaarConfigured, onClose, onChanged }: {
  user: WireAdminUser | null;
  identity: WireUserIdentity | null;
  aadhaarConfigured: boolean;
  onClose: () => void;
  onChanged: (next: WireUserIdentity, said: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [mobile, setMobile] = useState("");
  const [aadhaar, setAadhaar] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different person, or the same person after a save: the boxes start from what the server holds.
  useEffect(() => {
    setMobile(identity?.mobile ?? "");
    setAadhaar("");
    setChanging(false);
    setError(null);
  }, [user?.id, identity?.mobile, identity?.aadhaar]);

  const close = (): void => { setAadhaar(""); setChanging(false); setError(null); onClose(); };

  const refusal = (e: unknown): string => {
    const code = adminErrorCode(e);
    if (code === "mobile_invalid" || code === "aadhaar_invalid" || code === "aadhaar_key_not_configured") return t(`adminUsers.identity.error.${code}`);
    if (code === "user_not_found") return t("adminUsers.error.user_not_found");
    return adminErrorMessage(e);
  };

  const send = async (body: { mobile?: string | null; aadhaar?: string | null }, said: string): Promise<void> => {
    if (user === null) return;
    setError(null);
    try {
      const next = await setUserIdentity(user.id, body);
      setAadhaar("");
      setChanging(false);
      onChanged(next, t(said, { username: user.username }));
    } catch (e) {
      setError(refusal(e));
    }
  };

  const state: AttendanceLinkState = identity?.attendance ?? "not_linked";
  const aadhaarSet = identity?.aadhaar ?? null;
  const typing = aadhaarConfigured && (aadhaarSet === null || changing);
  const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
  const small: React.CSSProperties = { padding: "0 10px", height: 30, fontSize: 11.5 };

  return (
    <DeskModal
      open={user !== null} onClose={close} titleId="admin-identity-title" testId="admin-identity-panel" width={520}
      title={user === null ? "" : t("adminUsers.identity.title", { username: user.username })}
    >
      {user !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("adminUsers.identity.why")}</p>

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label className="tag" htmlFor="identity-mobile">{t("adminUsers.identity.mobile")}</label>
            <div style={row}>
              <input
                id="identity-mobile" data-testid="admin-identity-mobile" className="in mo" inputMode="numeric" autoComplete="off" maxLength={16}
                style={{ flex: "1 1 200px", minWidth: 0, height: 34, fontSize: 13 }}
                value={mobile} onChange={(e) => setMobile(e.target.value)}
              />
              <SubmitButton plain type="button" className="pri" style={small} disabled={mobile.trim() === "" || mobile.trim() === (identity?.mobile ?? "")}
                onClick={() => send({ mobile: mobile.trim() }, "adminUsers.identity.mobileSaved")}>
                {t("adminUsers.identity.save")}
              </SubmitButton>
              {identity?.mobile != null && (
                <SubmitButton plain type="button" className="sec" style={small} data-testid="admin-identity-mobile-remove"
                  onClick={() => send({ mobile: null }, "adminUsers.identity.mobileRemoved")}>
                  {t("adminUsers.identity.remove")}
                </SubmitButton>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--dim)" }}>{t("adminUsers.identity.mobileHint")}</p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <label className="tag" htmlFor="identity-aadhaar">{t("adminUsers.identity.aadhaar")}</label>
            {aadhaarSet !== null && !changing && (
              <div style={row}>
                <span className="mo" data-testid="admin-identity-aadhaar-masked" style={{ flex: "1 1 200px", fontSize: 14, fontWeight: 600, letterSpacing: ".04em" }}>{aadhaarSet}</span>
                <button type="button" className="sec" style={small} disabled={!aadhaarConfigured} data-testid="admin-identity-aadhaar-change"
                  onClick={() => { setError(null); setChanging(true); }}>
                  {t("adminUsers.identity.change")}
                </button>
                <SubmitButton plain type="button" className="sec" style={small} data-testid="admin-identity-aadhaar-remove"
                  onClick={() => send({ aadhaar: null }, "adminUsers.identity.aadhaarRemoved")}>
                  {t("adminUsers.identity.remove")}
                </SubmitButton>
              </div>
            )}
            {(aadhaarSet === null || changing) && (
              <div style={row}>
                <input
                  id="identity-aadhaar" data-testid="admin-identity-aadhaar" className="in mo" inputMode="numeric" maxLength={14}
                  /* Never offered back by the browser, never remembered by it. */
                  autoComplete="off" disabled={!typing} placeholder={typing ? "0000 0000 0000" : ""}
                  style={{ flex: "1 1 200px", minWidth: 0, height: 34, fontSize: 13, opacity: typing ? 1 : 0.55 }}
                  value={aadhaar} onChange={(e) => setAadhaar(e.target.value)}
                />
                <SubmitButton plain type="button" className="pri" style={small} disabled={!typing || aadhaar.trim() === ""}
                  onClick={() => send({ aadhaar: aadhaar.trim() }, "adminUsers.identity.aadhaarSaved")}>
                  {t("adminUsers.identity.save")}
                </SubmitButton>
                {changing && (
                  <button type="button" className="sec" style={small} onClick={() => { setAadhaar(""); setChanging(false); setError(null); }}>
                    {t("adminUsers.identity.cancel")}
                  </button>
                )}
              </div>
            )}
            <p data-testid="admin-identity-aadhaar-hint" style={{ margin: 0, fontSize: 11, color: aadhaarConfigured ? "var(--dim)" : "var(--gold)", fontWeight: aadhaarConfigured ? 400 : 600 }}>
              {t(aadhaarConfigured ? "adminUsers.identity.aadhaarHint" : "adminUsers.identity.aadhaarNotConfigured")}
            </p>
          </div>

          <div className="box" data-testid="admin-identity-state" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: LINK_COLOUR[state] }}>{t(`adminUsers.identity.state.${state}`)}</span>
            <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t(`adminUsers.identity.stateWhy.${state}`)}</span>
          </div>

          {error !== null && (
            <p role="alert" data-testid="admin-identity-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>
          )}
          <div>
            <button type="button" className="sec" onClick={close}>{t("adminUsers.identity.close")}</button>
          </div>
        </div>
      )}
    </DeskModal>
  );
}
