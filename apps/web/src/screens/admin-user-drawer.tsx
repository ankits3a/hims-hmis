import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SubmitButton } from "../components/submit-button";
import { listUserPhones } from "../lib/admin-api";
import { LINK_COLOUR } from "./admin-user-identity";
import { RolePicker } from "./admin-role-picker";
import { areaOf, avatarColour, initials, maskMobile, roleTitle, shortAadhaar } from "./admin-users-model";
import type { WireAdminUser, WireRole, WireUserIdentity, WireUserRole } from "../lib/admin-api";

export const CloseIcon = (): React.ReactElement => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 4l10 10M14 4 4 14" /></svg>
);

/**
 * ═══ ONE PERSON, IN A DRAWER (users board, drawing 1, right) ═══
 *
 * Everything that used to be eight buttons on a table row lives here: the roles (with Remove, the
 * type-ahead and "Copy from another user"), sign-in (password, PIN, phones), and mobile, Aadhaar and
 * the attendance link. The drawer only ASKS: every write is the parent's (`admin-users.tsx`), so the
 * refusal rules — one place, where the eye is — stay in one file.
 *
 * Not a modal: on a desktop the list stays usable beside it. At 900 px and below it is the whole
 * page (`admin-users.css`). Escape closes it when focus is inside it.
 */
