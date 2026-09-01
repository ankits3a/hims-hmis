import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import {
  draftReport, fetchStudy, publishReport, radiologyErrorText, signReport,
} from "../lib/radiology-api";
import { Button } from "@/components/ui/button";

/**
 * PLAN 18a T9 — **THE REPORT: written, signed under a fresh second factor, published.**
 *
 * ═══ THE LOCKOUT IS THE SERVER'S AND THE SCREEN SHOWS ITS REFUSAL WORD FOR WORD ═══
 *
 * A report containing a lexicon hit is refused `lexical_lockout` NAMING the term. The screen does
 * not pre-check the text and does not grey the button: a client-side lexicon would be a second copy
 * of a statutory rule that a browser extension can edit, and — worse — a radiologist who saw the
 * button grey out would learn which words to avoid rather than that the sentence is forbidden.
 * The refusal arrives from the server, names the word, and says what to do about it.
 *
 * ═══ THE SECOND FACTOR IS NOT ON THIS FORM ═══
 *
 * `signReport` sends a report id and nothing else. The freshness comes off the SESSION on the
 * server, so there is no field here to fill in and no way for the client to attest to it — which is
 * what §11.19-D-27 requires and what a `secondFactorAt` input would quietly destroy.
 */
export function RadiologyReport(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { studyId } = useParams({ from: "/authed/radiology/studies/$studyId/report" });
  const [findings, setFindings] = useState("");
  const [impression, setImpression] = useState("");
  const [critical, setCritical] = useState<"" | "red" | "orange" | "yellow">("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  const study = useQuery({ queryKey: ["radiology", "study", studyId], queryFn: () => fetchStudy(studyId) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["radiology", "study", studyId] });

  const save = useMutation({
    mutationFn: () => draftReport(studyId, { body: { findings }, impression }),
    onSuccess: (r) => { setError(null); setDraftId(r.reportId); setNote(t("radiology.report.saved")); void refresh(); },
    onError: (e) => { setError(radiologyErrorText(e)); },
  });
  const sign = useMutation({
    mutationFn: () => signReport(studyId, {
      reportId: draftId ?? "", criticalCategory: critical === "" ? null : critical,
    }),
    onSuccess: () => { setError(null); setNote(t("radiology.report.signed")); void refresh(); },
    onError: (e) => { setError(radiologyErrorText(e)); },
  });
  const publish = useMutation({
    mutationFn: () => publishReport(studyId),
    onSuccess: (r) => {
      setError(null);
      /** D5 — publication never waited on the cashier; the MESSAGE is what settlement decides. */
      setNote(r.notified ? t("radiology.report.publishedNotified") : t("radiology.report.publishedNoMessage"));
      void refresh();
    },
    onError: (e) => { setError(radiologyErrorText(e)); },
  });

  const s = study.data?.study ?? null;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">
        {s === null ? t("radiology.study.unknown") : `${t("radiology.report.title")} — ${s.accessionNo}`}
      </h1>

      {error !== null ? <p role="alert" className="text-red-600">{error}</p> : null}
      {note !== null ? <p role="status" className="text-green-700">{note}</p> : null}

      <label className="flex flex-col text-sm">
        {t("radiology.report.findings")}
        <textarea className="border px-2 py-1" rows={6} value={findings}
          onChange={(e) => { setFindings(e.target.value); }} />
      </label>
      <label className="flex flex-col text-sm">
        {t("radiology.report.impression")}
        <textarea className="border px-2 py-1" rows={3} value={impression}
          onChange={(e) => { setImpression(e.target.value); }} />
      </label>
      <label className="flex flex-col text-sm">
        {t("radiology.report.critical")}
        <select className="border px-2 py-1" value={critical}
          onChange={(e) => { setCritical(e.target.value as "" | "red" | "orange" | "yellow"); }}>
          <option value="">{t("radiology.report.criticalNone")}</option>
          <option value="red">red</option>
          <option value="orange">orange</option>
          <option value="yellow">yellow</option>
        </select>
      </label>

      <div className="flex gap-2">
        <Button onClick={() => { save.mutate(); }}>{t("radiology.report.save")}</Button>
        <Button disabled={draftId === null} onClick={() => { sign.mutate(); }}>
          {t("radiology.report.sign")}
        </Button>
        <Button variant="outline" onClick={() => { publish.mutate(); }}>
          {t("radiology.report.publish")}
        </Button>
      </div>

      {s !== null && s.reports.length > 0
        ? (
          <section>
            <h2 className="font-semibold">{t("radiology.report.versions")}</h2>
            <ul>
              {s.reports.map((v) => (
                <li key={v.id} data-testid={`version-${String(v.version)}`}>
                  v{v.version} — {v.status}{v.publishedAt === null ? "" : ` · ${t("radiology.report.published")}`}
                </li>
              ))}
            </ul>
          </section>
        )
        : null}
    </div>
  );
}
