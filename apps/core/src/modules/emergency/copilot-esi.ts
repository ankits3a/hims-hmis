import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { ER_OPEN_STATES, erWithdrawText, esiWord, proposeEsi } from "@hmis/contracts";
import { erEpisodes, erTriageEntries, resources } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { requireErPermission, yearsOld } from "./core";
import { ErRefusal } from "./errors";
import { ER_TRIAGE } from "./names";
import type { Actor, ErAgeBand, ErEsiLevel, ErEsiProposal, ErEsiProposalCheck, ErProposalWithdrawReason, ErVitals, EsiProposal } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * ER lane 9 (#816) — THE TRIAGE PROPOSAL (spec §4.2, §4.9): the four ESI decision points answered from the complaint, the
 * age and the LAST vital set, with the reasons in words, and the level the algorithm gives for them. RULES, never a model
 * (autonomy ladder: "ESI level — T2 proposes, never auto-set"). A READ: nothing is written, no clock moves, no state
 * changes. The level exists only when a nurse or doctor taps Triage (`triage` / `re_triage`), which recompute the
 * proposal's level as `copilotLevel` so a different pick is logged as an override.
 */
/**
 * The proposal for an episode as it stands: its complaint, the patient's age (or the episode's age band) and the LAST
 * recorded vital set. Shared by the read and by `triage` / `re_triage`, which recompute it server-side so the override
 * they log never rests on a value a client sent (review #894).
 */
export async function esiProposalOf(db: Db, actor: Actor, e: EpisodeRow, at: Date): Promise<EsiProposal & { ageYears: number | null; vitalsAt: Date | null }> {
  const [p] = await getPatientSummaries(db, actor, [e.patientId]);
  const ageYears = yearsOld(p?.dob ?? null, at);
  const vitalsRow = (await db.select({ vitals: erTriageEntries.vitals, takenAt: erTriageEntries.takenAt }).from(erTriageEntries)
    .where(eq(erTriageEntries.episodeId, e.id)).orderBy(desc(erTriageEntries.takenAt)).limit(10))
    .find((r) => r.vitals !== null && Object.keys(r.vitals).length > 0);
  const vitals = (vitalsRow?.vitals ?? null) as ErVitals | null;
  const proposal = proposeEsi({ complaint: e.complaint, ageYears, ageBand: (e.ageBand ?? null) as ErAgeBand | null, vitals });
  return { ...proposal, ageYears, vitalsAt: vitalsRow?.takenAt ?? null };
}

export async function readEsiProposal(db: Db, actor: Actor, episodeId: string): Promise<ErEsiProposal> {
  await requireErPermission(db, actor, ER_TRIAGE);
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  // The entries BEFORE the proposal: a vital set landing between the two reads makes the basis older than the proposal,
  // which the check then withdraws ("New vitals") — the safe direction.
  const entries = await entriesOf(db, e.id);
  const proposal = await esiProposalOf(db, actor, e, new Date());
  return {
    episodeId: e.id, level: proposal.level, word: esiWord(proposal.level), decision: proposal.decision, reasons: proposal.reasons,
    resourcesGuessed: proposal.resourcesGuessed,
    basedOn: { complaint: e.complaint, ageYears: proposal.ageYears, vitalsAt: proposal.vitalsAt?.toISOString() ?? null },
    source: "rules",
    basis: basisOf(entries[0]?.id ?? null, e.bayId, digestOf(e.complaint, proposal)),
  };
}

/* ═══════════════════ #899 — a shown proposal withdraws itself (spec §6 edge 1) ═══════════════════ */

/**
 * The proposal's identity, with no table of its own: the ids of the rows it was read from (the episode's latest triage
 * entry of any kind — triage, re-triage, vital set — and its bay) plus a digest of what it said. Every input of
 * `esiProposalOf` is either one of those rows or in the digest (complaint, age, reasons), so a basis that still matches
 * is a proposal the server would show again. No migration: `er_triage_entries` and `er_episodes` already carry it.
 */
const BASIS_VERSION = "v1";
const NONE = "-";

function digestOf(complaint: string | null, p: EsiProposal & { ageYears: number | null }): string {
  return createHash("sha256").update(JSON.stringify([complaint, p.ageYears, p.level, p.decision, p.reasons])).digest("hex").slice(0, 16);
}
function basisOf(entryId: string | null, bayId: string | null, digest: string): string {
  return [BASIS_VERSION, entryId ?? NONE, bayId ?? NONE, digest].join(".");
}
function parseBasis(raw: string): { entryId: string | null; bayId: string | null; digest: string } | null {
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== BASIS_VERSION || parts.some((x) => x.length === 0)) return null;
  return { entryId: parts[1] === NONE ? null : parts[1]!, bayId: parts[2] === NONE ? null : parts[2]!, digest: parts[3]! };
}

