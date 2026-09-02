import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import {
  draftReport, fetchReport, fetchStudy, proposeDraft, publishReport, radiologyErrorText, signReport,
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
  /**
   * 18b T4 / D7 — the sections the drafter filled (technique, from the recorded facts). They ride
   * along on save so a human's edit of `findings` does not drop the machine's `technique`; the
   * screen shows technique read-only because a human who wants to change it edits the study, not
   * the sentence.
   */
  const [sections, setSections] = useState<Record<string, string>>({});

  const study = useQuery({ queryKey: ["radiology", "study", studyId], queryFn: () => fetchStudy(studyId) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["radiology", "study", studyId] });

  /**
   * ═══ F73 (CLOSE REVIEW) — THE SCREEN NEVER SENT A SIDE, SO NO LATERALISED STUDY COULD BE SIGNED ═══
   *
   * `assertSignable` refuses a report on a `laterality_applicable` type that names no side, and
   * this screen had no laterality control and never sent the field — so `XR-KNEE` and
   * `USG-DOPPLER-LL`, two of the twenty seeded types, were permanently unreportable through the
   * only reporting screen in the product. Both layers were right about their own half: the service
   * test called the function with an explicit side, and the screen test mocked a NON-lateralised
   * study. Nothing joined them.
   *
   * The side is not typed here either, and deliberately: F59 made the `laterality_confirm` gate
   * RECORD what the patient stated at the console, in front of the patient, so the study already
   * carries it. Asking the radiologist to retype it would create a second answer to "which knee" —
   * which is the whole defect E3 is about. The report carries the study's side, and `assertSignable`
   * still refuses a disagreement.
   */
  const propose = useMutation({
    mutationFn: async () => {
      const r = await proposeDraft(studyId);
      const view = await fetchReport(r.reportId);
      return { ...r, body: (view.report?.body ?? {}) as Record<string, string> };
    },
    onSuccess: (r) => {
      setError(null); setDraftId(r.reportId);
      setSections(r.body); setFindings(r.body.findings ?? ""); setImpression("");
      setNote(t("radiology.report.proposed", { drafter: r.provenance.drafter }));
      void refresh();
    },
    onError: (e: unknown) => { setError(radiologyErrorText(e)); },
  });
  const save = useMutation({
    mutationFn: () => draftReport(studyId, {
      body: { ...sections, findings }, impression, laterality: study.data?.study?.laterality ?? null,
    }),
    onSuccess: (r) => { setError(null); setDraftId(r.reportId); setNote(t("radiology.report.saved")); void refresh(); },
    onError: (e) => { setError(radiologyErrorText(e)); },
  });
  const sign = useMutation({
    mutationFn: () => signReport(studyId, {
      reportId: signableId ?? "", criticalCategory: critical === "" ? null : critical,
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
  /** F81 — the newest unsigned version, from the server, with the in-session draft as a fast path. */
  const signableId = draftId
    ?? s?.reports.find((v) => v.status === "draft" || v.status === "prelim")?.id
    ?? null;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">
        {s === null ? t("radiology.study.unknown") : `${t("radiology.report.title")} — ${s.accessionNo}`}
      </h1>

      {error !== null ? <p role="alert" className="text-red-600">{error}</p> : null}
      {note !== null ? <p role="status" className="text-green-700">{note}</p> : null}

      <div className="flex items-center gap-2 text-sm">
        <Button variant="outline" onClick={() => { propose.mutate(); }}>{t("radiology.report.startFromTemplate")}</Button>
        {sections.technique !== undefined && sections.technique !== ""
          ? <span data-testid="technique">{t("radiology.report.technique")}: {sections.technique}</span>
          : null}
      </div>
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
        {/**
          * F81 — `draftId` lived only in `useState`, so a radiologist who saved a draft, was
          * interrupted and reloaded the tab found Sign dead and the only way forward was to retype
          * the findings and append ANOTHER immutable version to a chain a courtroom reads. The
          * signable version is derived from the study, which this screen already has.
          */}
        <Button disabled={signableId === null} onClick={() => { sign.mutate(); }}>
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
                  {v.machineDrafted ? <span className="ml-2 rounded bg-slate-200 px-1">{t("radiology.report.machineDrafted")}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        )
        : null}
    </div>
  );
}
