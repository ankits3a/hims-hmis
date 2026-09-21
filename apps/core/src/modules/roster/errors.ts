/**
 * PHASE R (R1) — what the roster refuses, and why each refusal exists.
 *
 * ═══ ONE CODE PER CAUSE (plan §4 R1) ═══
 *
 * Plan 20 T1 had a single `not_permitted` carrying two unrelated causes: *"you are not the kind of
 * thing that may do this"* (a machine tried to publish) and *"you are a person and you do not hold
 * the grant"*. A client cannot tell those apart, and they need opposite handling — the first is a
 * bug in the caller, the second is an access request. They are two codes here.
 *
 * ═══ THE CODE IS FOR THE CLIENT; THE SENTENCE IS FOR THE HUMAN (V10) ═══
 *
 * Every message is written to be READ BY THE PERSON WHO MADE THE ROSTER (owner ruling RU-6: *"smooth
 * and frictionless and lower learning curve"*) — it names the person, the window and the thing to do
 * about it. Two mechanical rules the test enforces, because prose drifts and a test does not:
 *
 *   · every code has a fallback sentence, so a client that cannot render `params` still says
 *     something a human can act on;
 *   · **no instant is ever formatted into a message as a UTC ISO string.** A refusal that says
 *     "20:00Z" to somebody standing in a ward in Patna at 01:30 is a refusal they will misread.
 *     Instants travel in `params` and are rendered in IST by whoever displays them.
 */
export const ROSTER_ERROR_CODES = [
  /** A PERSON who does not hold the grant this act needs. The answer is to ask for the grant. */
  "not_permitted",
  /**
   * The actor is not a KIND of thing that may ever do this — a machine proposer asked to publish,
   * a copilot asked to override a rule. `rosterActPolicy` is the only thrower (stress test §4).
   */
  "act_not_available_to_actor",
  "unknown_department",
  "unknown_position",

  /* ── PHASE R (R2) — drafting, filling and publishing a period ── */
  "unknown_period",
  "unknown_assignment",
  "unknown_user",
  "unknown_location",
  "invalid_window",
  "outside_period",
  "position_not_covered",
  "position_ineligible",
  "period_not_draft",
  "period_not_published",
  "empty_period",
  "presence_overlap",
  "published_period_overlap",
  "version_conflict",
  /** V3 — the lost update of stress test S2(a), turned into a refusal a human can act on. */
  "stale_base",
  /** V4 — what the human reviewed is not what is about to go live. */
  "draft_changed_since_review",
] as const;

export type RosterErrorCode = (typeof ROSTER_ERROR_CODES)[number];

/**
 * The sentence shown when a client has no rendering of its own. It must stand alone: no `params`
 * interpolated, no instant, no name — those are in `detail` and are the client's to render.
 */
export const ROSTER_ERROR_SENTENCES: Record<RosterErrorCode, string> = {
  not_permitted:
    "you do not hold the permission this needs — the medical superintendent's office grants it",
  act_not_available_to_actor:
    "this act is only ever done by a person: publishing, approving and overriding a roster name who answers for patients, and no assistant, agent or scheduled job may do them",
  unknown_department: "that department is not on the hospital's list",
  unknown_position: "that duty position is not one this hospital rosters",

  unknown_period: "there is no roster by that name",
  unknown_assignment: "there is no such duty on this roster",
  unknown_user: "there is no member of staff by that name, or they no longer work here",
  unknown_location: "there is no such ward, theatre or room",
  invalid_window: "the start and the end of that duty do not make a window a person could work",
  outside_period: "that duty starts outside the stretch this roster covers",
  position_not_covered: "this roster does not answer for that duty position — say so on the roster first, or put the duty on the roster that does",
  position_ineligible: "that person does not hold the role this position needs, so they cannot be put on it",
  period_not_draft: "a roster people are working to is never edited — draft a new version from it, or amend it",
  period_not_published: "only a roster that is live can be amended; a draft is edited and then published",
  empty_period: "there is nobody on this roster, so publishing it would make the hospital's answer to \"who is on?\" — nobody",
  presence_overlap: "somebody on this roster would have to be in two places at once — on call may overlap a duty, two duties in person may not",
  published_period_overlap: "another roster is already live for this same scope over part of the same stretch",
  version_conflict: "somebody else drafted the next version of this roster a moment ago — open theirs",
  stale_base: "this draft was made from a version that is no longer the live one, so publishing it would silently undo whatever changed in between — draft again from the version that is live now",
  draft_changed_since_review: "this roster has changed since it was put in front of you — read it again before publishing it",
};

export class RosterError extends Error {
  constructor(
    readonly code: RosterErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? ROSTER_ERROR_SENTENCES[code]);
    this.name = "RosterError";
  }
}

const STATUS: Record<RosterErrorCode, number> = {
  not_permitted: 403,
  act_not_available_to_actor: 403,

  unknown_department: 404,
  unknown_position: 404,
  unknown_period: 404,
  unknown_assignment: 404,
  unknown_user: 404,
  unknown_location: 404,

  invalid_window: 422,
  outside_period: 422,
  empty_period: 422,
  position_not_covered: 422,

  period_not_draft: 409,
  period_not_published: 409,
  position_ineligible: 409,
  presence_overlap: 409,
  published_period_overlap: 409,
  version_conflict: 409,
  stale_base: 409,
  draft_changed_since_review: 409,
};

export function rosterHttpStatus(code: RosterErrorCode): number {
  return STATUS[code];
}
