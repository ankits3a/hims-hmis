import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { FormKit, TextField } from "../components/form-kit";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { AgentDock, logged } from "../components/agent-dock";
import type { AgentLine } from "../components/agent-dock";
import { DeskModal } from "../components/desk-modal";
import { SubmitButton } from "../components/submit-button";
import {
  adminErrorCode, adminErrorMessage, assignRole, createUser, deactivateUser, listRoles, listUsers,
  reactivateUser, resetPassword, resetPin, revokeRole,
} from "../lib/admin-api";
import type { WireAdminUser } from "../lib/admin-api";

/**
 * PLAN 11e T6 / D6 — THE USER-ADMINISTRATION DESK.
 *
 * The owner's most-typed new surface, so it is keyboard-first (§15) the way the registration desk
 * is: the create form is a `FormKit`, Enter advances between fields and Alt+S submits.
 *
 * ═══ THE SERVER STAYS AUTHORITATIVE FOR EVERY RULE ═══
 *
 * The `opd-admin.tsx` / `ops-mode.tsx` precedent, and here it matters more than anywhere: this
 * screen mints NO client-side permission check, NO password policy, and NO lockout arithmetic. It
 * renders for whoever opens the route; a caller without `auth.users.manage` gets a 403 and it
 * renders inline like every other refusal. The two refusals worth their own sentence are
 * `admin_lockout` — "this would leave nobody able to administer users" is not a sentence a person
 * should have to infer from a 409 — and `username_taken`.
 *
 * ═══ EVERY WRITE IS A `SubmitButton` (§3.45's convention, applied at 11e CLOSE) ═══
 *
 * The row actions shipped as bare `<button onClick={() => void run(...)}>` — no in-flight guard,
 * so a double click fired two requests. The harm here is smaller than the billing screens that
 * bought this component (a duplicate `user.credential_reset` row, or a confusing 404 after a
 * revoke that already succeeded) but the LESSON §3.45 records is that the shared idiom is what
 * propagates, and it had stopped propagating. `SubmitButton`'s ref latch flips synchronously, so
 * the second click returns before it reaches the network; `disabled` alone would not.
 *
 * The idempotency key it mints is unused by these routes — none of them offers one — and that is
 * stated rather than hidden: what this component buys HERE is the latch, not the key.
 *
 * ═══ WHAT IS DELIBERATELY ABSENT ═══
 *
 * No role CREATION: the vocabulary is code-owned (`seed:roles`), and an HTTP-minted role would be
 * invisible to the model — production's permissionless `owner` role is what that looks like.
 * Governed AUTHORING — draft → approve → activate through the approvals engine — is the owner's
 * ruling of 2026-08-25 and is a later slice.
 *
 * ═══ THE PICKER, AND WHAT THIS PARAGRAPH USED TO SAY ═══
 *
 * It used to read: "Assigning from here needs a role picker fed by a roles list the server does
 * not yet expose — a route this phase deliberately did not add." That sentence was met in
 * production as a bug report — *"I created users but can't assign roles"* — because a screen that
 * can only REVOKE is a screen that can only ever take authority away. `GET /admin/roles`
 * (`RolesCatalogController`) is that route, and this file is its consumer.
 *
 * THREE THINGS THE PICKER REFUSES TO GUESS, all of them read from the server:
 *   - WHICH SCOPES it may offer (`assignableScopes`). Every `@RequirePermission` in the tree
 *     demands `hospital`, and `hasPermission` refuses a department holding against a hospital
 *     requirement — so a "doctor, Paediatrics" option would mint an assignment granting NOTHING
 *     and a person meeting 403 everywhere. The list is the server's measurement, not a constant
 *     here.
 *   - WHAT A ROLE HANDS OVER (`permissions`), shown before the click rather than discovered after.
 *   - WHETHER IT CONFERS AUTHORITY OVER ACCESS (`grantsAccessAuthority`), derived server-side from
 *     `authManifest` so a seventh `auth.*` string is covered on arrival.
 *
 * A 403 ON THE CATALOGUE IS NOT AN ERROR HERE. `auth.users.manage` opens this screen;
 * `auth.roles.manage` opens the picker. A delegate holding only the first sees the roster and no
 * assign control, which is the boundary 11e CLOSE restored, rendering itself.
 */
const createSchema = z.object({
  username: z.string().min(1),
  fullName: z.string().min(1),
  password: z.string().min(1),
  pin: z.string(),
});
type CreateValues = z.infer<typeof createSchema>;

