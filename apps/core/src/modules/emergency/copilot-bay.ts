import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ER_AGE_BAND_INFO, ER_OPEN_STATES } from "@hmis/contracts";
import { erEpisodes, resources } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { requireErPermission, yearsOld } from "./core";
import { ErRefusal } from "./errors";
import { ER_TRIAGE } from "./names";
import type { Actor, ErAgeBand, ErBayProposal, ErBayZone } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { EpisodeRow } from "./core";

/**
 * #898 — THE BAY PROPOSAL (spec autonomy ladder: "Bay proposal — T2"; never resus, isolation). RULES, never a model, and
 * a READ: the copilot names one free bay, a person places the patient through `place_in_bay` (which re-checks everything
 * under the bed lock). The T3 climb for green-zone bays is not built.
 *
 * DECIDED (standard Indian corporate-hospital ER practice, lane 9 / #898):
 * - Only a TRIAGED patient with no bay, ESI 2–5. ESI 1 goes to resus, and a person puts them there: no proposal.
 * - The zone by acuity: ESI 2 → red (a monitored bay: equipment `monitor`), ESI 3 → yellow, ESI 4–5 → green. A child
 *   (under 14, IPD's paediatric limit; or a paediatric age band) is offered a paeds bay first, then the acuity zone; an
 *   adult or an unknown age is never offered a paeds bay.
 * - A bay's zone is read from the bay itself (`erZone` attribute, or a zone word in the bed's / room's code or name).
 *   FAIL CLOSED: a bay whose zone cannot be read, or reads two ways, is never proposed; any reading of resus or
 *   isolation wins over every other word. IPD attributes outrank words: isolation ≠ none or negative pressure = an
 *   isolation bay; ICU or `ventilator_ready` equipment = a resus-grade bay.
 * - Eligible: class `emergency` (surge / overflow beds are the duty manager's, not the copilot's), in service, available,
 *   no occupant, and the bay's gender rule fits (any, or the patient's own sex; `paediatric` = a child only).
 * - Among eligible bays of the first zone that has one: the lowest bed code (a stable, explainable pick).
 */
const ZONE_WORDS: [ErBayZone, RegExp][] = [
  ["resus", /\b(resus|resuscitation)\b/i],
  ["isolation", /\b(isolation|iso)\b/i],
  ["triage", /\btriage\b/i],
  ["observation", /\b(observation|obs)\b/i],
  ["paeds", /\b(paeds?|peds?|paediatrics?|pediatrics?|child(ren)?)\b/i],
  ["red", /\b(red|majors|acute)\b/i],
  ["yellow", /\b(yellow|intermediate)\b/i],
  ["green", /\b(green|minors|fast[ -]?track|ambulatory)\b/i],
];
const ZONE_SET = new Set<string>(ZONE_WORDS.map(([z]) => z));
const NEVER: ErBayZone[] = ["resus", "isolation"];
const NOT_A_DESTINATION: ErBayZone[] = ["triage", "observation"];
const ZONE_WORD: Record<ErBayZone, string> = {
  resus: "resus", isolation: "isolation", triage: "triage", observation: "observation", paeds: "paeds", red: "red", yellow: "yellow", green: "green",
};

type BayFacts = { code: string; name: string | null; roomCode: string | null; roomName: string | null; attributes: Record<string, unknown> | null };

/** What a bay is for, or null when it cannot be told (pure; the fail-closed rules above). */
export function erBayZone(b: BayFacts): ErBayZone | null {
  const a = b.attributes ?? {};
  const isolation = a.isolation;
  if ((typeof isolation === "string" && isolation !== "none") || a.negativePressure === true) return "isolation";
  if (a.icu === true || (Array.isArray(a.equipment) && a.equipment.includes("ventilator_ready"))) return "resus";
  const found = new Set<ErBayZone>();
  if (typeof a.erZone === "string") {
    const z = a.erZone.trim().toLowerCase();
    // An erZone the copilot does not know is a zone it cannot read: never proposed.
    if (!ZONE_SET.has(z)) return null;
    found.add(z as ErBayZone);
  }
  if (a.genderRule === "paediatric") found.add("paeds");
  for (const text of [b.code, b.name, b.roomCode, b.roomName]) {
    if (text === null || text === "") continue;
    const spaced = text.replace(/[-_./]+/g, " ");
    for (const [zone, re] of ZONE_WORDS) if (re.test(spaced)) found.add(zone);
  }
  for (const z of [...NEVER, ...NOT_A_DESTINATION]) if (found.has(z)) return z;
  return found.size === 1 ? [...found][0]! : null;
}

