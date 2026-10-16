import { desc, eq } from "drizzle-orm";
import { esiWord, proposeEsi } from "@hmis/contracts";
import { erEpisodes, erTriageEntries } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { requireErPermission, yearsOld } from "./core";
import { ErRefusal } from "./errors";
import { ER_TRIAGE } from "./names";
import type { Actor, ErAgeBand, ErEsiProposal, ErVitals } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ER lane 9 (#816) — THE TRIAGE PROPOSAL (spec §4.2, §4.9): the four ESI decision points answered from the complaint, the
 * age and the LAST vital set, with the reasons in words, and the level the algorithm gives for them. RULES, never a model
 * (autonomy ladder: "ESI level — T2 proposes, never auto-set"). A READ: nothing is written, no clock moves, no state
 * changes. The level exists only when a nurse or doctor taps Triage (`triage` / `re_triage`), and the screen sends the
 * proposal's level as `copilotLevel` so a different pick is logged as an override.
 */
export async function readEsiProposal(db: Db, actor: Actor, episodeId: string): Promise<ErEsiProposal> {
  await requireErPermission(db, actor, ER_TRIAGE);
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  const now = new Date();
  const [p] = await getPatientSummaries(db, actor, [e.patientId]);
  const ageYears = yearsOld(p?.dob ?? null, now);
  const vitalsRow = (await db.select({ vitals: erTriageEntries.vitals, takenAt: erTriageEntries.takenAt }).from(erTriageEntries)
    .where(eq(erTriageEntries.episodeId, e.id)).orderBy(desc(erTriageEntries.takenAt)).limit(10))
    .find((r) => r.vitals !== null && Object.keys(r.vitals).length > 0);
  const vitals = (vitalsRow?.vitals ?? null) as ErVitals | null;
  const proposal = proposeEsi({ complaint: e.complaint, ageYears, ageBand: (e.ageBand ?? null) as ErAgeBand | null, vitals });
  return {
    episodeId: e.id, level: proposal.level, word: esiWord(proposal.level), decision: proposal.decision, reasons: proposal.reasons,
    resourcesGuessed: proposal.resourcesGuessed,
    basedOn: { complaint: e.complaint, ageYears, vitalsAt: vitalsRow?.takenAt.toISOString() ?? null },
    source: "rules",
  };
}
