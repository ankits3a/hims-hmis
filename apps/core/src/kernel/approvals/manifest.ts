import type { ModuleManifest } from "../modules/manifest";

export const approvalsManifest: ModuleManifest = {
  key: "approvals",
  title: "Approvals Engine",
  menu: [], // first UI arrives in Plan 05
  permissions: [
    "approvals.types.manage",
    "approvals.requests.create",
    "approvals.requests.read",
    "approvals.requests.decide",
  ],
  subscriptions: [],
};
