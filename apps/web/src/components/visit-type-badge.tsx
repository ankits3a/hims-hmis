import { useTranslation } from "react-i18next";

/**
 * ═══ NEW, REVISIT OR RENEWAL — A DOCTOR MUST NOT MISS IT (owner, 2026-09-23) ═══
 *
 * *"If the patient is revisit, new, renew then clearly mention it so that doctor could not miss it
 * in the brief as well as during the consultation."* It was a plain green pill on the banner, the
 * same pill every other mark wears, and nothing on the queue row.
 *
 * THREE COLOURS FOR THREE DIFFERENT FACTS, and none of them red — red is danger on this screen and
 * a visit type is not one:
 *  · NEW — solid ink: a first meeting, the whole history is to be taken.
 *  · REVISIT — green: a free follow-up inside the window; the last note is the context.
 *  · RENEWAL — gold: the window lapsed and the fee was due again; worth knowing before you ask why.
 *
 * The label is the same `opd.visitType.*` string the desk and the report use, so the counter and
 * the consulting room cannot call the same visit two different things.
 */
const LOOK: Record<string, React.CSSProperties> = {
  /* The Consult Engine boards' colours, approved by the owner 2026-09-23: NEW green, REVISIT ink, RENEWAL gold. */
  new: { background: "var(--green)", color: "#ffffff", borderColor: "var(--green)" },
  revisit: { background: "var(--ink)", color: "#ffffff", borderColor: "var(--ink)" },
  renewal: { background: "var(--gold)", color: "#ffffff", borderColor: "var(--gold)" },
  /* A first meeting like NEW — the history is to be taken — outlined because it is free (owner ruling 2026-09-24). */
  referral: { background: "#ffffff", color: "var(--green)", borderColor: "var(--green)" },
};

/**
 * OWNER RULING 2026-09-24 — a visit an internal referral opened is FREE, so the server stamps it
 * `revisit`; the doctor it was sent to has never seen the patient, and REVISIT would tell them the
 * last note is the context. So it is shown as REFERRAL. Only while it is still `revisit`: a visit
 * the desk reclassified shows what the desk made it.
 */
export function shownVisitType(e: { visitType: string; referredFromEncounterId?: string | null }): string {
  return e.visitType === "revisit" && e.referredFromEncounterId != null ? "referral" : e.visitType;
}

export function VisitTypeBadge(
  { visitType, size = "lg", testId }: { visitType: string; size?: "xl" | "lg" | "sm"; testId?: string },
): React.ReactElement {
  const { t } = useTranslation();
  const look = LOOK[visitType] ?? LOOK.new!;
  const big = size !== "sm";
  const xl = size === "xl";
  return (
    <span
      data-testid={testId ?? "visit-type-badge"}
      data-visit-type={visitType}
      className="mo"
      style={{
        display: "inline-flex", alignItems: "center", height: xl ? 34 : big ? 24 : 19, padding: xl ? "0 14px" : big ? "0 10px" : "0 6px",
        borderRadius: xl ? 6 : 4, border: "1.5px solid", fontSize: xl ? 13 : big ? 11.5 : 9.5, fontWeight: 700,
        letterSpacing: ".1em", textTransform: "uppercase", whiteSpace: "nowrap", ...look,
      }}
    >
      {t(`opd.visitType.${visitType}`)}
    </span>
  );
}