type Proposal = Omit<ErBayProposal, "episodeId" | "source">;
type Wanted = ErBayProposal["wanted"][number];

/**
 * The proposal for an episode as it stands. Shared by the read and by `place_in_bay`, which recomputes it to log whether
 * the person's pick was the copilot's (the T3 climb's future measure) — never trusting a value a client sent.
 */
export async function bayProposalOf(db: Db, actor: Actor, e: EpisodeRow, at: Date): Promise<Proposal> {
  const none = (why: ErBayProposal["none"], reasons: string[], wanted: Wanted[] = []): Proposal => ({ bay: null, none: why, wanted, reasons });
  if (!(ER_OPEN_STATES as readonly string[]).includes(e.state)) return none("closed", ["Patient has left the ER"]);
  if (e.bayId !== null) return none("in_bay", ["Already in a bay"]);
  if (e.esi === null) return none("not_triaged", ["Triage first"]);
  if (e.esi === 1) return none("esi_1", ["ESI 1 goes to resus: a person places"]);

  const [p] = await getPatientSummaries(db, actor, [e.patientId]);
  const ageYears = yearsOld(p?.dob ?? null, at);
  const band = (e.ageBand ?? null) as ErAgeBand | null;
  const child = ageYears !== null ? ageYears < 14 : band !== null ? ER_AGE_BAND_INFO[band].paediatric : false;
  const sex = p?.administrativeGender ?? null;
  const acuity: Wanted = e.esi === 2 ? "red" : e.esi === 3 ? "yellow" : "green";
  const wanted: Wanted[] = child ? ["paeds", acuity] : [acuity];
  const reasons = [`ESI ${String(e.esi)}: ${ZONE_WORD[acuity]} zone`];
  if (child) reasons.push("Child: paeds bay first");

  const beds = await db.select({
    id: resources.id, code: resources.code, name: resources.name, parentId: resources.parentId, attributes: resources.attributes,
  }).from(resources).where(and(
    eq(resources.kind, "bed"), eq(resources.status, "available"), isNull(resources.occupantRef),
    sql`${resources.attributes}->>'class' = 'emergency'`,
  ));
  const parentIds = [...new Set(beds.flatMap((b) => (b.parentId === null ? [] : [b.parentId])))];
  const rooms = new Map((parentIds.length === 0 ? [] : await db.select({ id: resources.id, code: resources.code, name: resources.name })
    .from(resources).where(inArray(resources.id, parentIds))).map((r) => [r.id, r] as const));

  const fits = beds.flatMap((b) => {
    const attrs = (b.attributes ?? null) as Record<string, unknown> | null;
    const room = b.parentId === null ? undefined : rooms.get(b.parentId);
    const zone = erBayZone({ code: b.code, name: b.name, roomCode: room?.code ?? null, roomName: room?.name ?? null, attributes: attrs });
    if (zone === null || !wanted.includes(zone as Wanted)) return [];
    const rule = attrs?.genderRule;
    if (rule === "paediatric" && !child) return [];
    if ((rule === "male" || rule === "female") && rule !== sex) return [];
    if (acuity === "red" && zone === "red" && !(Array.isArray(attrs?.equipment) && attrs.equipment.includes("monitor"))) return [];
    return [{ bedId: b.id, code: b.code, room: room?.name ?? null, zone: zone as Wanted }];
  });
  for (const z of wanted) {
    const pick = fits.filter((f) => f.zone === z).sort((x, y) => x.code.localeCompare(y.code))[0];
    // Belt and braces: the autonomy ladder's "never" is checked on the pick itself, whatever the classifier said.
    if (pick !== undefined && !NEVER.includes(pick.zone as ErBayZone)) {
      return { bay: pick, none: null, wanted, reasons: [...reasons, `${pick.code} is free (${ZONE_WORD[pick.zone]})`] };
    }
  }
  return none("no_bay", [...reasons, "No free bay in that zone"], wanted);
}

export async function readBayProposal(db: Db, actor: Actor, episodeId: string): Promise<ErBayProposal> {
  await requireErPermission(db, actor, ER_TRIAGE);
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  return { episodeId: e.id, ...(await bayProposalOf(db, actor, e, new Date())), source: "rules" };
}
