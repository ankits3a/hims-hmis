import { searchPatients } from "./search";
import type { MatchLane } from "./search";
import type { RegisterPatientInput } from "./registration";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ THE NEAR-MATCH PROBE, LIFTED OUT OF THE WALK-IN ═══
 *
 * It lived in `opd/walk-in.ts` because that was the only route that could create a patient at the
 * counter. FD-8 moves registration to END AT THE UHID — the owner's ruling, and Desk One's own
 * shape — which makes `POST /patients` a counter act, and that route had NO duplicate check at all.
 * Leaving the probe in the walk-in would have made "register, then seat" quietly weaker than the
 * one-shot walk-in it replaces, losing the very warning FD-7 T1 had just made readable.
 *
 * So it lives in the PATIENTS module, beside the thing it protects, and both callers share it.
 * Behaviour is unchanged from T1, including the union across probes.
 */
export type DuplicateCandidate = {
  id: string;
  uhid: string;
  name: string | null;
  phone: string | null;
  administrativeGender: string;
  dob: Date | null;
  isConfidential: boolean;
  matchedOn: MatchLane[];
};

/**
 * It reuses `searchPatients` rather than inventing a matcher: that function already carries the
 * phone/UHID/name lanes and the trigram fallback the desk searches with, so the candidates a clerk
 * is warned about are exactly the ones they would have found by searching — which is the whole
 * point of warning them.
 *
 * `duplicate_candidates` as a TABLE belongs to Plan 22, and this deliberately does not build one.
 */
export async function nearMatches(
  db: Db,
  actor: Actor,
  input: Pick<RegisterPatientInput, "name" | "phone">,
): Promise<DuplicateCandidate[]> {
  const probes = [input.phone, input.name].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const seen = new Map<string, DuplicateCandidate>();
  for (const probe of probes) {
    for (const hit of await searchPatients(db, actor, probe, 5)) {
      /*
       * FD-7 T1 — THE LANES ARE UNIONED ACROSS PROBES, NOT OVERWRITTEN.
       *
       * Each `searchPatients` call reports only the lanes ITS OWN query fired. A bare `set` kept
       * whichever probe ran LAST, so the person who matches on both — the likeliest duplicate in the
       * list, and the only one the clerk should hesitate over — was labelled "same name" and never
       * "same mobile". The stronger signal was the one being dropped.
       */
      const before = seen.get(hit.id);
      seen.set(hit.id, {
        id: hit.id, uhid: hit.uhid, name: hit.name, phone: hit.phone,
        administrativeGender: hit.administrativeGender, dob: hit.dob,
        isConfidential: hit.isConfidential,
        matchedOn: [...new Set([...(before?.matchedOn ?? []), ...hit.matchedOn])],
      });
    }
  }
  return [...seen.values()];
}
