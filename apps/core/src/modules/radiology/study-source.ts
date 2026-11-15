import { EPISODE_SERIES } from "../../kernel/episodes/series";

/**
 * #1077 — **WHERE A STUDY CAME FROM: ONE RULE.** The metrics read (`metrics.ts`), the north star
 * (`north-star.ts`), the HOD's turnaround and money (`supervisor.ts`) and the reading clock
 * (`reading.ts` `tatClassOf`) all answer it here. It used to be answered three ways — the metrics
 * by the `V` prefix, the north star by `D`, bedside and STAT, the clock by bedside alone — and the
 * HOD's two number screens disagreed about the same day.
 *
 * First match wins:
 *   · `walk_in` — the order came on an outside prescription or the patient's own request
 *     (`authority` `external_prescription` / `self`): no in-house treating doctor;
 *   · `daycare` — a day-care encounter (`D…`, `EPISODE_SERIES.daycare`);
 *   · `ipd` — the machine went to a bedside, or the encounter is neither an OPD visit nor day care;
 *   · `opd` — an OPD visit (`V…`) otherwise.
 *
 * DECIDED (spec #1077): `er` is not a source until the emergency module is on `main`. STAT is a
 * PRIORITY, not a place — a STAT order from an OPD visit is an OPD study whose clock is STAT's.
 */
export const STUDY_SOURCES = ["opd", "ipd", "daycare", "walk_in"] as const;
export type StudySource = (typeof STUDY_SOURCES)[number];

export function studySource(
  study: { encounterNo: string; bedsideLocation: string | null },
  order: { authority: string },
): StudySource {
  if (order.authority === "external_prescription" || order.authority === "self") return "walk_in";
  if (study.encounterNo.startsWith(EPISODE_SERIES.daycare)) return "daycare";
  if (study.bedsideLocation !== null && study.bedsideLocation.trim() !== "") return "ipd";
  if (!study.encounterNo.startsWith(EPISODE_SERIES.visit)) return "ipd";
  return "opd";
}