/**
 * One prompt-and-submit action, kept out of the row so the row stays readable.
 *
 * ═══ IT IS A MODAL NOW, AND THAT IS A DEFECT REPORT, NOT A PREFERENCE ═══
 *
 * "Kept out of the row" was rendered literally: the panel was a flat sibling of the table, mounted
 * ABOVE it, above the create form and above two banners. So on a real roster the box opened
 * somewhere the operator was not looking. Measured on this deployment's own `/admin/users` with a
 * browser: clicking "Reset password" on the last of sixteen rows mounted the panel at
 * `getBoundingClientRect().top === -1401` — fourteen hundred pixels above the viewport, focus left
 * on the button, nothing on screen changed. The screen looked broken because it WAS: the whole
 * affordance was off-stage.
 *
 * `DeskModal` answers it in the viewport's centre and brings, for free, everything §6 of this file
 * never had — `role="dialog"`, `aria-modal`, `aria-labelledby`, Escape to dismiss, focus moved into
 * the field on open and returned to the opener on close. It stays a CHILD of `PaperScreen` rather
 * than portalling to `document.body`, which is what keeps `.pp .box` / `.pp .pri` cascading onto it.
 */
type PendingReset = { user: WireAdminUser; kind: "password" | "pin" };

export function AdminUsers(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingReset | null>(null);
  const [resetValue, setResetValue] = useState("");

  const users = useQuery({ queryKey: ["admin", "users"], queryFn: listUsers });
  /**
   * `retry: false` because the expected failure here is a 403 — a delegate holding
   * `auth.users.manage` and not `auth.roles.manage` — and retrying a refusal three times just
   * delays the screen for the person it is correctly refusing.
   */
  const catalogue = useQuery({ queryKey: ["admin", "roles"], queryFn: listRoles, retry: false });
  /** Picked role per user id. Per-row because the control is per-row. */
  const [picked, setPicked] = useState<Record<string, string>>({});

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { username: "", fullName: "", password: "", pin: "" },
  });

  /**
   * BOTH lists. `holders` on the catalogue moves on every assign, revoke, deactivate and
   * reactivate, so refreshing only the roster would leave the picker quoting a stale count — the
   * kind of small lie that makes an operator distrust the screen.
   */
  const refresh = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    await qc.invalidateQueries({ queryKey: ["admin", "roles"] });
  };

  const submitCreate = form.handleSubmit(async (v) => {
    setCreateError(null);
    setNotice(null);
    try {
      await createUser({
        username: v.username.trim(),
        fullName: v.fullName.trim(),
        password: v.password,
        ...(v.pin.trim() === "" ? {} : { pin: v.pin.trim() }),
      });
      setNotice(t("adminUsers.created", { username: v.username.trim() }));
      form.reset({ username: "", fullName: "", password: "", pin: "" });
      await refresh();
    } catch (e) {
      setCreateError(refusal(e));
    }
  });

  /** A named refusal gets its own sentence; anything else falls back to the server's message. */
  const refusal = (e: unknown): string => {
    const code = adminErrorCode(e);
    if (code === "admin_lockout") return t("adminUsers.error.admin_lockout");
    if (code === "username_taken") return t("adminUsers.error.username_taken");
    if (code === "user_not_found") return t("adminUsers.error.user_not_found");
    if (code === "role_not_found") return t("adminUsers.error.role_not_found");
    return adminErrorMessage(e);
  };

  /** Answers whether the write LANDED, because `submitReset` must not close a refused dialog. */
  const run = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setRowError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await refresh();
      return true;
    } catch (e) {
      setRowError(refusal(e));
      return false;
    }
  };

  /**
   * A REFUSAL KEEPS THE DIALOG OPEN, and that is the other half of moving the box into view.
   *
   * `setPending(null)` used to run unconditionally, so a password the server refused — under length,
   * equal to the username, any of `password-policy.ts`'s rules — closed the dialog, discarded what
   * had been typed, and printed the reason on a paragraph the operator had just been scrolled away
   * from. Putting the box where the eye is and then tearing it down at the one moment it has
   * something to say would have fixed the reported half and left the half that matters.
   */
  const submitReset = async (): Promise<void> => {
    if (pending === null) return;
    const { user, kind } = pending;
    const landed = await run(
      () => (kind === "password" ? resetPassword(user.id, resetValue) : resetPin(user.id, resetValue)),
      t(kind === "password" ? "adminUsers.passwordReset" : "adminUsers.pinReset", { username: user.username }),
    );
    if (!landed) return;
    setPending(null);
    setResetValue("");
  };

  /**
   * Opening and closing both wipe the previous outcome, so the dialog never inherits somebody
   * else's refusal — `rowError` is screen-wide state and the dialog renders it while it is open.
   */
  const openReset = (user: WireAdminUser, kind: PendingReset["kind"]): void => {
    setRowError(null);
    setNotice(null);
    setResetValue("");
    setPending({ user, kind });
  };
  const closeReset = (): void => {
    setRowError(null);
    setPending(null);
    setResetValue("");
  };

  const rows = users.data?.users ?? [];
  /** `undefined` while the list is in flight: an unloaded screen must not accuse a deployment. */
  const fullAdmins = users.data?.fullAdministrators;

  /*
    THE CO-PILOT ON AN ACCESS-CONTROL SCREEN READS AND NEVER ACTS. Everything it can say is already
    on the page; what it adds is arithmetic nobody wants to do by eye across thirty rows — how many
    full administrators are left, which accounts hold nothing, which assignments are inert. It has no
    model behind it, and on this screen of all screens that is the feature: an agent that could
    invent a role holding would be inventing a permission.
  */
  const [agentAnswer, setAgentAnswer] = useState<string | null>(null);
  const [agentLog, setAgentLog] = useState<AgentLine[]>([]);
  const agentState = useRef({ rows, fullAdmins });
  agentState.current = { rows, fullAdmins };

  const ask = useCallback((question: string): void => {
    const q = question.toLowerCase();
    const { rows: list, fullAdmins: admins } = agentState.current;
    const answer = ((): string => {
      if (/admin|owner|full/.test(q)) return t("adminUsers.agent.admins", { count: admins ?? 0 });
      if (/inert|scope/.test(q)) {
        const n = list.reduce((acc, u) => acc + u.roles.filter((r) => r.scopeType !== "hospital").length, 0);
        return n === 0 ? t("adminUsers.agent.noInert") : t("adminUsers.agent.inert", { count: n });
      }
      if (/role|permission|access|can do/.test(q)) {
        const none = list.filter((u) => u.roles.length === 0).map((u) => u.username);
        return none.length === 0 ? t("adminUsers.agent.allHaveRoles") : t("adminUsers.agent.noRoles", { list: none.join(", ") });
      }
      if (/how many|count|user|account|active|inactive|list/.test(q)) {
        const active = list.filter((u) => u.active).length;
        return t("adminUsers.agent.counts", { count: list.length, active, inactive: list.length - active });
      }
      return t("adminUsers.agent.cannot");
    })();
    setAgentAnswer(answer);
    setAgentLog((l) => logged(l, question));
  }, [t]);

  return (
    <PaperScreen testId="admin-users" style={{ padding: "18px 22px", gap: 18 }}>
      <ScreenTitle title={t("adminUsers.title")} route="/admin/users" />

      {/*
        PLAN 11f D2 — the takeover rule's mitigation, unmet, said out loud on the one surface that
        can meet it. The COUNT is the server's (`fullAdministrators`, derived from the same helper
        the takeover check reads); this screen renders it and mints no arithmetic of its own — the
        same rule that keeps the password policy off this file.
       */}
      {/*
        `status`, not `alert`: this is a standing condition, not an event. The list refetches after
        every create, reset, deactivate and revoke, and `alert` re-announces assertively on each
        one — interrupting a screen reader mid-row to repeat something that has not changed.
       */}
      {fullAdmins !== undefined && fullAdmins < 2 && (
        <p role="status" data-testid="admin-two-admin-warning" className="box"
          style={{ margin: 0, padding: "12px 14px", fontSize: 12.5, fontWeight: 600, borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}>
          {/* `n`, not `count`: i18next reads `count` as a plural selector and would look for
              `_one`/`_other` variants this catalogue does not carry. */}
          {t("adminUsers.twoAdminWarning", { n: fullAdmins })}
        </p>
      )}

      <section className="box" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "15px 17px" }}>
        <h2 className="tag" style={{ margin: 0 }}>{t("adminUsers.createTitle")}</h2>
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>{t("adminUsers.createWhy")}</p>
        <FormProvider {...form}>
          <FormKit onSubmit={submitCreate}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 13 }}>
            <TextField name="username" label={t("adminUsers.username")} autoFocus />
            <TextField name="fullName" label={t("adminUsers.fullName")} />
            <TextField name="password" label={t("adminUsers.password")} type="password" />
            <TextField name="pin" label={t("adminUsers.pin")} type="password" />
            <p style={{ margin: 0, gridColumn: "1 / -1", fontSize: 11.5, color: "var(--dim)" }}>{t("adminUsers.rule")}</p>
            {createError !== null && (
              <p role="alert" data-testid="admin-create-error" style={{ margin: 0, gridColumn: "1 / -1", fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>
                {createError}
              </p>
            )}
            <div style={{ gridColumn: "1 / -1" }}>
              <button type="submit" className="pri" disabled={form.formState.isSubmitting}>{t("adminUsers.create")}</button>
            </div>
            </div>
          </FormKit>
        </FormProvider>
      </section>

      {/*
        ═══ THE OUTCOME FOLLOWS THE EYE TOO ═══

        These two lines had the reset panel's disease in miniature. Every write on this screen —
        reset, deactivate, reactivate, assign, revoke — is fired from a row, and every one of them
        answered in a paragraph pinned to the TOP of a page that is taller than the viewport. Sixteen
        demo accounts already overflow it; a real deployment's roster is not close. So the operator
        clicked Deactivate on the last row and, as far as they could see, nothing happened.

        Fixed to the bottom edge, above the dock, they are seen wherever the roster has been
        scrolled to. The ROLES are unchanged and are the reason this is not merely decoration:
        `status` for an outcome that completed, `alert` for a refusal that needs reading now.
        `pointerEvents: none` on the rail so a toast can never swallow a click meant for a row;
        the ribbons themselves take pointer events back for selectable text.
      */}
      {(notice !== null || (rowError !== null && pending === null)) && (
        <div style={{
          position: "fixed", left: 0, right: 0, bottom: 60, zIndex: 55, display: "flex",
          flexDirection: "column", alignItems: "center", gap: 6, padding: "0 16px", pointerEvents: "none",
        }}>
          {notice !== null && (
            <p role="status" data-testid="admin-notice" className="box"
              style={{
                margin: 0, padding: "9px 14px", fontSize: 12.5, fontWeight: 600, color: "var(--green)",
                borderColor: "var(--green)", background: "var(--paper)", pointerEvents: "auto",
                boxShadow: "0 10px 30px rgba(19,36,32,.18)",
              }}>
              {notice}
            </p>
          )}
          {/*
            A REFUSAL RENDERS IN EXACTLY ONE PLACE. While the dialog is open it belongs INSIDE it,
            beside the field that caused it; with the dialog closed it belongs on the rail. Rendering
            both would put two live regions carrying one sentence on the page, and a screen reader
            would read the refusal twice.
          */}
          {rowError !== null && pending === null && (
            <p role="alert" data-testid="admin-row-error" className="box"
              style={{
                margin: 0, padding: "9px 14px", fontSize: 12.5, fontWeight: 600, color: "var(--red)",
                borderColor: "var(--red)", background: "var(--paper)", pointerEvents: "auto",
                boxShadow: "0 10px 30px rgba(19,36,32,.18)",
              }}>
              {rowError}
            </p>
          )}
        </div>
      )}

      <DeskModal
        open={pending !== null}
        onClose={closeReset}
        titleId="admin-reset-title"
        testId="admin-reset-panel"
        width={480}
        title={pending === null ? "" : t(
          pending.kind === "password" ? "adminUsers.resetPasswordFor" : "adminUsers.resetPinFor",
          { username: pending.user.username },
        )}
      >
        {pending !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 11.5, color: "var(--dim)" }}>
              {t(pending.kind === "password" ? "adminUsers.resetPasswordWhy" : "adminUsers.resetPinWhy")}
            </p>
            <label className="tag" style={{ display: "block" }} htmlFor="reset-value">
              {t(pending.kind === "password" ? "adminUsers.password" : "adminUsers.pin")}
            </label>
            <input
              id="reset-value"
              type="password"
              /*
                A fresh secret, never the operator's own. Without this a browser offers to fill the
                ADMINISTRATOR's saved password into the box that sets somebody else's.
              */
              autoComplete="new-password"
              className="in mo" style={{ width: "100%", height: 34, fontSize: 13 }}
              value={resetValue}
              onChange={(e) => setResetValue(e.target.value)}
              /* Enter is what a person types after a password. Escape is `DeskModal`'s. */
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitReset(); } }}
            />
            {rowError !== null && (
              <p role="alert" data-testid="admin-row-error"
                style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>
                {rowError}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <SubmitButton plain type="button" className="pri" onClick={submitReset}>{t("adminUsers.confirmReset")}</SubmitButton>
              <button
                type="button"
                className="sec"
                onClick={closeReset}
              >
                {t("adminUsers.cancel")}
              </button>
            </div>
          </div>
        )}
      </DeskModal>

      <section style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <h2 className="tag" style={{ margin: 0 }}>{t("adminUsers.listTitle")}</h2>
        {users.data === undefined ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("app.loading")}</p>
        ) : rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("adminUsers.empty")}</p>
        ) : (
          <div className="box" style={{ padding: "4px 15px 10px", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {[t("adminUsers.staffCode"), t("adminUsers.username"), t("adminUsers.fullName"), t("adminUsers.status"), t("adminUsers.roles"), t("adminUsers.actions")].map((h) => (
                  <th key={h} className="tag" style={{ textAlign: "left", padding: "10px 14px 7px 0", borderBottom: "1px solid var(--line)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} style={{ verticalAlign: "top" }} data-testid={`admin-user-${u.username}`}>
                  <td className="mo" data-testid={`admin-staff-code-${u.username}`} style={{ padding: "9px 14px 9px 0", borderBottom: "1px solid var(--line)" }}>{u.staffCode}</td>
                  <td className="mo" style={{ padding: "9px 14px 9px 0", borderBottom: "1px solid var(--line)", fontWeight: 600 }}>{u.username}</td>
                  <td style={{ padding: "9px 14px 9px 0", borderBottom: "1px solid var(--line)" }}>{u.fullName}</td>
                  <td data-testid={`admin-status-${u.username}`} style={{ padding: "9px 14px 9px 0", borderBottom: "1px solid var(--line)", color: u.active ? "var(--ink)" : "var(--dim)" }}>
                    {u.active ? t("adminUsers.active") : t("adminUsers.inactive")}
                    {u.hasPin && <> · {t("adminUsers.hasPin")}</>}
                    {u.mustChangePassword && <> · {t("adminUsers.mustChange")}</>}
                  </td>
                  <td style={{ minWidth: 260, padding: "9px 14px 9px 0", borderBottom: "1px solid var(--line)" }}>
                    {u.roles.length === 0 ? (
                      <span style={{ color: "var(--dim)" }}>{t("adminUsers.noRoles")}</span>
                    ) : (
                      /*
                        THE ROLES WRAP, and that is a readability fix a screenshot forced rather
                        than a preference. This deployment's `admin` account holds THIRTY roles, and
                        one per line made a single table row taller than the viewport — the account
                        most likely to need auditing was the one hardest to read. Wrapped chips put
                        the same thirty in four lines, and each keeps its own revoke.
                      */
                      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {u.roles.map((r) => (
                          <li key={r.assignmentId} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 4px 2px 8px", border: "1px solid var(--line)", borderRadius: 4, background: "var(--wash)" }}>
                            <span className="mo" style={{ fontSize: 11 }}>{r.roleKey}</span>
                            {r.scopeType !== "hospital" && (
                              /*
                                AN INERT ASSIGNMENT, SAID ON ITS FACE. `hasPermission` refuses a
                                non-hospital holding against a hospital requirement and every route
                                in the tree requires hospital — so this row grants its holder
                                nothing at all. The picker cannot create one (it offers only
                                `assignableScopes`), but the API can and Plan 02 rows may already
                                exist, and a person meeting 403 everywhere while the screen shows
                                them holding a role is the worst version of this bug.
                               */
                              <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 600, color: "var(--gold)" }} data-testid={`admin-inert-${r.assignmentId}`}>
                                ({r.scopeType}{r.scopeId !== null && `: ${r.scopeId}`}) {t("adminUsers.inertScope")}
                              </span>
                            )}
                            <SubmitButton
                              plain
                              type="button"
                              className="sec"
                              aria-label={t("adminUsers.revokeRoleFor", { roleKey: r.roleKey, username: u.username })}
                              style={{ padding: "0 6px", height: 19, fontSize: 10 }}
                              onClick={async () => { await run(
                                () => revokeRole(u.id, r.assignmentId),
                                t("adminUsers.roleRevoked", { roleKey: r.roleKey, username: u.username }),
                              ); }}
                            >
                              {t("adminUsers.revokeRole")}
                            </SubmitButton>
                          </li>
                        ))}
                      </ul>
                    )}
                    {catalogue.data !== undefined && (() => {
                      /*
                        Roles this person does not already hold. `assignRole` mints a fresh id per
                        call and refuses nothing, so an unfiltered list would let a double-click
                        pattern stack duplicate rows that each need their own revoke.
                       */
                      const held = new Set(u.roles.map((r) => r.roleKey));
                      const options = catalogue.data.roles.filter((r) => !held.has(r.key));
                      const chosen = picked[u.id] ?? "";
                      const scope = catalogue.data.assignableScopes[0] ?? "hospital";
                      const warns = options.find((r) => r.key === chosen)?.grantsAccessAuthority === true;
                      if (options.length === 0) {
                        return <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--dim)" }}>{t("adminUsers.allRolesHeld")}</p>;
                      }
                      return (
                        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 5 }}>
                          <label className="sr-only" htmlFor={`assign-${u.id}`}>
                            {t("adminUsers.assignRoleFor", { username: u.username })}
                          </label>
                          <select
                            id={`assign-${u.id}`}
                            data-testid={`admin-role-select-${u.username}`}
                            className="in" style={{ width: "100%", height: 28, fontSize: 11.5 }}
                            value={chosen}
                            onChange={(e) => setPicked((p) => ({ ...p, [u.id]: e.target.value }))}
                          >
                            <option value="">{t("adminUsers.pickRole")}</option>
                            {options.map((r) => (
                              <option key={r.key} value={r.key}>
                                {r.key} — {r.title} ({t("adminUsers.nPermissions", { n: r.permissions.length })})
                              </option>
                            ))}
                          </select>
                          {warns && (
                            <p role="status" data-testid={`admin-authority-warning-${u.username}`}
                              style={{ margin: 0, fontSize: 11, fontWeight: 600, color: "var(--gold)" }}>
                              {t("adminUsers.grantsAccessAuthority")}
                            </p>
                          )}
                          <SubmitButton
                            plain
                            type="button"
                            className="sec grn"
                            style={{ alignSelf: "flex-start", padding: "0 10px", height: 26, fontSize: 11 }}
                            disabled={chosen === ""}
                            onClick={async () => { await run(
                              async () => {
                                await assignRole(u.id, { roleKey: chosen, scopeType: scope as "hospital" });
                                setPicked((p) => ({ ...p, [u.id]: "" }));
                              },
                              t("adminUsers.roleAssigned", { roleKey: chosen, username: u.username }),
                            ); }}
                          >
                            {t("adminUsers.assignRole")}
                          </SubmitButton>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ whiteSpace: "nowrap", padding: "9px 0", borderBottom: "1px solid var(--line)" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    <button
                      type="button"
                      className="sec" style={{ padding: "0 8px", height: 24, fontSize: 10.5 }}
                      onClick={() => openReset(u, "password")}
                    >
                      {t("adminUsers.resetPassword")}
                    </button>
                    <button
                      type="button"
                      className="sec" style={{ padding: "0 8px", height: 24, fontSize: 10.5 }}
                      onClick={() => openReset(u, "pin")}
                    >
                      {t("adminUsers.resetPin")}
                    </button>
                    {u.active ? (
                      <SubmitButton
                        plain
                        type="button"
                        className="sec"
                        style={{ padding: "0 8px", height: 24, fontSize: 10.5 }}
                        onClick={async () => { await run(
                          () => deactivateUser(u.id),
                          t("adminUsers.deactivated", { username: u.username }),
                        ); }}
                      >
                        {t("adminUsers.deactivate")}
                      </SubmitButton>
                    ) : (
                      <SubmitButton
                        plain
                        type="button"
                        className="sec"
                        style={{ padding: "0 8px", height: 24, fontSize: 10.5 }}
                        onClick={async () => { await run(
                          () => reactivateUser(u.id),
                          t("adminUsers.reactivated", { username: u.username }),
                        ); }}
                      >
                        {t("adminUsers.reactivate")}
                      </SubmitButton>
                    )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <AgentDock
        answer={agentAnswer} log={agentLog} onAsk={ask}
        placeholder={t("adminUsers.askPlaceholder")} idle={t("adminUsers.agentIdle")}
      />
    </PaperScreen>
  );
}
