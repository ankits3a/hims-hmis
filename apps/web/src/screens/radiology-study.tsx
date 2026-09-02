import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  fetchReadiness, fetchStudy, openImages, overrideGate, radiologyErrorText, recordAcquired, satisfyGate,
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
  const navigate = useNavigate();
  const { studyId } = useParams({ from: "/authed/radiology/studies/$studyId" });
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState("{}");
  const [reason, setReason] = useState("");
  /**
   * 18b T2 / D8 — the console chooses the image source, and for `pacs` carries the Study Instance
   * UID. The field is PRE-FILLED with the value the server minted (the one the worklist export
   * offered the modality) and is editable only for a machine that did not read the worklist.
   * `outside` is not offered here: it belongs to 18a-iii's outside-study register.
   */
  const [source, setSource] = useState<"pacs" | "no_pacs_images">("pacs");
  const [typedUid, setTypedUid] = useState<string | null>(null);

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
  /**
   * F52 — neither call sends a date any more. Both used to send
   * `new Date().toISOString().slice(0, 10)` — the BROWSER's UTC day, which between 00:00 and 05:30
   * IST is yesterday — and the start call's date decided whether the machine's PCPNDT registration
   * was live. A registration expiring 31 March passed at 02:00 IST on 1 April: the plan's own
   * decisive E1 scenario, hour for hour. The server derives its own IST day now.
   */
  const start = useMutation({ mutationFn: () => startAcquisition(studyId), onSuccess, onError });
  const s = study.data?.study ?? null;
  const r = gates.data;
  const uid = typedUid ?? s?.mintedStudyInstanceUid ?? "";

  /**
   * 18b T3 / D6 — the server decides whether there are images and where the viewer is, records the
   * view, and only then returns a URL; this screen opens it in a new tab. A link built here would
   * open the images with nothing recorded.
   */
  const open = useMutation({
    mutationFn: () => openImages(studyId),
    onSuccess: (r) => { setError(null); window.open(r.url, "_blank", "noopener,noreferrer"); refresh(); },
    onError,
  });
  const acquire = useMutation({
    mutationFn: () => recordAcquired(
      studyId,
      source === "pacs" ? { imageSource: "pacs", studyInstanceUid: uid } : { imageSource: "no_pacs_images" },
    ),
    onSuccess, onError,
  });

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">
        {s === null ? t("radiology.study.unknown") : `${s.accessionNo} — ${s.patientName}`}
      </h1>
      {s !== null
        ? (
          <p className="text-sm">
            {s.studyTypeCode} · {s.status}
            {s.formFRequired
              ? (
                /**
                 * ═══ F49 (CLOSE REVIEW) — THIS BADGE USED TO BE THE END OF THE ROAD ═══
                 *
                 * `/pcpndt/form-f/$studyId` is routed and unlisted (pcpndtManifest declares no
                 * menu), and NOTHING in the application navigated to it: a grep for the path
                 * outside the router and the api client returned only the screen's own `useParams`.
                 * So the statutory form could be opened only by hand-typing a URL containing a ULID
                 * — while this badge told the technologist the form was required and
                 * `recordAcquired` refused the scan without one. The UI dead-ended between a
                 * requirement and its only remedy.
                 */
                <button
                  type="button"
                  className="ml-2 rounded bg-amber-100 px-1 underline"
                  onClick={() => {
                    void navigate({ to: "/pcpndt/form-f/$studyId", params: { studyId } });
                  }}
                >
                  {t("radiology.study.openFormF")}
                </button>
              )
              : null}
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

      <section className="space-y-2">
        {s === null
          ? null
          : s.studyInstanceUid !== null
          ? (
            <div className="space-y-1 text-sm" data-testid="study-uid-recorded">
              <p>{t("radiology.study.studyUidRecorded")}: <code>{s.studyInstanceUid}</code></p>
              <p className="flex items-center gap-2">
                <Button variant="outline" onClick={() => { open.mutate(); }}>{t("radiology.study.openImages")}</Button>
                <span data-testid="image-views">
                  {s.views.length === 0
                    ? t("radiology.study.imagesNeverOpened")
                    : t("radiology.study.imagesOpened", { count: s.views.length, by: s.views[0]!.viewerId })}
                </span>
              </p>
            </div>
          )
          : (
            <fieldset className="space-y-1 text-sm">
              <legend className="font-semibold">{t("radiology.study.imageSource")}</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="imageSource" value="pacs" checked={source === "pacs"}
                  onChange={() => { setSource("pacs"); }} />
                {t("radiology.study.sourcePacs")}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="imageSource" value="no_pacs_images" checked={source === "no_pacs_images"}
                  onChange={() => { setSource("no_pacs_images"); }} />
                {t("radiology.study.sourceNoImages")}
              </label>
              {source === "pacs"
                ? (
                  <label className="flex flex-col">
                    {t("radiology.study.studyUid")}
                    <input className="border px-2 py-1 font-mono" value={uid} aria-describedby="study-uid-hint"
                      onChange={(e) => { setTypedUid(e.target.value); }} />
                    <span id="study-uid-hint" className="text-xs text-slate-600">{t("radiology.study.studyUidHint")}</span>
                  </label>
                )
                : null}
            </fieldset>
          )}
        <div className="flex gap-2">
          <Button onClick={() => { start.mutate(); }}>{t("radiology.study.start")}</Button>
          <Button onClick={() => { acquire.mutate(); }}>{t("radiology.study.acquired")}</Button>
        </div>
      </section>
    </div>
  );
}
