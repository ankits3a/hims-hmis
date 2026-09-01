import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useParams } from "@tanstack/react-router";
import {
  fetchFormF, fetchStudy, openFormF, radiologyErrorText, recordFormF, verifyFormF,
} from "../lib/radiology-api";
import { Button } from "@/components/ui/button";

/**
 * PLAN 18a T9 — **FORM F: the statutory declaration, reached from a STUDY and never from a list.**
 *
 * ═══ THERE IS NO LIST SCREEN AND THERE IS NOT GOING TO BE ONE ═══
 *
 * `pcpndtManifest` declares NO menu entry, and this route takes a `$studyId`. The reason is in the
 * manifest in as many words: *"a list of Form F rows is a list of pregnant women by name, and the
 * one thing this register must not become is a searchable surface."* The inspection persona that
 * legitimately needs the register as a book is 18a-ii's, with its own permission and its own
 * certified print.
 *
 * ═══ THE NAME ON THIS PAGE IS THE REAL ONE, AND THE PAGE SAYS SO ═══
 *
 * Every other screen in this building renders a confidential patient through the alias. This one
 * does not, because a statutory declaration bearing a pseudonym is a FALSE declaration — and when
 * the patient IS flagged confidential the page states that the legal name is shown deliberately,
 * so nobody reads it as a leak and "fixes" it.
 */
export function PcpndtFormF(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { studyId } = useParams({ from: "/authed/pcpndt/form-f/$studyId" });
  const [error, setError] = useState<string | null>(null);
  const [indication, setIndication] = useState("");
  const [gestationWeeks, setGestationWeeks] = useState("");
  const [sectionF, setSectionF] = useState("");

  /**
   * ═══ F57 (CLOSE REVIEW) — THIS SCREEN COULD NOT OPEN A FORM F, AND IT WAS THE ONLY ONE ═══
   *
   * The Open button posted `{studyId, indicationCode, applicability, onDate}` — four fields — while
   * `openBody` requires `patientId`, `deviceResourceId` and `personUserId` as non-empty strings on
   * top of them. **Every click was a 400**, the screen collected none of the three, and there is no
   * other UI, no list screen and no other route. So the `form_f` gate could never leave `open`,
   * readiness never reached `ready`, and `startAcquisition` refused `not_ready`: F25's harm — every
   * PCPNDT-applicable scan unacquirable — reproduced one plane up, after `0050` fixed it at the
   * database.
   *
   * The two halves were each proved against a DIFFERENT body: `radiology.e2e.test.ts` posts the
   * correct seven fields by hand, and this screen's own test stubs only the GET and never clicks
   * Open. `openFormF(body: Record<string, unknown>)` erased the type that would have caught it at
   * compile time — so the wire function is typed now, and the screen reads the three facts off the
   * STUDY rather than asking a human to retype what the system already knows.
   */
  const study = useQuery({ queryKey: ["radiology", "study", studyId], queryFn: () => fetchStudy(studyId) });
  const q = useQuery({ queryKey: ["pcpndt", "form-f", studyId], queryFn: () => fetchFormF(studyId) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["pcpndt", "form-f", studyId] });
  const onError = (e: unknown) => { setError(radiologyErrorText(e)); };

  const s = study.data?.study ?? null;
  const open = useMutation({
    mutationFn: () => {
      if (s === null || s.deviceResourceId === null) {
        throw new Error(t("pcpndt.formF.notBookedYet"));
      }
      return openFormF({
        studyId,
        patientId: s.patientId,
        deviceResourceId: s.deviceResourceId,
        /**
         * `personUserId` is NOT sent: the server defaults Part H's performing person to the
         * authenticated actor. A console echoing back the id of the user already on the request is
         * a caller-supplied fact the server already holds — the shape F58 is about.
         */
        indicationCode: indication,
        applicability: "pregnant",
        /**
         * F52's sibling — `onDate` is NOT sent. It decides the SERIAL YEAR, and this screen used to
         * send `new Date().toISOString().slice(0,10)`: the browser's UTC day, which between 00:00
         * and 05:30 IST is YESTERDAY — so a 00:30 scan on 1 January minted a serial into the
         * previous year's book. The server derives it from its own IST clock.
         */
      });
    },
    onSuccess: () => { setError(null); void refresh(); }, onError,
  });
  const record = useMutation({
    mutationFn: (formFId: string) => recordFormF(formFId, {
      sections: { F: sectionF },
      declaration: { signature_kind: "signature" },
      referral: { self_referral: false },
      gestationWeeks: gestationWeeks === "" ? null : Number(gestationWeeks),
    }),
    onSuccess: () => { setError(null); void refresh(); }, onError,
  });
  const verify = useMutation({
    mutationFn: (formFId: string) => verifyFormF(formFId),
    onSuccess: () => { setError(null); void refresh(); }, onError,
  });

  const f = q.data?.form ?? null;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">{t("pcpndt.formF.title")}</h1>
      {error !== null ? <p role="alert" className="text-red-600">{error}</p> : null}

      {f === null
        ? (
          <section className="space-y-2">
            <p>{t("pcpndt.formF.none")}</p>
            <label className="flex flex-col text-sm">
              {t("pcpndt.formF.indication")}
              <input className="border px-2 py-1" value={indication}
                onChange={(e) => { setIndication(e.target.value); }} />
            </label>
            <Button onClick={() => { open.mutate(); }}>{t("pcpndt.formF.open")}</Button>
          </section>
        )
        : (
          <section className="space-y-2">
            <p data-testid="serial">
              {t("pcpndt.formF.serial", { no: f.serialNo, year: f.serialYear })} · {f.status}
            </p>
            <p data-testid="patient">{f.patientName} · {f.patientUhid}</p>
            {/** J1's split, stated on the page so nobody reads the legal name as a leak. */}
            {f.patientIsConfidential
              ? <p className="text-xs text-slate-600">{t("pcpndt.formF.realNameNotice")}</p>
              : null}
            <p className="text-sm">
              {f.machine.make} {f.machine.model} ({f.machine.serial}) · {f.person.qualification}
            </p>

            {f.status === "open"
              ? (
                <>
                  <label className="flex flex-col text-sm">
                    {t("pcpndt.formF.sectionF")}
                    <textarea className="border px-2 py-1" rows={3} value={sectionF}
                      onChange={(e) => { setSectionF(e.target.value); }} />
                  </label>
                  <label className="flex flex-col text-sm">
                    {t("pcpndt.formF.gestation")}
                    <input className="border px-2 py-1" type="number" value={gestationWeeks}
                      onChange={(e) => { setGestationWeeks(e.target.value); }} />
                  </label>
                  <Button onClick={() => { record.mutate(f.formFId); }}>{t("pcpndt.formF.record")}</Button>
                </>
              )
              : (
                <p role="status">{t("pcpndt.formF.recorded")}</p>
              )}

            {/** The in-charge counter-signs, and never the person who signed it (`same_actor`). */}
            {f.status === "recorded" && f.verifiedAt === null
              ? <Button variant="outline" onClick={() => { verify.mutate(f.formFId); }}>
                  {t("pcpndt.formF.verify")}
                </Button>
              : null}
            {f.verifiedAt !== null ? <p role="status">{t("pcpndt.formF.verified")}</p> : null}
          </section>
        )}
    </div>
  );
}
