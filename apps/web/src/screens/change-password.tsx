import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { FormKit, TextField } from "../components/form-kit";
import { Button } from "@/components/ui/button";
import { adminErrorMessage, changePassword } from "../lib/admin-api";

/**
 * PLAN 11e T6 / D6 — THE FORCED-CHANGE LANDING, and the ordinary change-your-password screen.
 *
 * It is reached two ways: `login.tsx` routes here when the server answers a 403
 * `password_change_required` after a successful login, and anybody can navigate here to change a
 * password they simply dislike.
 *
 * IT SITS OUTSIDE THE SHELL, DELIBERATELY. A person in the forced-change state is refused on every
 * route but this one and logout, so rendering the authed layout around them would fire the alerts
 * bell and the mode banner into a wall of 403s and put a nav bar in front of somebody who cannot
 * use any of it. The route is a sibling of `/login` for that reason (`router.tsx`).
 *
 * THE FLOOR IS NOT COPIED HERE. `newPassword` is `min(1)` client-side; the ten-character rule,
 * the username rule and the top-20 list live in `kernel/auth/password-policy.ts` and come back as
 * a rendered refusal. A second copy of the floor in this file would drift from the one that
 * decides, and the failure mode is a screen refusing a password the server would have taken.
 */
const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
  confirmPassword: z.string().min(1),
});
type Values = z.infer<typeof schema>;

export function ChangePassword(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    setMismatch(false);
    // The confirm field is a TYPO GUARD and is checked here rather than server-side: the server
    // has no business knowing a password was typed twice, and a mismatch is not a policy refusal.
    if (v.newPassword !== v.confirmPassword) {
      setMismatch(true);
      return;
    }
    try {
      await changePassword({ currentPassword: v.currentPassword, newPassword: v.newPassword });
      await navigate({ to: "/registration" });
    } catch (e) {
      setError(adminErrorMessage(e));
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="w-96 space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">{t("changePassword.title")}</h1>
        <p className="text-sm text-neutral-600">{t("changePassword.why")}</p>
        <FormProvider {...form}>
          <FormKit onSubmit={submit}>
            <TextField name="currentPassword" label={t("changePassword.current")} type="password" autoFocus />
            <TextField name="newPassword" label={t("changePassword.next")} type="password" />
            <TextField name="confirmPassword" label={t("changePassword.confirm")} type="password" />
            <p className="text-xs text-neutral-500">{t("changePassword.rule")}</p>
            {mismatch && (
              <p role="alert" data-testid="change-password-mismatch" className="text-sm text-red-600">
                {t("changePassword.mismatch")}
              </p>
            )}
            {error !== null && (
              <p role="alert" data-testid="change-password-error" className="text-sm text-red-600">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {t("changePassword.submit")}
            </Button>
          </FormKit>
        </FormProvider>
      </div>
    </main>
  );
}
