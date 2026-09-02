import { useEffect, useState } from "react";
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
   * Close review C3 — the latest unsigned version is READ on load, so a reload (or a second sitting)
   * starts from what was saved — the drafter's technique included — instead of from `{}`, which
   * used to drop the machine's technique from the human's next save in silence.
   */
  /** Pass 2 C4/NEW-2 — a MACHINE draft is neither the seed nor the signable: only a human's version is. */
  const humanUnsigned = (v: { status: string; machineDrafted: boolean }) => (v.status === "draft" || v.status === "prelim") && !v.machineDrafted;
  const latestUnsignedId = study.data?.study?.reports.find(humanUnsigned)?.id ?? null;
  const latest = useQuery({
    queryKey: ["radiology", "report", latestUnsignedId],
    queryFn: () => fetchReport(latestUnsignedId!),
    enabled: latestUnsignedId !== null,
  });
  const [seededFrom, setSeededFrom] = useState<string | null>(null);
  useEffect(() => {
    const r = latest.data?.report;
    if (r === undefined || r === null || seededFrom === r.reportId) return;
    setSeededFrom(r.reportId);
    const { findings: savedFindings, ...rest } = r.body as Record<string, string>;
    setSections((cur) => ({ ...rest, ...cur }));
    setFindings((cur) => (cur === "" ? savedFindings ?? "" : cur));
    setImpression((cur) => (cur === "" ? r.impression ?? "" : cur));
  }, [latest.data, seededFrom]);

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
  /**
   * Close review C2 (CRITICAL) — the first version WIPED whatever the radiologist had typed: the
   * drafter's findings are always empty and the screen copied them over the textarea. A proposal
   * fills the sections a human does not write (technique) and never touches what a human did.
   * Close review C4 — one round trip: the answer carries the body.
   */
  const propose = useMutation({
    mutationFn: () => proposeDraft(studyId),
    onSuccess: (r) => {
      setError(null); setSeededFrom(r.reportId);
      const { findings: _drafted, ...rest } = r.body;
      void _drafted;
      setSections((cur) => ({ ...rest, ...cur, technique: r.body.technique ?? cur.technique ?? "" }));
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
  const signableId = draftId ?? s?.reports.find(humanUnsigned)?.id ?? null;

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
