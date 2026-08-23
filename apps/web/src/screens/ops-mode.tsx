import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import {
  OPERATING_MODES, changeMode, getLatestConfigValidation, getMode, opsErrorCode, opsErrorDetail,
  opsErrorMessage, runConfigValidation,
} from "../lib/ops-api";
import { FormKit, SelectField } from "../components/form-kit";
import { Button } from "@/components/ui/button";

/**
 * PLAN 11c T5 / D8 — THE MODE DESK: what the hospital's operating mode is, why the go-live gate
 * is or is not satisfied, and the one form that changes either.
 *
 * THE SERVER STAYS AUTHORITATIVE FOR EVERY RULE (the `opd-admin.tsx` precedent, stated there
 * verbatim): this screen mints no client-side permission check and no client-side transition
 * matrix. The change form renders for whoever opens the route; a caller without `ops.mode.set`
 * gets a 403 and it renders inline exactly like every other refusal. Duplicating D2's matrix or
 * D3's freshness window here would be a second copy of a rule this screen must never originate.
 *
 * REFUSAL CODES ARE RENDERED, NOT SWALLOWED (the plan's own words for this task). `ModeError`'s
 * four codes — `mode_commissioning_is_initial_only`, `golive_gate_unsatisfied`,
 * `mode_note_required`, `mode_unchanged` — each get their own sentence, and
 * `golive_gate_unsatisfied` additionally renders its `detail` (`no_report` / `stale_report` /
 * `report_not_ok`), because the controller's own comment is the reason: a duty manager at 03:00
 * needs "the last report is stale" and "the last report said no" to read as different sentences.
 * A refusal with no machine code (a 403, a malformed body) falls back to the server's message.
 */
const POLL_MS = 15_000;

const KNOWN_MODE_CODES = new Set([
  "mode_commissioning_is_initial_only",
  "golive_gate_unsatisfied",
  "mode_note_required",
  "mode_unchanged",
]);
const KNOWN_GATE_DETAILS = new Set(["no_report", "stale_report", "report_not_ok"]);

const changeSchema = z.object({
  to: z.enum(OPERATING_MODES),
  note: z.string().max(2000),
});
type ChangeValues = z.infer<typeof changeSchema>;

function ModeRefusal({ code, detail, message }: { code: string | null; detail: unknown; message: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (message === null) return null;
  const detailKey = typeof detail === "string" && KNOWN_GATE_DETAILS.has(detail) ? detail : null;
  return (
    <p role="alert" data-testid="mode-change-error" data-code={code ?? ""} className="text-sm text-red-600">
      {code !== null && KNOWN_MODE_CODES.has(code) ? t(`opsMode.error.${code}`) : message}
      {detailKey !== null && <> — {t(`opsMode.gateDetail.${detailKey}`)}</>}
    </p>
  );
}

export function OpsMode(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [changeError, setChangeError] = useState<{ code: string | null; detail: unknown; message: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationRan, setValidationRan] = useState(false);

  const mode = useQuery({ queryKey: ["ops", "mode"], queryFn: getMode, refetchInterval: POLL_MS });
  const gate = useQuery({ queryKey: ["ops", "config-validation", "latest"], queryFn: getLatestConfigValidation });

  const form = useForm<ChangeValues>({
    resolver: zodResolver(changeSchema),
    defaultValues: { to: "normal", note: "" },
  });

  const refresh = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["ops", "mode"] }),
      qc.invalidateQueries({ queryKey: ["ops", "config-validation", "latest"] }),
    ]);
  };

  const runValidation = async (): Promise<void> => {
    setValidationError(null);
    setValidationRan(false);
    try {
      await runConfigValidation();
      setValidationRan(true);
      await refresh();
    } catch (e) {
      setValidationError(opsErrorMessage(e));
    }
  };

  const submit = form.handleSubmit(async (v) => {
    setChangeError(null);
    setChanged(false);
    try {
      await changeMode({ to: v.to, note: v.note.trim() === "" ? null : v.note.trim() });
      setChanged(true);
      form.reset({ to: v.to, note: "" });
      await refresh();
    } catch (e) {
      setChangeError({ code: opsErrorCode(e), detail: opsErrorDetail(e), message: opsErrorMessage(e) });
    }
  });

  const report = gate.data?.report ?? null;
  const modeData = mode.data;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">{t("opsMode.title")}</h1>

      <section className="space-y-1 rounded border p-4" data-testid="mode-current">
        <h2 className="text-sm font-semibold">{t("opsMode.currentTitle")}</h2>
        {modeData === undefined ? (
          <p className="text-sm text-neutral-500">{t("app.loading")}</p>
        ) : (
          <>
            <p data-testid="mode-current-word" className="text-lg font-medium">
              {t(`opsMode.mode.${modeData.mode}`)}
            </p>
            <p data-testid="mode-current-since" className="text-sm text-neutral-600">
              {t("opsMode.since")}: {modeData.since === null ? t("opsMode.neverChanged") : modeData.since}
            </p>
            {modeData.note !== null && modeData.note !== "" && (
              <p data-testid="mode-current-note" className="text-sm text-neutral-600">{modeData.note}</p>
            )}
          </>
        )}
      </section>

      <section className="space-y-2 rounded border p-4" data-testid="mode-gate">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("opsMode.gate.title")}</h2>
          <Button type="button" variant="outline" size="sm" onClick={() => void runValidation()}>
            {t("opsMode.gate.run")}
          </Button>
        </div>
        {validationRan && <p className="text-sm text-green-700">{t("opsMode.gate.ran")}</p>}
        {validationError !== null && <p role="alert" className="text-sm text-red-600">{validationError}</p>}
        {report === null ? (
          <p data-testid="mode-gate-none" className="text-sm text-neutral-500">{t("opsMode.gate.none")}</p>
        ) : (
          <div className="space-y-2">
            <p data-testid="mode-gate-verdict" className="text-sm font-medium">
              {t(report.ok ? "opsMode.gate.ok" : "opsMode.gate.notOk")} · {report.at}
            </p>
            <ul className="space-y-1">
              {report.scopes.map((scope) => (
                <li key={scope.scope} data-testid={`mode-gate-scope-${scope.scope}`} className="text-sm">
                  <span className="font-medium">{scope.scope}</span>: {t(scope.ok ? "opsMode.gate.ok" : "opsMode.gate.notOk")}
                  {scope.errors.length > 0 && (
                    <ul className="ml-4 list-disc text-xs text-red-600">
                      {scope.errors.map((err) => (
                        <li key={err.code}>{err.code}: {err.detail}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-semibold">{t("opsMode.change.title")}</h2>
        <FormProvider {...form}>
          <FormKit onSubmit={submit} className="max-w-md">
            <SelectField
              name="to"
              label={t("opsMode.change.to")}
              options={OPERATING_MODES.map((m) => ({ value: m, label: t(`opsMode.mode.${m}`) }))}
            />
            <div>
              <label className="block text-sm font-medium" htmlFor="f-note">{t("opsMode.change.note")}</label>
              <textarea
                id="f-note"
                data-field
                className="w-full rounded border px-2 py-1"
                rows={3}
                {...form.register("note")}
              />
            </div>
            <ModeRefusal code={changeError?.code ?? null} detail={changeError?.detail ?? null} message={changeError?.message ?? null} />
            {changed && <p className="text-sm text-green-700">{t("opsMode.change.done")}</p>}
            <Button type="submit">{t("opsMode.change.submit")}</Button>
          </FormKit>
        </FormProvider>
      </section>
    </div>
  );
}
