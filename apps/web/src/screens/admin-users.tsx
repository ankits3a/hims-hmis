import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { FormKit, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";
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

/** One prompt-and-submit action, kept out of the row so the row stays readable. */
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

  const run = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setRowError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await refresh();
    } catch (e) {
      setRowError(refusal(e));
    }
  };

  const submitReset = async (): Promise<void> => {
    if (pending === null) return;
    const { user, kind } = pending;
    await run(
      () => (kind === "password" ? resetPassword(user.id, resetValue) : resetPin(user.id, resetValue)),
      t(kind === "password" ? "adminUsers.passwordReset" : "adminUsers.pinReset", { username: user.username }),
    );
    setPending(null);
    setResetValue("");
  };

  const rows = users.data?.users ?? [];
  /** `undefined` while the list is in flight: an unloaded screen must not accuse a deployment. */
  const fullAdmins = users.data?.fullAdministrators;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t("adminUsers.title")}</h1>

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
        <p role="status" data-testid="admin-two-admin-warning"
          className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
          {/* `n`, not `count`: i18next reads `count` as a plural selector and would look for
              `_one`/`_other` variants this catalogue does not carry. */}
          {t("adminUsers.twoAdminWarning", { n: fullAdmins })}
        </p>
      )}

      <section className="space-y-3 rounded border p-4">
        <h2 className="text-sm font-semibold">{t("adminUsers.createTitle")}</h2>
        <p className="text-xs text-neutral-500">{t("adminUsers.createWhy")}</p>
        <FormProvider {...form}>
          <FormKit onSubmit={submitCreate} className="grid gap-3 md:grid-cols-2">
            <TextField name="username" label={t("adminUsers.username")} autoFocus />
            <TextField name="fullName" label={t("adminUsers.fullName")} />
            <TextField name="password" label={t("adminUsers.password")} type="password" />
            <TextField name="pin" label={t("adminUsers.pin")} type="password" />
            <p className="text-xs text-neutral-500 md:col-span-2">{t("adminUsers.rule")}</p>
            {createError !== null && (
              <p role="alert" data-testid="admin-create-error" className="text-sm text-red-600 md:col-span-2">
                {createError}
              </p>
            )}
            <div className="md:col-span-2">
              <Button type="submit" disabled={form.formState.isSubmitting}>{t("adminUsers.create")}</Button>
            </div>
          </FormKit>
        </FormProvider>
      </section>

      {notice !== null && (
        <p role="status" data-testid="admin-notice" className="text-sm text-green-700">{notice}</p>
      )}
      {rowError !== null && (
        <p role="alert" data-testid="admin-row-error" className="text-sm text-red-600">{rowError}</p>
      )}

      {pending !== null && (
        <section className="space-y-2 rounded border border-amber-400 p-4" data-testid="admin-reset-panel">
          <h2 className="text-sm font-semibold">
            {t(pending.kind === "password" ? "adminUsers.resetPasswordFor" : "adminUsers.resetPinFor", {
              username: pending.user.username,
            })}
          </h2>
          <p className="text-xs text-neutral-500">
            {t(pending.kind === "password" ? "adminUsers.resetPasswordWhy" : "adminUsers.resetPinWhy")}
          </p>
          <label className="block text-sm font-medium" htmlFor="reset-value">
            {t(pending.kind === "password" ? "adminUsers.password" : "adminUsers.pin")}
          </label>
          <input
            id="reset-value"
            type="password"
            className="w-64 rounded border px-2 py-1"
            value={resetValue}
            onChange={(e) => setResetValue(e.target.value)}
          />
          <div className="flex gap-2">
            <SubmitButton type="button" onClick={submitReset}>{t("adminUsers.confirmReset")}</SubmitButton>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setPending(null); setResetValue(""); }}
            >
              {t("adminUsers.cancel")}
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("adminUsers.listTitle")}</h2>
        {users.data === undefined ? (
          <p className="text-sm text-neutral-500">{t("app.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("adminUsers.empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1">{t("adminUsers.username")}</th>
                <th>{t("adminUsers.fullName")}</th>
                <th>{t("adminUsers.status")}</th>
                <th>{t("adminUsers.roles")}</th>
                <th>{t("adminUsers.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b align-top" data-testid={`admin-user-${u.username}`}>
                  <td className="py-1">{u.username}</td>
                  <td>{u.fullName}</td>
                  <td data-testid={`admin-status-${u.username}`}>
                    {u.active ? t("adminUsers.active") : t("adminUsers.inactive")}
                    {u.hasPin && <> · {t("adminUsers.hasPin")}</>}
                    {u.mustChangePassword && <> · {t("adminUsers.mustChange")}</>}
                  </td>
                  <td className="min-w-64">
                    {u.roles.length === 0 ? (
                      <span className="text-neutral-500">{t("adminUsers.noRoles")}</span>
                    ) : (
                      <ul>
                        {u.roles.map((r) => (
                          <li key={r.assignmentId}>
                            {r.roleKey}
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
                              <span className="ml-1 text-xs text-amber-700" data-testid={`admin-inert-${r.assignmentId}`}>
                                ({r.scopeType}{r.scopeId !== null && `: ${r.scopeId}`}) {t("adminUsers.inertScope")}
                              </span>
                            )}{" "}
                            <SubmitButton
                              type="button"
                              variant="link"
                              size="xs"
                              onClick={() => run(
                                () => revokeRole(u.id, r.assignmentId),
                                t("adminUsers.roleRevoked", { roleKey: r.roleKey, username: u.username }),
                              )}
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
                        return <p className="mt-1 text-xs text-neutral-500">{t("adminUsers.allRolesHeld")}</p>;
                      }
                      return (
                        <div className="mt-1 space-y-1">
                          <label className="sr-only" htmlFor={`assign-${u.id}`}>
                            {t("adminUsers.assignRoleFor", { username: u.username })}
                          </label>
                          <select
                            id={`assign-${u.id}`}
                            data-testid={`admin-role-select-${u.username}`}
                            className="w-full rounded border px-1 py-0.5 text-xs"
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
                              className="text-xs text-amber-800">
                              {t("adminUsers.grantsAccessAuthority")}
                            </p>
                          )}
                          <SubmitButton
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={chosen === ""}
                            onClick={() => run(
                              async () => {
                                await assignRole(u.id, { roleKey: chosen, scopeType: scope as "hospital" });
                                setPicked((p) => ({ ...p, [u.id]: "" }));
                              },
                              t("adminUsers.roleAssigned", { roleKey: chosen, username: u.username }),
                            )}
                          >
                            {t("adminUsers.assignRole")}
                          </SubmitButton>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="space-x-2 whitespace-nowrap">
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => { setPending({ user: u, kind: "password" }); setResetValue(""); }}
                    >
                      {t("adminUsers.resetPassword")}
                    </button>
                    <button
                      type="button"
                      className="text-xs underline"
                      onClick={() => { setPending({ user: u, kind: "pin" }); setResetValue(""); }}
                    >
                      {t("adminUsers.resetPin")}
                    </button>
                    {u.active ? (
                      <SubmitButton
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={() => run(
                          () => deactivateUser(u.id),
                          t("adminUsers.deactivated", { username: u.username }),
                        )}
                      >
                        {t("adminUsers.deactivate")}
                      </SubmitButton>
                    ) : (
                      <SubmitButton
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={() => run(
                          () => reactivateUser(u.id),
                          t("adminUsers.reactivated", { username: u.username }),
                        )}
                      >
                        {t("adminUsers.reactivate")}
                      </SubmitButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
