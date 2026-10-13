import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { billingErrorMessage } from "../../lib/billing-api";

/**
 * ═══ GO-LIVE SCREENS — A TARIFF VERSION'S ROAD, AS BUTTONS ═══
 *
 * Draft → **Submit for approval** (`tariff.versions.draft`) → the owner decides in the approvals inbox →
 * **Activate** with an effective-from date (`tariff.versions.activate`). The panel shows who drafted and who
 * submitted each pending version. Activate is disabled, with the reason, when the viewer drafted or submitted it;
 * that mirrors `activateVersion`'s `sod_drafter_activator`, and the server stays the authority.
 */
export type WireOfficeVersion = {
  id: string; versionNo: number; status: string; notes: string | null;
  createdBy: string; createdByName: string | null; submittedBy: string | null; submittedByName: string | null;
  approvalStatus: string | null;
};

/** `datetime-local` value for now + 5 minutes, in the browser's (the desk's) local time. */
function soon(): string {
  const d = new Date(Date.now() + 5 * 60_000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function VersionRow({ v }: { v: WireOfficeVersion }): React.ReactElement {
  const { t } = useTranslation();
  const { can, actor } = useAuth();
  const qc = useQueryClient();
  const [when, setWhen] = useState(soon());
  const [note, setNote] = useState("");
  const refresh = (): void => { void qc.invalidateQueries({ queryKey: ["tariff"] }); };
  const submit = useMutation({
    mutationFn: () => api("POST", `/tariff/versions/${encodeURIComponent(v.id)}/submit`, note.trim() === "" ? {} : { requestNote: note.trim() }),
    onSuccess: refresh,
  });
  const activate = useMutation({
    mutationFn: () => api("POST", `/tariff/versions/${encodeURIComponent(v.id)}/activate`, { effectiveFrom: new Date(when).toISOString() }),
    onSuccess: refresh,
  });
  const me = actor?.id ?? null;
  const blocked = me !== null && (me === v.createdBy || me === v.submittedBy)
    ? t(me === v.createdBy ? "tariffVersions.blockedDrafter" : "tariffVersions.blockedSubmitter")
    : null;
  const approved = v.status === "submitted" && v.approvalStatus === "granted";
  const error = submit.error ?? activate.error;

  return (
    <li className="space-y-2 rounded-lg border bg-white p-3" data-testid={`tariff-version-${v.versionNo}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold">{t("tariffVersions.version", { no: v.versionNo })}</span>
        <span className="rounded border px-1.5 text-xs" data-testid={`tariff-version-${v.versionNo}-state`}>
          {t(`tariffVersions.state.${v.status === "submitted" ? `approval_${v.approvalStatus ?? "pending"}` : v.status}`)}
        </span>
      </div>
      {v.notes !== null && <p className="text-sm text-muted-foreground">{v.notes}</p>}
      <p className="text-xs text-muted-foreground">
        {t("tariffVersions.draftedBy", { who: v.createdByName ?? v.createdBy })}
        {v.submittedBy !== null && <> · {t("tariffVersions.submittedBy", { who: v.submittedByName ?? v.submittedBy })}</>}
      </p>
      {v.status === "draft" && can("tariff.versions.draft") && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded border px-2 py-1 text-sm" placeholder={t("tariffVersions.notePlaceholder")}
            value={note} onChange={(e) => setNote(e.target.value)} aria-label={t("tariffVersions.notePlaceholder")}
          />
          <button type="button" className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={submit.isPending} onClick={() => submit.mutate()} data-testid={`tariff-version-${v.versionNo}-submit`}>
            {t("tariffVersions.submit")}
          </button>
        </div>
      )}
      {v.status === "submitted" && !approved && (
        <p className="text-sm" data-testid={`tariff-version-${v.versionNo}-waiting`}>
          {v.approvalStatus === "rejected" ? t("tariffVersions.rejected") : t("tariffVersions.waitingOwner")}
        </p>
      )}
      {approved && can("tariff.versions.activate") && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span>{t("tariffVersions.effectiveFrom")}</span>
            <input type="datetime-local" className="rounded border px-2 py-1 text-sm" value={when}
              onChange={(e) => setWhen(e.target.value)} data-testid={`tariff-version-${v.versionNo}-when`} />
          </label>
          <button type="button" className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={blocked !== null || activate.isPending || when === ""} onClick={() => activate.mutate()}
            data-testid={`tariff-version-${v.versionNo}-activate`}>
            {t("tariffVersions.activate")}
          </button>
          {blocked !== null && <span className="text-sm text-amber-800" data-testid={`tariff-version-${v.versionNo}-blocked`}>{blocked}</span>}
        </div>
      )}
      {error !== null && <p role="alert" className="text-sm text-red-600">{billingErrorMessage(error)}</p>}
    </li>
  );
}

export function TariffVersionActions(): React.ReactElement | null {
  const { t } = useTranslation();
  const { can, ready } = useAuth();
  const mayRead = can("tariff.read");
  const versions = useQuery({
    queryKey: ["tariff", "versions"], enabled: mayRead,
    queryFn: () => api<{ items: WireOfficeVersion[] }>("GET", "/tariff/versions"),
  });
  if (!ready || !mayRead) return null;
  const pending = (versions.data?.items ?? []).filter((v) => v.status === "draft" || v.status === "submitted")
    .sort((a, b) => b.versionNo - a.versionNo);
  return (
    <section className="mt-8 space-y-3" data-testid="tariff-version-actions" aria-labelledby="tariff-version-actions-title">
      <h2 id="tariff-version-actions-title" className="text-base font-semibold">{t("tariffVersions.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("tariffVersions.lead")}</p>
      {versions.error !== null && <p role="alert" className="text-sm text-red-600">{billingErrorMessage(versions.error)}</p>}
      {pending.length === 0
        ? <p className="text-sm text-muted-foreground" data-testid="tariff-version-none">{t("tariffVersions.none")}</p>
        : <ul className="space-y-2">{pending.map((v) => <VersionRow key={v.id} v={v} />)}</ul>}
    </section>
  );
}
