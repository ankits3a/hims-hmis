import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SubmitButton } from "../components/submit-button";
import { roleGroups, shortTitle } from "./admin-users-model";
import type { WireRole } from "../lib/admin-api";

/**
 * ═══ "ADD ROLE" — A TYPE-AHEAD GROUPED BY AREA (users board, drawing 1) ═══
 *
 * Sixty roles do not fit a select a person can read, so this is a search box whose answers are
 * grouped by the area a role works in. The caller decides which roles may be offered (the ones the
 * person does NOT already hold); this component only narrows them by what was typed.
 *
 * A ROLE THAT CARRIES AUTHORITY OVER ACCESS IS NEVER ONE CLICK. `grantsAccessAuthority` is the
 * server's own derivation from `authManifest`; picking such a role ARMS it and shows the warning
 * first, and only the second button acts. Every other role acts on its click, behind
 * `SubmitButton`'s latch, so a double click cannot stack two assignments.
 */
export function RolePicker({
  roles, onPick, testId, warnTestId, actLabel,
}: {
  roles: readonly WireRole[];
  onPick: (role: WireRole) => Promise<void>;
  testId: string;
  /** The warning's testid (the old screen's `admin-authority-warning-<username>`). */
  warnTestId: string;
  /** The armed role's button: "Assign" on a person, "Add" on a new user's list. */
  actLabel: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<WireRole | null>(null);
  const groups = roleGroups(roles, query);
  const shown = open || query.trim() !== "";

  const pick = async (r: WireRole): Promise<void> => {
    await onPick(r);
    setArmed(null);
    setQuery("");
    setOpen(false);
  };

  return (
    <div
      className="au-pick"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      onKeyDown={(e) => { if (e.key === "Escape" && shown) { e.stopPropagation(); setOpen(false); setQuery(""); } }}
    >
      <label className="sr-only" htmlFor={`${testId}-q`}>{t("adminUsers.drawer.addRole")}</label>
      <div className="box-in">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        <input
          id={`${testId}-q`} className="au-bare" data-testid={testId} type="text" autoComplete="off" placeholder={t("adminUsers.drawer.addRole")}
          value={query} onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setArmed(null); }}
          onKeyDown={(e) => {
            // Enter takes the first answer — the fast path for somebody who typed "cash".
            if (e.key !== "Enter") return;
            // Not the form's Enter-advances-a-field (`FormKit`) when this box sits inside one.
            e.preventDefault();
            e.stopPropagation();
            const first = groups[0]?.roles[0];
            if (first === undefined) return;
            if (first.grantsAccessAuthority) setArmed(first); else void pick(first);
          }}
        />
      </div>
      {armed !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p role="status" data-testid={warnTestId} className="warn">
            {shortTitle(armed.title)} — {t("adminUsers.grantsAccessAuthority")}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <SubmitButton plain type="button" className="sec grn sm" data-testid={`${testId}-confirm`} onClick={() => pick(armed)}>{actLabel}</SubmitButton>
            <button type="button" className="sec sm" onClick={() => setArmed(null)}>{t("adminUsers.cancel")}</button>
          </div>
        </div>
      )}
      {shown && armed === null && (
        <div className="menu" data-testid={`${testId}-menu`}>
          {groups.length === 0 && <div className="none">{t("adminUsers.drawer.noRoleMatch")}</div>}
          {groups.map((g) => (
            <div key={g.area} role="group" aria-label={g.area}>
              <div className="grp">{g.area}</div>
              {g.roles.map((r) => {
                const body = (
                  <>
                    <span className="t">{shortTitle(r.title)}</span>
                    <span className="n">{t("adminUsers.nPermissions", { n: r.permissions.length })}</span>
                  </>
                );
                return r.grantsAccessAuthority ? (
                  <button key={r.key} type="button" className="opt" data-testid={`${testId}-opt-${r.key}`} onClick={() => setArmed(r)}>{body}</button>
                ) : (
                  <SubmitButton key={r.key} plain type="button" className="opt" data-testid={`${testId}-opt-${r.key}`} onClick={() => pick(r)}>{body}</SubmitButton>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