type EntryRow = { id: string; kind: string; level: number | null; recordedAt: Date; takenAt: Date };
/** Newest first; the same order the basis names its "latest" by (ties broken by id, so it is one row). */
async function entriesOf(db: Db, episodeId: string): Promise<EntryRow[]> {
  return db.select({ id: erTriageEntries.id, kind: erTriageEntries.kind, level: erTriageEntries.level, recordedAt: erTriageEntries.recordedAt, takenAt: erTriageEntries.takenAt })
    .from(erTriageEntries).where(eq(erTriageEntries.episodeId, episodeId))
    .orderBy(desc(erTriageEntries.recordedAt), desc(erTriageEntries.id));
}

/**
 * Does the proposal a screen is showing (its `basis`) still stand? Fail closed: a basis the server cannot read, or one
 * naming an entry this episode does not have, is withdrawn as "out of date" — never reported current. The first reason
 * that applies wins: left the ER, a person triaged / re-triaged, moved bay, new vitals, complaint or age changed.
 */
export async function checkEsiProposal(db: Db, actor: Actor, episodeId: string, basisRaw: string): Promise<ErEsiProposalCheck> {
  await requireErPermission(db, actor, ER_TRIAGE);
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  const waiting = e.state === "arrived";
  const out = (reason: ErProposalWithdrawReason, at: Date | null, extra: { level?: number | null; bayCode?: string | null; fresh: boolean }): ErEsiProposalCheck => {
    const w = { reason, at: at?.toISOString() ?? null, level: (extra.level ?? null) as ErEsiLevel | null, bayCode: extra.bayCode ?? null };
    return { episodeId: e.id, current: false, withdrawn: { ...w, text: erWithdrawText(w), fresh: extra.fresh } };
  };
  const shown = parseBasis(basisRaw);
  if (shown === null) return out("out_of_date", null, { fresh: waiting });
  if (!(ER_OPEN_STATES as readonly string[]).includes(e.state)) return out("departed", e.departedAt, { fresh: false });

  const entries = await entriesOf(db, e.id);
  let newer: EntryRow[];
  if (shown.entryId === null) newer = entries;
  else {
    const i = entries.findIndex((r) => r.id === shown.entryId);
    if (i < 0) return out("out_of_date", null, { fresh: waiting });
    newer = entries.slice(0, i);
  }
  const graded = newer.find((r) => r.kind === "triage" || r.kind === "re_triage");
  if (graded !== undefined) return out(graded.kind === "triage" ? "triaged" : "re_triaged", graded.recordedAt, { level: graded.level, fresh: false });
  if ((e.bayId ?? null) !== shown.bayId) {
    const code = e.bayId === null ? null : (await db.select({ code: resources.code }).from(resources).where(eq(resources.id, e.bayId)))[0]?.code ?? null;
    return out("moved", null, { bayCode: code, fresh: waiting });
  }
  const vitals = newer.find((r) => r.kind === "vitals");
  if (vitals !== undefined) return out("new_vitals", vitals.takenAt, { fresh: waiting });
  const now = await esiProposalOf(db, actor, e, new Date());
  if (digestOf(e.complaint, now) !== shown.digest) return out("details_changed", null, { fresh: waiting });
  return { episodeId: e.id, current: true, withdrawn: null };
}
