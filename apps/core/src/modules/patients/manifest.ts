import type { ModuleManifest } from "../../kernel/modules/manifest";
import { patientSearchProvider } from "./search-provider";

export const patientsManifest: ModuleManifest = {
  key: "patients",
  title: "Patient Master & Registration",
  menu: [{ label: "Registration", path: "/registration", permission: "patients.register" }],
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
  subscriptions: [],
};
