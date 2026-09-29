/**
 * ═══ THE IAP IMMUNISATION TIMETABLE 2023 — VACCINES FOR ROUTINE USE ═══
 *
 * SOURCE — Rao ISM, Kasi SG, Dhir SK, Wadhwa A, Rajsekhar B, Kumar CM, et al. Indian Academy of
 * Pediatrics (IAP) Advisory Committee on Vaccines and Immunization Practices (ACVIP): Recommended
 * Immunization Schedule (2023) and Update on Immunization for Children Aged 0 Through 18 Years.
 * Indian Pediatr. 2024;61:113-125. https://doi.org/10.1007/s13312-024-3104-5
 * (e-pub: https://indianpediatrics.net/epub012024/FTA-00592.pdf) — TABLE I "IAP-ACVIP Immunization
 * Timetable 2023: Vaccines for Routine Use" and the footnotes a–k of Fig. 1. Transcribed row by row:
 * every age below is the table's own; every `note` is the table's comment or footnote, shortened.
 * Fig. 1's special-situation vaccines (meningococcal, JE, cholera, rabies, yellow fever, PPSV23)
 * are NOT routine and are not here.
 *
 * THE NATIONAL PROGRAMME (UIP), where it differs — `uip` on a dose. SOURCE: Ministry of Health and
 * Family Welfare, National Health Mission. National Immunization Schedule (NIS) for Infants,
 * Children and Pregnant Women.
 * https://nhm.gov.in/New_Updates_2018/NHM_Components/Immunization/report/National_%20Immunization_Schedule.pdf
 * That document is the NHM's published copy; later MoHFW circulars (for example a third fIPV dose,
 * PCV beyond the listed states) must be checked against the current NIS before a `uip` line is
 * relied on. A `uip` line is a NOTE for the doctor; it changes no status.
 *
 * DECIDED 2026-09-28 (planner; standard Indian corporate-hospital practice, 01-CONSULT-ENGINE.md
 * §6.2 — the owner may overturn):
 *   · A dose is DUE from its age in the table. It is OVERDUE from the end of the table's range
 *     (`overdueFrom`: "16-18 mo" is overdue at 19 completed months), and for a single age — "6 wk",
 *     "9 mo" — four weeks after it. The four weeks is the usual reminder window of a hospital
 *     vaccination desk, not an IAP number; it is the only number here that is not the table's.
 *   · A dose the table calls permissible rather than needed (Hep B-4 inside a combination vaccine)
 *     is `optional`: shown, never due or overdue.
 *   · Annual influenza after the first two doses, and the 3-dose HPV course, are modelled as the
 *     table words them; nothing is invented to fill a gap.
 */

/** An age from date of birth, in the table's own unit. */
export type AgeSpec = { w: number } | { m: number } | { y: number };
export type DoseDef = {
  id: string;
  /** The vaccine family, for grouping (one card row per family). */
  vaccine: string;
  /** How the table names this dose. */
  label: string;
  /** The table's age. */
  at: AgeSpec;
  /** The table's range end, as the first age at which the dose is OVERDUE. Absent: `at` + 4 weeks. */
  overdueFrom?: AgeSpec;
  /** Due only after an earlier dose was given, and this long after it. */
  after?: { dose: string; months: number; monthsIfStartedAt15?: number };
  /** HPV: the 3rd dose exists only when the course began at 15 years or later (footnote k). */
  onlyIfStartedAtOrAfterYears?: { dose: string; years: number };
  optional?: boolean;
  note?: string;
  uip?: string;
};

const W = (w: number): AgeSpec => ({ w });
const M = (m: number): AgeSpec => ({ m });
const Y = (y: number): AgeSpec => ({ y });

export const IAP_2023_SOURCE = "IAP-ACVIP Immunization Timetable 2023 (Indian Pediatr 2024;61:113-125, Table I)";

