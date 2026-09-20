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
};

export function rosterHttpStatus(code: RosterErrorCode): number {
  return STATUS[code];
}
