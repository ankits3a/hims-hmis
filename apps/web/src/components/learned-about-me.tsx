import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { SUGGESTION_PREFS_KEY } from "../lib/suggest-signals";
import { DeskModal } from "./desk-modal";

/**
 * ═══ WHAT THE SYSTEM HAS LEARNED ABOUT ME — AND RESET (decision 0050 P4, #615) ═══
 *
 * Owner, 2026-10-07: "each doctor be able to see and reset what the system has learned about them."
 *
 * The doctor's own patterns only, as the server reads them (`GET /opd/consult/learned`): complaints,
 * diagnoses, tests per diagnosis, own words, and how many chips are hidden by three crosses. Counts and
 * items only — no patient, no visit, no money. A reset is per surface or all at once, always behind a
 * confirm; nothing is deleted, the doctor's own level simply starts again from now.
 */

export const LEARNED_SURFACES = ["complaints", "diagnoses", "tests", "findings", "hidden"] as const;
export type LearnedSurface = (typeof LEARNED_SURFACES)[number];

export type WireLearned = {
  since: Record<LearnedSurface, string | null>;
  complaints: { term: string; uses: number }[];
  diagnoses: { text: string; icd10Code: string | null; uses: number }[];
  tests: { diagnosis: string; name: string; uses: number }[];
  findings: { field: string; term: string; uses: number }[];
  hidden: { kind: string; contextKey: string | null; itemKey: string }[];
};

export const LEARNED_KEY = ["opd", "consult", "learned"] as const;

type Row = { key: string; label: string; uses: number | null };

function rowsOf(data: WireLearned, surface: LearnedSurface, t: (k: string, o?: Record<string, unknown>) => string): Row[] {
  switch (surface) {
    case "complaints": return data.complaints.map((c) => ({ key: c.term, label: c.term, uses: c.uses }));
    case "diagnoses": return data.diagnoses.map((d) => ({ key: `${d.icd10Code ?? ""}|${d.text}`, label: d.icd10Code === null ? d.text : `${d.text} · ${d.icd10Code}`, uses: d.uses }));
    case "tests": return data.tests.map((x) => ({ key: `${x.diagnosis}|${x.name}`, label: t("learnedAboutMe.testFor", { name: x.name, diagnosis: x.diagnosis }), uses: x.uses }));
    case "findings": return data.findings.map((f) => ({ key: `${f.field}|${f.term}`, label: f.term, uses: f.uses }));
    case "hidden": {
      const byKind = new Map<string, number>();
      for (const h of data.hidden) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1);
      return [...byKind].map(([kind, n]) => ({ key: kind, label: t("learnedAboutMe.hiddenKind", { kind: t(`learnedAboutMe.kind.${kind}`, { defaultValue: kind }), count: n }), uses: null }));
    }
  }
}

export function LearnedAboutMe({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<LearnedSurface | "all" | null>(null);
  const learned = useQuery({ queryKey: LEARNED_KEY, enabled: open, retry: false, queryFn: () => api<WireLearned>("GET", "/opd/consult/learned") });
  const reset = useMutation({
    mutationFn: (surfaces: LearnedSurface[] | "all") => api<{ resetAt: string; surfaces: LearnedSurface[] }>("POST", "/opd/consult/learned/reset", { surfaces }),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: LEARNED_KEY });
      /* hidden chips come back on the next sitting: the prefs read carries the hidden list */
      void queryClient.invalidateQueries({ queryKey: SUGGESTION_PREFS_KEY });
    },
  });

  const confirmLabel = confirming === null ? "" : confirming === "all" ? t("learnedAboutMe.confirmAll") : t("learnedAboutMe.confirmOne", { surface: t(`learnedAboutMe.surface.${confirming}`) });
  const sinceText = (at: string | null): string => (at === null ? t("learnedAboutMe.sinceStart") : t("learnedAboutMe.sinceReset", { date: new Date(at).toLocaleDateString() }));

  return (
    <DeskModal open={open} onClose={onClose} title={t("learnedAboutMe.title")} titleId="learned-about-me-title" testId="learned-about-me"
      closeLabel={t("learnedAboutMe.close")} trapFocus width={600}>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--dim)" }}>{t("learnedAboutMe.intro")}</p>
      {learned.isLoading && <p data-testid="learned-loading">{t("learnedAboutMe.loading")}</p>}
      {learned.isError && <p data-testid="learned-error" role="alert">{t("learnedAboutMe.error")}</p>}
      {learned.data !== undefined && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {LEARNED_SURFACES.map((s) => {
            const rows = rowsOf(learned.data, s, t);
            return (
              <section key={s} data-testid={`learned-${s}`} aria-labelledby={`learned-${s}-h`}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <h3 id={`learned-${s}-h`} style={{ margin: 0, fontSize: 13 }}>{t(`learnedAboutMe.surface.${s}`)}</h3>
                  <button type="button" className="sec" data-testid={`learned-reset-${s}`} disabled={rows.length === 0 || reset.isPending}
                    style={{ minHeight: 28, padding: "2px 10px", fontSize: 12 }} onClick={() => { setConfirming(s); }}>
                    {t("learnedAboutMe.reset")}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--dim)" }}>{sinceText(learned.data.since[s])}</div>
                {rows.length === 0
                  ? <div data-testid={`learned-${s}-empty`} style={{ fontSize: 12, color: "var(--dim)" }}>{t("learnedAboutMe.nothing")}</div>
                  : (
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                      {rows.map((r) => <li key={r.key}>{r.label}{r.uses === null ? "" : ` · ${t("learnedAboutMe.uses", { count: r.uses })}`}</li>)}
                    </ul>
                  )}
              </section>
            );
          })}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="sec" data-testid="learned-reset-all" disabled={reset.isPending} onClick={() => { setConfirming("all"); }}>
              {t("learnedAboutMe.resetAll")}
            </button>
          </div>
        </div>
      )}
      {confirming !== null && (
        <div role="alertdialog" aria-label={confirmLabel} data-testid="learned-confirm"
          style={{ marginTop: 12, padding: 10, border: "1px solid var(--line, #ccc)", borderRadius: 8 }}>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>{confirmLabel}</p>
          {reset.isError && <p role="alert" data-testid="learned-reset-error" style={{ margin: "0 0 8px", fontSize: 12 }}>{t("learnedAboutMe.resetFailed")}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="sec" data-testid="learned-confirm-no" onClick={() => { setConfirming(null); }}>{t("learnedAboutMe.keep")}</button>
            <button type="button" data-testid="learned-confirm-yes" disabled={reset.isPending}
              onClick={() => { reset.mutate(confirming === "all" ? "all" : [confirming]); }}>
              {t("learnedAboutMe.confirmReset")}
            </button>
          </div>
        </div>
      )}
    </DeskModal>
  );
}