export function UserDrawer({
  user, catalogue, assignableScope, identity, users, error,
  onClose, onRevoke, onAssign, onCopy, onReset, onPhones, onIdentity, onDeactivate, onReactivate,
}: {
  user: WireAdminUser;
  /** Undefined when the catalogue is refused (403) or still loading: no assign controls at all. */
  catalogue: readonly WireRole[] | undefined;
  assignableScope: string;
  /** `undefined`: the identity list is not readable; `null`: readable, nothing for this person. */
  identity: WireUserIdentity | null | undefined;
  users: readonly WireAdminUser[];
  /** A refusal that belongs here, because this is where the person is looking. */
  error: string | null;
  onClose: () => void;
  onRevoke: (r: WireUserRole) => Promise<void>;
  onAssign: (role: WireRole) => Promise<void>;
  onCopy: (from: WireAdminUser, keys: string[]) => Promise<void>;
  onReset: (kind: "password" | "pin") => void;
  onPhones: () => void;
  onIdentity: () => void;
  onDeactivate: () => void;
  onReactivate: () => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [copyFrom, setCopyFrom] = useState<string>("");
  const [copying, setCopying] = useState(false);
  // The same cache key the phones panel reads, so opening "Phones" costs no second request.
  const phones = useQuery({ queryKey: ["admin", "phones", user.id], queryFn: () => listUserPhones(user.id), retry: false });
  const signedIn = phones.data?.phones.filter((p) => p.signedIn).length;

  const held = new Set(user.roles.map((r) => r.roleKey));
  const offer = catalogue?.filter((r) => !held.has(r.key)) ?? [];
  const source = users.find((u) => u.id === copyFrom) ?? null;
  const toCopy = source === null ? [] : [...new Set(source.roles.filter((r) => r.scopeType === assignableScope && !held.has(r.roleKey) && catalogue?.some((c) => c.key === r.roleKey) === true).map((r) => r.roleKey))];
  const others = [...users].filter((u) => u.id !== user.id && u.roles.length > 0).sort((a, b) => a.fullName.localeCompare(b.fullName));

  return (
    <aside
      className="au-drawer" data-testid="admin-user-drawer" aria-labelledby="au-drawer-title"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
    >
      <div className="dh">
        <span className="au-av" style={{ background: avatarColour(user.id, user.active) }} aria-hidden="true">{initials(user.fullName)}</span>
        <div className="t">
          <h2 id="au-drawer-title" className="nm" style={{ margin: 0 }}>{user.fullName}</h2>
          <span className="mo" style={{ fontSize: 12.5, color: "var(--dim)" }}>{user.username} · {user.staffCode}</span>
          <span className={user.active ? "au-pill on" : "au-pill off"} data-testid={`admin-drawer-status-${user.username}`} style={{ alignSelf: "flex-start", marginTop: 3 }}>
            {user.active ? t("adminUsers.active") : t("adminUsers.inactive")}
          </span>
        </div>
        <button type="button" className="x" aria-label={t("adminUsers.drawer.close")} data-testid="admin-drawer-close" onClick={onClose}><CloseIcon /></button>
      </div>

      <div className="db">
        <section aria-labelledby="au-roles-h">
          <div className="shrow">
            <h3 id="au-roles-h" className="sh">{t("adminUsers.drawer.rolesN", { n: user.roles.length })}</h3>
            {catalogue !== undefined && others.length > 0 && (
              <button type="button" className="link" data-testid="admin-copy-open" aria-expanded={copying} onClick={() => setCopying((c) => !c)}>{t("adminUsers.drawer.copyFrom")}</button>
            )}
          </div>
          {copying && catalogue !== undefined && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label className="sr-only" htmlFor="au-copy-from">{t("adminUsers.drawer.copyFrom")}</label>
              <select id="au-copy-from" data-testid="admin-copy-from" className="in" style={{ flex: "1 1 200px", minWidth: 0, height: 36, fontSize: 13 }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">{t("adminUsers.drawer.copyPick")}</option>
                {others.map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.username}</option>)}
              </select>
              <SubmitButton plain type="button" className="sec grn sm" data-testid="admin-copy-go" disabled={toCopy.length === 0}
                onClick={async () => { if (source !== null) { await onCopy(source, toCopy); setCopying(false); setCopyFrom(""); } }}>
                {source !== null && toCopy.length === 0 ? t("adminUsers.drawer.copyNone") : t("adminUsers.drawer.copyGo", { n: toCopy.length })}
              </SubmitButton>
            </div>
          )}
          {user.roles.length === 0 && <span className="au-pill norole" style={{ alignSelf: "flex-start" }}>{t("adminUsers.list.noRole")}</span>}
          {user.roles.map((r) => {
            const role = catalogue?.find((c) => c.key === r.roleKey);
            return (
              <div key={r.assignmentId} className="rolecard" data-testid={`admin-role-${r.assignmentId}`}>
                <div className="t">
                  <b>{roleTitle(r.roleKey, catalogue)}</b>
                  <span>
                    {role === undefined ? r.roleKey : `${areaOf(role).toUpperCase()} · ${t("adminUsers.nPermissions", { n: role.permissions.length })}`}
                  </span>
                  {r.scopeType !== "hospital" && (
                    /*
                      AN INERT ASSIGNMENT, SAID ON ITS FACE. `hasPermission` refuses a non-hospital holding
                      against a hospital requirement and every route requires hospital — so this grants
                      nothing. The picker cannot create one (it offers only `assignableScopes`), but the
                      API can and Plan 02 rows may already exist.
                    */
                    <span data-testid={`admin-inert-${r.assignmentId}`} style={{ fontSize: 11, fontWeight: 600, color: "#7a4c08" }}>
                      ({r.scopeType}{r.scopeId !== null && `: ${r.scopeId}`}) {t("adminUsers.inertScope")}
                    </span>
                  )}
                </div>
                <SubmitButton plain type="button" className="sec sm"
                  aria-label={t("adminUsers.revokeRoleFor", { roleKey: r.roleKey, username: user.username })}
                  onClick={() => onRevoke(r)}>
                  {t("adminUsers.drawer.remove")}
                </SubmitButton>
              </div>
            );
          })}
          {catalogue !== undefined && (offer.length === 0
            ? <p className="hint" style={{ margin: 0 }}>{t("adminUsers.allRolesHeld")}</p>
            : <RolePicker roles={offer} onPick={onAssign} testId={`admin-role-search-${user.username}`} warnTestId={`admin-authority-warning-${user.username}`} actLabel={t("adminUsers.assignRole")} />)}
        </section>

        <section aria-labelledby="au-signin-h">
          <h3 id="au-signin-h" className="sh">{t("adminUsers.drawer.signIn")}</h3>
          <div className="two">
            <button type="button" className="sec" onClick={() => onReset("password")}>{t("adminUsers.resetPassword")}</button>
            <button type="button" className="sec" onClick={() => onReset("pin")}>{t("adminUsers.resetPin")}</button>
          </div>
          <button type="button" className="sec wide-btn" data-testid={`admin-phones-${user.username}`} onClick={onPhones}>
            <span>{t("adminUsers.drawer.phones")}</span>
            <span style={{ fontWeight: 500, color: "var(--green)" }}>
              {signedIn === undefined ? "›" : t("adminUsers.drawer.phonesSignedIn", { n: signedIn })}
            </span>
          </button>
        </section>

        <section aria-labelledby="au-id-h">
          <h3 id="au-id-h" className="sh">{t("adminUsers.drawer.idTitle")}</h3>
          {identity !== undefined && (
            <>
              <div className="kv"><span>{t("adminUsers.drawer.mobile")}</span><span className="mo">{maskMobile(identity?.mobile ?? null) ?? "—"}</span></div>
              <div className="kv"><span>{t("adminUsers.drawer.aadhaar")}</span><span className="mo">{shortAadhaar(identity?.aadhaar ?? null) ?? "—"}</span></div>
              <div className="kv">
                <span>{t("adminUsers.drawer.attendance")}</span>
                <span data-testid="admin-drawer-attendance" style={{ fontWeight: 600, color: LINK_COLOUR[identity?.attendance ?? "not_linked"] }}>
                  {t(`adminUsers.identity.state.${identity?.attendance ?? "not_linked"}`)}
                </span>
              </div>
            </>
          )}
          <button type="button" className="link" data-testid={`admin-identity-${user.username}`} onClick={onIdentity}>{t("adminUsers.drawer.editIdentity")}</button>
        </section>

        {error !== null && <p role="alert" data-testid="admin-row-error" className="err">{error}</p>}
      </div>

      <div className="df">
        {user.active ? (
          <button type="button" className="sec danger" data-testid="admin-deactivate" onClick={onDeactivate}>{t("adminUsers.deactivate")}</button>
        ) : (
          <SubmitButton plain type="button" className="sec grn" data-testid="admin-reactivate" onClick={onReactivate}>{t("adminUsers.reactivate")}</SubmitButton>
        )}
      </div>
    </aside>
  );
}
