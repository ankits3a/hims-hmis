import type { ModuleManifest } from "../../kernel/modules/manifest";
import { patientSearchProvider } from "./search-provider";
import { patientsDeskProvider } from "./desk-provider";

export const patientsManifest: ModuleManifest = {
  key: "patients",
  title: "Patient Master & Registration",
  /**
   * FD-9 — `/registration` IS DELETED AND THIS MENU IS EMPTY, WHICH IS THE HONEST STATE.
   *
   * The owner's 03-Sep ruling merged the three front-desk routes into one screen, Desk One, at
   * `/counter`. That path is declared by `opdManifest.menu` on `opd.visits.open` — the permission a
   * desk needs to OPEN a visit — and a menu is a map of paths to permissions, so this module cannot
   * declare the same path against `patients.register` without putting two different answers in the
   * table `nav-parity.test.ts` compares. The registration screen it used to advertise no longer
   * exists, so advertising anything here would be advertising a dead route.
   *
   * `patients.register` is unaffected: it is still declared below, still granted, and still what
   * `POST /patients` guards on. What is gone is a nav row, not an ability.
   */
  menu: [],
  permissions: [
    "patients.register",
    "patients.read",
    "patients.update",
    "patients.merge",
    "patients.confidential.read", // §14: confidential/VIP visibility beyond normal RBAC
    /**
     * PLAN 22c-A DD7 — THE PRIVACY WRITE SPLIT, and it closes a one-way door that is open in
     * production today.
     *
     * Measured at kickoff (spike S5): `patients.update` is held by FIVE roles and SEVENTEEN of
     * thirty-five production users, and it currently carries the power to set `is_confidential`.
     * `patients.confidential.read` is held by ZERO roles and ZERO users. Read those two facts
     * together: seventeen people can hide a patient from every search surface in the hospital,
     * and nobody can read that patient back except through break-glass. Fixing a mistyped phone
     * number and making a person invisible are the same permission.
     *
     * These two split the second power out of the first. `deceased.write` is the same argument
     * on a colder path: `deceased_at` is a hard stop in the notifications gateway that beats
     * urgency, so a clerk who can set it can silence every message to a living patient's family.
     *
     * NO ROLE IS GRANTED EITHER ONE BY THE MIGRATION (DD7). `seed-roles.ts` is deliberately
     * untouched. The grant is an owner act, exactly like every other Class-A grant — a phase
     * that silently widened a privacy permission would be the defect this split exists to
     * prevent, and A17 is the assertion that proves the migration granted nothing.
     */
    "patients.confidential.write",
    "patients.deceased.write",
  ],
  // PLAN 11h T2 — one array entry is the whole of "this module is searchable" (DD1).
  search: [patientSearchProvider],
  // FD-1 T1 — the registration tile and "what came back" on the clerk's home. The kernel already
  // declares `desk` optional; no index export changes.
  desk: [patientsDeskProvider],
  subscriptions: [],
};
