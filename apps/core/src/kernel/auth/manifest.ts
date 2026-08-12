import type { ModuleManifest } from "../modules/manifest";

export const authManifest: ModuleManifest = {
  key: "auth",
  title: "Users & Access",
  menu: [],
  permissions: [
    "auth.users.manage",
    "auth.roles.manage",
    "auth.agents.manage",
    "auth.break_glass.use",
    "auth.break_glass.review",
    "auth.temp_role.grant",
  ],
  subscriptions: [],
};
