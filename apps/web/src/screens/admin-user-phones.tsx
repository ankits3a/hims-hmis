import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DeskModal } from "../components/desk-modal";
import { SubmitButton } from "../components/submit-button";
import { adminErrorCode, adminErrorMessage, listUserPhones, signOutUserPhone } from "../lib/admin-api";
import type { WireAdminUser, WireUserPhone } from "../lib/admin-api";
import { dayMonthIst, fmtIst } from "../lib/format";
import { todayIst } from "../lib/opd-api";

/**
 * ═══ MOBILE M6a — THE PHONES A PERSON IS SIGNED IN ON (owner 2026-10-06: staff use personal phones) ═══
 *
 * A personal phone gets lost. Before this panel the only ways to end its session were resetting the
 * person's password or deactivating them — both of which also put them out of every counter PC.
 * Here the administrator sees each phone the staff app has signed in on for one person — what the
 * phone says it is, when it was last opened, whether it holds a session NOW — and signs ONE out.
 *
 * What a phone says about itself is text from the phone: it is rendered as text and trusted for
 * nothing. The server decides what "signed in" means and ends the session; this panel only asks.
 */
const when = (iso: string): string => `${dayMonthIst(todayIst(new Date(iso)))}, ${fmtIst(iso)}`;

export function UserPhones({ user, onClose }: { user: WireAdminUser | null; onClose: () => void }): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["admin", "phones", user?.id ?? ""],
    queryFn: () => listUserPhones(user!.id),
    enabled: user !== null,
  });
  const close = (): void => { setNotice(null); setError(null); onClose(); };
  const name = (p: WireUserPhone): string => p.model ?? t("adminUsers.phones.unknownModel");

  const signOut = async (p: WireUserPhone): Promise<void> => {
    if (user === null) return;
    setNotice(null); setError(null);
    try {
      const r = await signOutUserPhone(user.id, p.id);
      setNotice(t(r.sessionsRevoked > 0 ? "adminUsers.phones.signedOutDone" : "adminUsers.phones.nothingToEnd", { model: name(p) }));
    } catch (e) {
      setError(adminErrorCode(e) === "phone_not_found" ? t("adminUsers.phones.phone_not_found") : adminErrorMessage(e));
    }
    await qc.invalidateQueries({ queryKey: ["admin", "phones", user.id] });
  };

  return (
    <DeskModal
      open={user !== null} onClose={close} titleId="admin-phones-title" testId="admin-phones-panel" width={560}
      title={user === null ? "" : t("adminUsers.phones.title", { username: user.username })}
    >
      {user !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("adminUsers.phones.why")}</p>
          {q.isPending && <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>}
          {q.isError && <p role="alert" data-testid="admin-phones-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{adminErrorMessage(q.error)}</p>}
          {q.data !== undefined && q.data.phones.length === 0 && (
            <p data-testid="admin-phones-none" style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("adminUsers.phones.none")}</p>
          )}
          {q.data !== undefined && q.data.phones.map((p) => (
            <div key={p.id} className="box" data-testid={`admin-phone-${p.id}`}
              style={{ padding: "10px 12px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
              <div style={{ flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: "anywhere" }}>{name(p)}</span>
                <span style={{ fontSize: 11.5, color: "var(--dim)", overflowWrap: "anywhere" }}>
                  {[p.osVersion, p.appVersion === null ? null : t("adminUsers.phones.app", { version: p.appVersion })].filter((x): x is string => x !== null).join(" · ")}
                </span>
                {/* The state is a WORD first; the colour only repeats it. */}
                <span data-testid={`admin-phone-state-${p.id}`} style={{ fontSize: 12, fontWeight: 600, color: p.signedIn ? "var(--green)" : "var(--dim)" }}>
                  {p.signedIn && p.signedInSince !== null ? t("adminUsers.phones.signedIn", { when: when(p.signedInSince) }) : t("adminUsers.phones.signedOut")}
                </span>
                <span className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>
                  {t("adminUsers.phones.lastSeen", { when: when(p.lastSeenAt) })} · {t("adminUsers.phones.firstSeen", { when: when(p.firstSeenAt) })}{p.lastIp === null ? "" : ` · ${p.lastIp}`}
                </span>
              </div>
              {p.signedIn && (
                <SubmitButton plain type="button" className="sec" data-testid={`admin-phone-signout-${p.id}`} onClick={() => signOut(p)}>
                  {t("adminUsers.phones.signOut")}
                </SubmitButton>
              )}
            </div>
          ))}
          {q.data !== undefined && <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("adminUsers.phones.limit", { count: q.data.limit })}</p>}
          {notice !== null && <p role="status" data-testid="admin-phones-notice" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--green)" }}>{notice}</p>}
          {error !== null && <p role="alert" data-testid="admin-phones-error" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}
          <div><button type="button" className="sec" onClick={close}>{t("adminUsers.phones.close")}</button></div>
        </div>
      )}
    </DeskModal>
  );
}
