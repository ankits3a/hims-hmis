import type { ModuleManifest } from "../modules/manifest";

export const workflowManifest: ModuleManifest = {
  key: "workflow",
  title: "Workflow Engine",
  // GO-LIVE SCREENS — the definitions board: approve (owner, MS) and activate (owner) a drafted workflow.
  menu: [{ label: "Workflows", path: "/admin/workflows", permission: "workflow.definitions.read" }],
  permissions: [
    "workflow.definitions.draft",
    "workflow.definitions.approve",
    "workflow.definitions.activate",
    "workflow.definitions.read",
    "workflow.instances.start",
    "workflow.instances.transition",
    "workflow.instances.read",
    "workflow.instances.remediate",
  ],
  subscriptions: [],
};
