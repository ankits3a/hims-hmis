import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { usePatientInHand } from "../lib/patient-in-hand";
import { Button } from "@/components/ui/button";

/**
 * PLAN 07b T1 — THE PATIENT IN HAND, ON EVERY SCREEN.
 *
 * The strip exists so a clerk never has to find the same person twice. It reads ONLY the ids the
 * context holds and resolves everything live, which is what keeps a merged patient from lingering
 * on the chrome of every screen under a name that no longer belongs to them.
 *
 * ═══ IT ALIASES A CONFIDENTIAL PATIENT EVEN FOR SOMEBODY WHO MAY SEE THE NAME ═══
 *
 * This is the one place the usual rule is deliberately stricter. Elsewhere a holder of
 * `patients.confidential.read` sees the real name, and that is correct — they opened the record on
 * purpose. But this strip is pinned to EVERY screen for as long as the patient is in hand: it is on
 * the display while the clerk turns to a queue board, while a visitor leans over the counter, while
 * the screen is projected in a ward round. A VIP's name does not belong on furniture. The alias is
 * enough to know who is in hand, which is all the strip is for.
 *
 * A sealed record the caller may NOT read answers 404 — indistinguishable from a missing patient by
 * design (07a DD2) — and the strip says so plainly rather than rendering an empty shell that looks
 * like a loading state that never finishes.
 */
type StripPatient = {
  id: string; uhid: string; name: string | null; sex: string;
  isConfidential: boolean; alias: string | null;
};

export function PatientStrip(): React.ReactElement | null {
  const { t } = useTranslation();
  const { inHand, release } = usePatientInHand();
  const patientId = inHand?.patientId ?? "";

  const patient = useQuery({
    queryKey: ["patient-in-hand", patientId],
    queryFn: () => api<{ patient: StripPatient }>("GET", `/patients/${patientId}`),
    enabled: patientId !== "",
    retry: false,
  });

  if (inHand === null) return null;

  const restricted = patient.isError && patient.error instanceof ApiError && patient.error.status === 404;
  const row = patient.data?.patient;
  /**
   * LOADING IS NOT "RESTRICTED". The first version collapsed both into one label, so for the few
   * hundred milliseconds before the query resolved, EVERY patient in hand was announced as a
   * restricted record — on a strip pinned to every screen. A clerk who learns that the label lies
   * while it settles stops reading it, which costs more than the strip gains. Three states, named.
   */
  const label = patient.isPending
    ? t("patientStrip.loading")
    : restricted || row === undefined
      ? t("patientStrip.restricted")
      : row.isConfidential
        ? (row.alias ?? t("patientStrip.restricted"))
        : (row.name ?? t("patientStrip.restricted"));

  return (
    <div
      data-testid="patient-strip"
      className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-blue-50 px-4 py-1.5 text-sm"
    >
      <span className="font-semibold" data-testid="strip-label">{label}</span>
      {row !== undefined && !restricted && (
        <>
          <span className="text-neutral-600" data-testid="strip-uhid">{row.uhid}</span>
          <span className="text-neutral-600">{t(`sex.${row.sex}`, row.sex)}</span>
        </>
      )}
      {inHand.encounterId !== null && (
        <span className="text-neutral-600" data-testid="strip-visit">{t("patientStrip.visitOpen")}</span>
      )}
      <span className="text-neutral-500">{t("patientStrip.inHand")}</span>
      <Button
        variant="ghost"
        size="xs"
        className="ml-auto"
        data-testid="strip-release"
        onClick={release}
      >
        {t("patientStrip.release")}
      </Button>
    </div>
  );
}
