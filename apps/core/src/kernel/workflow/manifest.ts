import type { ModuleManifest } from "../modules/manifest";

export const workflowManifest: ModuleManifest = {
  key: "workflow",
  title: "Workflow Engine",
  menu: [], // first UI arrives in Plan 05
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