export const IAP_2023_DOSES: readonly DoseDef[] = [
  // Birth
  { id: "bcg", vaccine: "BCG", label: "BCG", at: W(0), note: "Before discharge.", uip: "UIP: at birth or as early as possible till one year of age." },
  { id: "opv-0", vaccine: "OPV", label: "OPV-0", at: W(0), note: "As soon as possible after birth.", uip: "UIP: within the first 15 days." },
  { id: "hepb-1", vaccine: "Hepatitis B", label: "Hep B-1", at: W(0), note: "Within 24 hours of birth; if missed, at first contact (footnote a)." },
  // 6 weeks
  { id: "dtp-1", vaccine: "DTwP/DTaP", label: "DTwP/DTaP-1", at: W(6), uip: "UIP: as Pentavalent-1 (DTwP-HepB-Hib), with OPV-1." },
  { id: "ipv-1", vaccine: "IPV", label: "IPV-1", at: W(6), note: "6-10-14 wk is the recommended IPV schedule; may be part of a combination vaccine.", uip: "UIP: fractional IPV (intradermal) at 6 and 14 weeks only." },
  { id: "hib-1", vaccine: "Hib", label: "Hib-1", at: W(6) },
  { id: "hepb-2", vaccine: "Hepatitis B", label: "Hep B-2", at: W(6) },
  { id: "rota-1", vaccine: "Rotavirus", label: "Rotavirus-1", at: W(6) },
  { id: "pcv-1", vaccine: "PCV", label: "PCV-1", at: W(6), uip: "UIP: PCV at 6 and 14 weeks, booster at 9-12 months." },
  // 10 weeks
  { id: "dtp-2", vaccine: "DTwP/DTaP", label: "DTwP/DTaP-2", at: W(10), uip: "UIP: as Pentavalent-2, with OPV-2." },
  { id: "ipv-2", vaccine: "IPV", label: "IPV-2", at: W(10), uip: "UIP: no IPV dose at 10 weeks." },
  { id: "hib-2", vaccine: "Hib", label: "Hib-2", at: W(10) },
  { id: "hepb-3", vaccine: "Hepatitis B", label: "Hep B-3", at: W(10) },
  { id: "rota-2", vaccine: "Rotavirus", label: "Rotavirus-2", at: W(10) },
  { id: "pcv-2", vaccine: "PCV", label: "PCV-2", at: W(10), uip: "UIP: no PCV dose at 10 weeks." },
  // 14 weeks
  { id: "dtp-3", vaccine: "DTwP/DTaP", label: "DTwP/DTaP-3", at: W(14), uip: "UIP: as Pentavalent-3, with OPV-3." },
  { id: "ipv-3", vaccine: "IPV", label: "IPV-3", at: W(14) },
  { id: "hib-3", vaccine: "Hib", label: "Hib-3", at: W(14) },
  { id: "hepb-4", vaccine: "Hepatitis B", label: "Hep B-4", at: W(14), optional: true, note: "An additional 4th dose is safe and permitted as a component of a combination vaccine (footnote b)." },
  { id: "rota-3", vaccine: "Rotavirus", label: "Rotavirus-3", at: W(14), note: "Not needed after RV1 (GSK), a 2-dose vaccine (footnote d)." },
  { id: "pcv-3", vaccine: "PCV", label: "PCV-3", at: W(14) },
  // Infancy
  { id: "iiv-1", vaccine: "Influenza", label: "Influenza (IIV)-1", at: M(6), note: "Two doses 4 weeks apart, then yearly (pre-monsoon) till 5 years (footnote e)." },
  { id: "iiv-2", vaccine: "Influenza", label: "Influenza (IIV)-2", at: M(7), note: "Then repeat every year till 5 years of age." },
  { id: "tcv", vaccine: "Typhoid conjugate", label: "Typhoid conjugate", at: M(6), overdueFrom: M(10), note: "6-9 months; no booster is recommended." },
  { id: "mmr-1", vaccine: "MMR", label: "MMR-1", at: M(9), uip: "UIP: MR-1 (measles-rubella) at 9-12 months; JE-1 in endemic districts." },
  { id: "hepa-1", vaccine: "Hepatitis A", label: "Hepatitis A-1", at: M(12), note: "A single dose for the live attenuated vaccine (footnote f)." },
  { id: "mmr-2", vaccine: "MMR", label: "MMR-2", at: M(15), uip: "UIP: MR-2 at 16-24 months." },
  { id: "var-1", vaccine: "Varicella", label: "Varicella-1", at: M(15) },
  { id: "pcv-b", vaccine: "PCV", label: "PCV booster", at: M(15) },
  { id: "dtp-b1", vaccine: "DTwP/DTaP", label: "DTwP/DTaP-B1", at: M(16), overdueFrom: M(19), uip: "UIP: DPT booster-1 and OPV booster at 16-24 months." },
  { id: "hib-b1", vaccine: "Hib", label: "Hib-B1", at: M(16), overdueFrom: M(19) },
  { id: "ipv-b1", vaccine: "IPV", label: "IPV-B1", at: M(16), overdueFrom: M(19) },
  { id: "hepa-2", vaccine: "Hepatitis A", label: "Hepatitis A-2", at: M(18), overdueFrom: M(20), note: "Only for the inactivated hepatitis A vaccine." },
  { id: "var-2", vaccine: "Varicella", label: "Varicella-2", at: M(18), overdueFrom: M(20), note: "3-6 months after dose 1 (footnote g)." },
  // School age
  { id: "dtp-b2", vaccine: "DTwP/DTaP", label: "DTwP/DTaP-B2", at: Y(4), overdueFrom: Y(7), note: "Not Tdap (footnote h).", uip: "UIP: DPT booster-2 at 5-6 years." },
  { id: "ipv-b2", vaccine: "IPV", label: "IPV-B2", at: Y(4), overdueFrom: Y(7) },
  { id: "mmr-3", vaccine: "MMR", label: "MMR-3", at: Y(4), overdueFrom: Y(7) },
  // Adolescence
  { id: "hpv-1", vaccine: "HPV", label: "HPV-1", at: Y(9), overdueFrom: Y(15), note: "9-14 years: 2 doses, 6 months apart (footnote i). From 15 years: 3 doses, 0-2-6 months (footnote k)." },
  { id: "hpv-2", vaccine: "HPV", label: "HPV-2", at: Y(9), after: { dose: "hpv-1", months: 6, monthsIfStartedAt15: 2 } },
  { id: "hpv-3", vaccine: "HPV", label: "HPV-3", at: Y(15), after: { dose: "hpv-1", months: 6 }, onlyIfStartedAtOrAfterYears: { dose: "hpv-1", years: 15 }, note: "Only when the course began at 15 years or later (footnote k)." },
  { id: "tdap", vaccine: "Tdap", label: "Tdap", at: Y(10), note: "Given even if Tdap was given as DTP-B2; not needed if Tdap was given at 9 years or later (footnote h).", uip: "UIP: Td at 10 years." },
  { id: "td", vaccine: "Td", label: "Td", at: Y(16), overdueFrom: Y(19), uip: "UIP: Td at 16 years." },
];

/** The injection sites a vaccination card records. */
export const VACCINE_SITES = [
  "left_thigh", "right_thigh", "left_deltoid", "right_deltoid", "left_upper_arm", "right_upper_arm", "oral",
] as const;
