import { DEFAULT_REACH_LADDER } from "../db/schema/reach";
import type { ReachChannel, ReachLanguage } from "../db/schema/reach";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — THE CLASS DEFAULT, WHICH IS CODE, AND THE PER-PERSON OVERRIDE, WHICH IS DATA
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Census §Q.4: *"reach profiles are per class, then per person."* A person's row in
 * `user_reach_profiles` wins; a person with no row gets their class's answer from here.
 *
 * ═══ WHY THE CLASS DEFAULT IS CODE AND NOT A SEEDED ROW PER USER ═══
 *
 * Seeding a row for everybody would freeze each person's ladder at the moment the seed ran, and
 * turn "support staff should get Hindi first" into a data migration across every support user
 * instead of one line here. It also destroys the distinction this design needs: a row means *a
 * person has an opinion*, and 400 seeded rows mean nobody does.
 *
 * ═══ WHAT PHASE ONE CAN ACTUALLY BUILD ═══
 *
 * §Q.4 names voice for drivers, email and a portal for committees and external parties. Neither
 * channel exists: `REACH_CHANNELS` is `web_push | whatsapp | sms`, and voice is a §8 follow-up
 * behind a provider the owner has not chosen (the edge register's R4 is still open). So each
 * class below names the nearest channel that EXISTS, and says in a comment what it is standing
 * in for — rather than declaring a `voice` channel with no adapter, which would look configured
 * and reach nobody.
 */
export type ReachProfileDefault = {
  language: ReachLanguage;
  ladder: readonly ReachChannel[];
  /** R9 — exempt from the hourly interrupt budget AND from quiet hours. Two seats, by design. */
  quietExempt: boolean;
};

/**
 * The classes, in the census's own order. A class is a REACH shape, not a department: what it
 * groups is "how does this person find out", and two people in one department can differ.
 */
export const REACH_CLASSES = {
  /**
   * §Q.4 "screen seats: station banner". They are at a machine all day, so the in-app alert IS
   * the notification and a push is the only rung worth climbing — a counter clerk's phone
   * buzzing about the queue they are looking at is noise.
   */
  screen: { language: "en", ladder: ["web_push"], quietExempt: false },
  /** §Q.4 "clinicians: app → WhatsApp → call". The call rung is voice and waits for §8. */
  clinician: { language: "en", ladder: DEFAULT_REACH_LADDER, quietExempt: false },
  /**
   * §Q.4 "support and contract: supervisor's phone, flash SMS in Hindi". No login, no browser,
   * so no push rung at all — the first thing that can reach them is the phone. R11 / RO-3:
   * Hindi is the class default here and English is the override, which is the one class where
   * that is true.
   */
  support: { language: "hi", ladder: ["whatsapp", "sms"], quietExempt: false },
  /**
   * §Q.4 "drivers: voice only". Voice does not exist yet, so SMS stands in and is marked as
   * doing so. This is the class §8's voice leg switches first.
   */
  driver: { language: "hi", ladder: ["sms"], quietExempt: false },
  /**
   * R9 names exactly two exemptions from the interrupt budget: the night supervisor and the
   * CMO. They are the seats whose entire job is to be interrupted.
   */
  always_on: { language: "en", ladder: DEFAULT_REACH_LADDER, quietExempt: true },
} as const satisfies Record<string, ReachProfileDefault>;

export type ReachClass = keyof typeof REACH_CLASSES;

/**
 * Role → class, for the roles `ROLE_MODEL` seeds today. Roles absent from this map fall to
 * `clinician`, which is the safe direction: the fullest ladder and English, so a role added
 * tomorrow is reachable before anybody remembers to classify it. The unsafe default would be
 * `screen`, which would silently confine a new role to a browser it may not have.
 */
const ROLE_CLASS: Record<string, ReachClass> = {
  // Screen seats — a machine in front of them for the whole shift.
  front_office: "screen",
  front_office_supervisor: "screen",
  cashier: "screen",
  billing_manager: "screen",
  opd_admin: "screen",
  opd_scribe: "screen",
  vitals_desk: "screen",
  lab_reception: "screen",
  radiology_receptionist: "screen",
  membership_admin: "screen",
  tariff_editor: "screen",
  mrd_officer: "screen",
  staff_auditor: "screen",
  storekeeper: "screen",
  display: "screen",
  // Bridges are machines, not people; they hold no reach at all, and `screen` is the quietest
  // shape that exists. Nothing addresses them today (A12's sibling: a bridge is never an
  // addressee), so this entry is a statement rather than a route.
  lab_bridge: "screen",
  modality_bridge: "screen",

  // The two seats R9 names.
  duty_manager: "always_on",
  medical_superintendent: "always_on",
};

/**
 * The profile that applies to a person with no row of their own, given the roles they hold.
 *
 * A person holding several roles takes the LOUDEST class among them — the longest ladder, and
 * `quietExempt` if any of their roles carries it. A duty manager who also works a counter is on
 * call as a duty manager; resolving to the quieter class would silence the seat that exists to
 * be woken.
 */
export function defaultReachProfile(roleKeys: readonly string[]): ReachProfileDefault {
  const classes = roleKeys.map((r) => ROLE_CLASS[r] ?? "clinician");
  if (classes.length === 0) return REACH_CLASSES.clinician;
  let best = REACH_CLASSES[classes[0]!];
  for (const c of classes) {
    const candidate = REACH_CLASSES[c];
    if (candidate.ladder.length > best.ladder.length) best = candidate;
  }
  const quietExempt = classes.some((c) => REACH_CLASSES[c].quietExempt);
  return quietExempt ? { ...best, quietExempt: true } : best;
}

export function reachClassOf(roleKey: string): ReachClass {
  return ROLE_CLASS[roleKey] ?? "clinician";
}
