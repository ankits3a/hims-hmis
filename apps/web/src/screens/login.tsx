import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(8),
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
    } catch {
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
