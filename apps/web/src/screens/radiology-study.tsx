import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import {
  fetchReadiness, fetchStudy, overrideGate, radiologyErrorText, recordAcquired, satisfyGate,
  startAcquisition, waiveGate,
} from "../lib/radiology-api";
import { Button } from "@/components/ui/button";

/**
 * PLAN 18a T9 — **THE STUDY CONSOLE: the ten gates, the override lane, and the acquisition.**
 *
 * ═══ THE SCREEN DOES NOT KNOW WHICH GATES ARE WAIVABLE ═══
 *
 * `waivable` arrives ON THE ROW, snapshotted at check-in from `gates.ts`'s own constant, so this
 * component renders a waive button where the server says one exists and nowhere else. A client-side
 * list of waivable kinds would be a second copy of a statutory rule — and `form_f` would be the
 * entry somebody eventually added to it.
 *
 * Every refusal is shown with its own code, verbatim. `form_f_missing` tells a technologist to go
 * and open the register; "could not proceed" tells them to try again, which is the wrong action.
 */
export function RadiologyStudy(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { studyId } = useParams({ from: "/authed/radiology/studies/$studyId" });
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState("{}");
  const [reason, setReason] = useState("");

  const study = useQuery({ queryKey: ["radiology", "study", studyId], queryFn: () => fetchStudy(studyId) });
  const gates = useQuery({ queryKey: ["radiology", "gates", studyId], queryFn: () => fetchReadiness(studyId) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["radiology", "study", studyId] });
    void qc.invalidateQueries({ queryKey: ["radiology", "gates", studyId] });
  };
  /**
   * Each mutation is declared with its own `useMutation` call rather than through a shared factory.
   * A factory that called the hook would break the rules of hooks — it worked only because the
   * calls happened to be unconditional and in a fixed order, which is the kind of thing that stays
   * true until somebody adds a branch. `eslint-plugin-react-hooks` caught it; this is the fix.
   */
  const onError = (e: unknown) => { setError(radiologyErrorText(e)); };
  const onSuccess = () => { setError(null); refresh(); };

  const satisfy = useMutation({
    mutationFn: (kind: string) => {
      let parsed: unknown = {};
      try { parsed = JSON.parse(evidence); } catch { throw new Error(t("radiology.study.badEvidence")); }
      return satisfyGate(studyId, kind, parsed);
    },
    onSuccess, onError,
  });
  const waive = useMutation({
    mutationFn: (kind: string) => waiveGate(studyId, kind, reason), onSuccess, onError,
  });
  const override = useMutation({
    mutationFn: (kind: string) => overrideGate(studyId, kind, reason), onSuccess, onError,
  });
  const start = useMutation({
    mutationFn: () => startAcquisition(studyId, new Date().toISOString().slice(0, 10)),
    onSuccess, onError,
  });
  const acquire = useMutation({
    mutationFn: () => recordAcquired(studyId, {
      onDate: new Date().toISOString().slice(0, 10), imageSource: "no_pacs_images",
    }),
    onSuccess, onError,
  });

  const s = study.data?.study ?? null;
  const r = gates.data;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">
        {s === null ? t("radiology.study.unknown") : `${s.accessionNo} — ${s.patientName}`}
      </h1>
      {s !== null
        ? (
          <p className="text-sm">
            {s.studyTypeCode} · {s.status}
            {s.formFRequired ? <span className="ml-2 rounded bg-amber-100 px-1">{t("radiology.worklist.formF")}</span> : null}
            {s.ionising ? <span className="ml-2 rounded bg-slate-200 px-1">{t("radiology.study.ionising")}</span> : null}
          </p>
        )
        : null}

      {error !== null ? <p role="alert" className="text-red-600">{error}</p> : null}

      <section>
        <h2 className="font-semibold">{t("radiology.study.gates")}</h2>
        {r !== undefined && r.open.length === 0
          ? <p role="status">{t("radiology.study.ready")}</p>
          : <p>{t("radiology.study.openGates", { count: r?.open.length ?? 0 })}</p>}

        <label className="flex flex-col text-sm">
          {t("radiology.study.evidence")}
          <textarea className="border px-2 py-1 font-mono" rows={3} value={evidence}
            onChange={(e) => { setEvidence(e.target.value); }} />
        </label>
        <label className="flex flex-col text-sm">
          {t("radiology.study.reason")}
          <input className="border px-2 py-1" value={reason} onChange={(e) => { setReason(e.target.value); }} />
        </label>

        <ul>
          {(r?.gates ?? []).map((g) => (
            <li key={g.id} data-testid={`gate-${g.kind}`} className="flex items-center gap-2 py-1">
              <span className="w-56">{t(`radiology.gate.${g.kind}`, { defaultValue: g.kind })}</span>
              <span className="w-24">{g.state}</span>
              {g.state === "open"
                ? (
                  <>
                    <Button onClick={() => { satisfy.mutate(g.kind); }}>{t("radiology.study.satisfy")}</Button>
                    {/** The button exists because the SERVER said the row is waivable. */}
                    {g.waivable
                      ? <Button variant="outline" onClick={() => { waive.mutate(g.kind); }}>
                          {t("radiology.study.waive")}
                        </Button>
                      : null}
                    <Button variant="outline" onClick={() => { override.mutate(g.kind); }}>
                      {t("radiology.study.override")}
                    </Button>
                  </>
                )
                : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex gap-2">
        <Button onClick={() => { start.mutate(); }}>{t("radiology.study.start")}</Button>
        <Button onClick={() => { acquire.mutate(); }}>{t("radiology.study.acquired")}</Button>
      </section>
    </div>
  );
}
