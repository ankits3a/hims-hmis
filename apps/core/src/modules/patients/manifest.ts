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
  ],
  // PLAN 11h T2 — one array entry is the whole of "this module is searchable" (DD1).
  search: [patientSearchProvider],
  subscriptions: [],
};
