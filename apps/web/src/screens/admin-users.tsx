import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { FormKit, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";
import {
  adminErrorCode, adminErrorMessage, createUser, deactivateUser, listUsers, reactivateUser,
  resetPassword, resetPin, revokeRole,
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
 * ═══ WHAT IS DELIBERATELY ABSENT ═══
 *
 * No role CREATION: the vocabulary is code-owned (`seed:roles`), and an HTTP-minted role would be
 * invisible to the model — production's permissionless `owner` role is what that looks like. Role
 * ASSIGNMENT is the server's `POST /admin/users/:id/roles`; this screen renders what each person
 * holds and can revoke one, because revoking is the half a hospital needs in a hurry. Assigning
 * from here needs a role picker fed by a roles list the server does not yet expose — a route this
 * phase deliberately did not add.
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

  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { username: "", fullName: "", password: "", pin: "" },
  });

  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ["admin", "users"] });

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

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t("adminUsers.title")}</h1>

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
            <Button type="button" onClick={() => void submitReset()}>{t("adminUsers.confirmReset")}</Button>
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
                  <td>
                    {u.roles.length === 0 ? (
                      <span className="text-neutral-500">{t("adminUsers.noRoles")}</span>
                    ) : (
                      <ul>
                        {u.roles.map((r) => (
                          <li key={r.assignmentId}>
                            {r.roleKey}
                            {r.scopeId !== null && <> ({r.scopeId})</>}{" "}
                            <button
                              type="button"
                              className="text-xs underline"
                              onClick={() => void run(
                                () => revokeRole(u.id, r.assignmentId),
                                t("adminUsers.roleRevoked", { roleKey: r.roleKey, username: u.username }),
                              )}
                            >
                              {t("adminUsers.revokeRole")}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
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
                      <button
                        type="button"
                        className="text-xs underline"
                        onClick={() => void run(
                          () => deactivateUser(u.id),
                          t("adminUsers.deactivated", { username: u.username }),
                        )}
                      >
                        {t("adminUsers.deactivate")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-xs underline"
                        onClick={() => void run(
                          () => reactivateUser(u.id),
                          t("adminUsers.reactivated", { username: u.username }),
                        )}
                      >
                        {t("adminUsers.reactivate")}
                      </button>
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
