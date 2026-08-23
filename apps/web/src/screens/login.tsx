import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { isPasswordChangeRequired } from "../lib/admin-api";

/**
 * PLAN 11e T6 — `password` IS `min(1)` NOW, AND IT WAS `min(8)`.
 *
 * The client-side floor was a copy of a rule the server does not apply at login and, since 11e D3,
 * deliberately never will: `loginSchema` in `auth.controller.ts` is `min(1)` because login VERIFIES
 * a credential that already exists, and a floor there locks out precisely the people the reset flow
 * exists to save. A floor HERE did the same thing one layer up — every live account whose password
 * predates `password-policy.ts` could have been shorter than eight characters and been refused by
 * the sign-in box without a request ever leaving the browser. The choosing rules live on the
 * server, at the paths where a human chooses.
 */
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
type LoginInput = z.infer<typeof loginSchema>;

export function LoginScreen(): React.ReactElement {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const { register, handleSubmit, formState } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (data) => {
    setFailed(false);
    try {
      await login(data.username, data.password);
      await navigate({ to: "/registration" });
    } catch (e) {
      /**
       * PLAN 11e T6 / D6 — THE FORCED-CHANGE FORK.
       *
       * `useAuth().login` stores the token and THEN calls `GET /auth/me`, which is a guarded route:
       * for somebody the admin has just provisioned or whose password was just reset, the guard
       * answers 403 `password_change_required` and that call throws. The token is already stored
       * (`api()` clears it only on a 401), so the change-password flow travels on this very
       * session — which is D1's whole point: completing the change needs no second login.
       *
       * Anything else here is an ordinary sign-in failure.
       */
      if (isPasswordChangeRequired(e)) {
        await navigate({ to: "/change-password" });
        return;
      }
      setFailed(true);
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center">
      <form onSubmit={(e) => void onSubmit(e)} className="w-80 space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">{t("login.title")}</h1>
        <div>
          <label className="block text-sm" htmlFor="username">{t("login.username")}</label>
          <input id="username" autoFocus className="w-full rounded border px-2 py-1" {...register("username")} />
          {formState.errors.username && <p role="alert" className="text-sm text-red-600">{formState.errors.username.message}</p>}
        </div>
        <div>
          <label className="block text-sm" htmlFor="password">{t("login.password")}</label>
          <input id="password" type="password" className="w-full rounded border px-2 py-1" {...register("password")} />
          {formState.errors.password && <p role="alert" className="text-sm text-red-600">{formState.errors.password.message}</p>}
        </div>
        {failed && <p role="alert" className="text-sm text-red-600">{t("login.failed")}</p>}
        <button type="submit" className="w-full rounded bg-neutral-900 py-1.5 text-white" disabled={formState.isSubmitting}>
          {t("login.submit")}
        </button>
      </form>
    </main>
  );
}
