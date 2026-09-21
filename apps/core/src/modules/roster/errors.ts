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

  /* ── PHASE R (R3) — teams, the people in them, and who stands in ── */
  "unknown_team",
  "unknown_membership",
  "duplicate_team_code",
  "parent_membership_overlap",
  "head_already_held",
  "officiating_overlap",
  "delegation_not_held",
  "intern_plan_invalid",

  /* ── PHASE R (R4) — being away, and what you hold ── */
  "unknown_absence",
  "unknown_absence_kind",
  "absence_already_decided",
  "absence_self_approval",
  "unknown_credential",

  /* ── PHASE R (R6) — where an escalation goes ── */
  "unknown_escalation_kind",
  "unknown_role",

  /* ── PHASE R (R7) — the calendar ── */
  "unknown_cycle",
  "cycle_not_draft",
  "empty_cycle",
  "unknown_template",
  "template_needs_more_units",

  /* ── PHASE R (R8) — whether the roster is any good ── */
  /**
   * The ONE refusal the validator can produce. Deliberately not "rule violated": a roster may
   * carry a dozen findings and still publish, because a warn is something a named human accepts
   * with a reason. This fires only for a `block` nobody has accepted, and its `detail` carries
   * every such code, so a head is told all of them at once rather than one per attempt.
   */
  "blocked_by_findings",
  "unknown_rule",
  "unknown_finding",
  "finding_already_accepted",
  "unknown_mode_declaration",
  "mode_already_withdrawn",
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

  unknown_team: "there is no such unit, ward team, service or pool",
  unknown_membership: "that person does not have a place in this team over that stretch",
  duplicate_team_code: "another team already goes by that code, and two teams with one name is a rota nobody can read",
  parent_membership_overlap: "a person belongs to ONE unit at a time — close the place they hold now before giving them another, or post them on rotation instead",
  head_already_held: "this team already has a head over that stretch; record an officiating head instead of a second substantive one",
  officiating_overlap: "somebody is already standing in for that role over part of the same stretch",
  delegation_not_held: "nobody may hand on an authority they do not hold themselves",
  intern_plan_invalid: "that internship plan does not add up to the year the regulator requires",

  unknown_absence: "there is no such absence on record",
  unknown_absence_kind: "that is not a kind of absence this hospital records",
  absence_already_decided: "somebody has already decided this one — it cannot be decided twice",
  absence_self_approval: "the person who asks for leave is not the person who allows it; ask whoever answers for the department",
  unknown_credential: "there is no such registration or certificate on record",

  unknown_escalation_kind: "that is not a kind of alert the roster can be asked to route",
  unknown_role: "that is not a role in this hospital",

  unknown_cycle: "there is no such duty cycle for that department",
  cycle_not_draft: "a cycle the department is working to is never edited — draft the next version and publish that",
  empty_cycle: "a cycle with no days on it would leave the department with no calendar at all",
  unknown_template: "that is not one of the duty patterns this hospital offers",
  template_needs_more_units: "that pattern is written for more units than this department has, and applied to fewer it would give somebody two turns on take at once",
  blocked_by_findings: "this roster breaks a rule that stops it going live — the findings say which, and each one can be accepted, with a reason, by whoever answers for the department",
  unknown_rule: "that is not a rule in this hospital's book",
  unknown_finding: "that finding is not on this roster",
  finding_already_accepted: "somebody has already accepted this finding, and their reason stands",
  unknown_mode_declaration: "there is no such declaration on that day",
  mode_already_withdrawn: "somebody has already stood this down, and the time they did it stands",
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

  unknown_team: 404,
  unknown_membership: 404,
  intern_plan_invalid: 422,
  duplicate_team_code: 409,
  parent_membership_overlap: 409,
  head_already_held: 409,
  officiating_overlap: 409,
  delegation_not_held: 409,

  unknown_absence: 404,
  unknown_credential: 404,
  unknown_role: 404,
  /** 422: the roster is well-formed and the hospital will not stand behind it as it is. */
  blocked_by_findings: 422,
  unknown_rule: 404,
  unknown_finding: 404,
  finding_already_accepted: 409,
  unknown_mode_declaration: 404,
  mode_already_withdrawn: 409,
  unknown_cycle: 404,
  empty_cycle: 422,
  unknown_template: 404,
  template_needs_more_units: 422,
  cycle_not_draft: 409,
  unknown_escalation_kind: 422,
  unknown_absence_kind: 422,
  absence_already_decided: 409,
  absence_self_approval: 409,
};

export function rosterHttpStatus(code: RosterErrorCode): number {
  return STATUS[code];
}
