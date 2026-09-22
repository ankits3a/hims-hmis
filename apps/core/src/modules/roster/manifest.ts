import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PHASE R (R1) — **THE ROSTER IS ITS OWN MANIFEST.**
 *
 * The duty manager, the on-call radiologist, the lab's critical ladder, the mini-OT's anaesthetist,
 * every ward's nurses and — this being a teaching hospital (owner ruling RU-1, 2026-09-20) — every
 * clinical unit's residents owe rows to the same tables. Inside any one department's module the
 * roster would become that department's by accident, and the next department would have to import a
 * department to say who is on call. `aerb` and `pcpndt` made this argument for a statute; this makes
 * it for a rota.
 *
 * ═══ THREE PERMISSIONS, UNCHANGED FROM PLAN 20 T1 ═══
 *
 *   · **`roster.periods.manage`** — draft a period, add and remove its slots, propose a cover.
 *   · **`roster.periods.publish`** — the governed acts (D3/D4): publish, amend, approve, override,
 *     declare. Separate, because the person who drafts a unit's month (its senior resident) is not
 *     the person who answers for it (its head).
 *   · **`roster.read`** — read a roster as a book, and acknowledge what it sends you.
 *
 * **They are now checked at DEPARTMENT scope** (`access.ts`), which is the stress test's S1 finding
 * arriving in access control: holding `roster.periods.publish` for Orthopaedics is not holding it
 * for Medicine. No permission is added by this phase (plan §5, `kernel/auth` frozen).
 *
 * ═══ NO MENU, NO ROUTE, NO SUBSCRIPTION, NO JOB — YET ═══
 *
 * R1 is the masters and the seam. The screens are the S-series, gated on the owner's sign-off of the
 * four design boards; the calendar's nightly job arrives in R7 and the proposer's monthly one in R9,
 * each named in the scheduler census by the task that adds it. The `materials` / `resources` /
 * `pharmacy` precedent: a module seam ships inert and a later task mounts its controller.
 */
export const rosterManifest: ModuleManifest = {
  key: "roster",
  title: "Roster",
  menu: [],
  permissions: [
    "roster.periods.manage",
    "roster.periods.publish",
    "roster.read",
  ],
  subscriptions: [],
};
