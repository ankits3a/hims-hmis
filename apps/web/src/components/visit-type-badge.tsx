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
  new: { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" },
  revisit: { background: "var(--green)", color: "#ffffff", borderColor: "var(--green)" },
  renewal: { background: "var(--gold-soft)", color: "var(--gold)", borderColor: "var(--gold)" },
};

export function VisitTypeBadge(
  { visitType, size = "lg", testId }: { visitType: string; size?: "lg" | "sm"; testId?: string },
): React.ReactElement {
  const { t } = useTranslation();
  const look = LOOK[visitType] ?? LOOK.new!;
  const big = size === "lg";
  return (
    <span
      data-testid={testId ?? "visit-type-badge"}
      data-visit-type={visitType}
      className="mo"
      style={{
        display: "inline-flex", alignItems: "center", height: big ? 24 : 19, padding: big ? "0 10px" : "0 6px",
        borderRadius: 4, border: "1.5px solid", fontSize: big ? 11.5 : 9.5, fontWeight: 700,
        letterSpacing: ".1em", textTransform: "uppercase", whiteSpace: "nowrap", ...look,
      }}
    >
      {t(`opd.visitType.${visitType}`)}
    </span>
  );
}
