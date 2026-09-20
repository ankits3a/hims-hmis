import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 20 T1 / D1 — **THE ROSTER IS ITS OWN MANIFEST.**
 *
 * The duty manager, the on-call radiologist, the lab's critical ladder, the mini-OT's anaesthetist
 * and — this being a teaching hospital (owner ruling RU-1, 2026-09-20) — every clinical unit's
 * residents owe rows to the same two tables. Inside any one department's module the roster would
 * become that department's by accident, and the next department would import a department to say
 * who is on call. `aerb` and `pcpndt` made this argument for a statute; this makes it for a rota.
 *
 * ═══ THREE PERMISSIONS ═══
 *
 *   · **`roster.periods.manage`** — draft a period, add and remove its assignments.
 *   · **`roster.periods.publish`** — the governed act (D3). Separate, because the person who drafts
 *     a unit's month (its senior resident) is not the person who answers for it (its head).
 *   · **`roster.read`** — read a roster as a book. Who-is-on-NOW is a different read with a
 *     different audience (casualty, every ward) and arrives with the resolver in T2.
 *
 * ═══ NO MENU, NO ROUTE, NO SUBSCRIPTION, NO JOB — YET ═══
 *
 * T1 is tables and the publication gate. The screens are gated on the owner's sign-off of the design
 * boards (phase 20-U §5); the first writer is T4's import and the first reader T2's resolver. The
 * `materials` / `resources` / `pharmacy` precedent: a module seam ships inert and a later task
 * mounts its controller. The scheduler census does not move.
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
