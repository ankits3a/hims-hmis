import type { ModuleManifest } from "../../kernel/modules/manifest";

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
  subscriptions: [],
};
