import type { ModuleManifest } from "../modules/manifest";

/**
 * PLAN 07c T9 / DD14 — THE DESK'S OWN §4 SEAM, so the supervisor's view has a permission to be
 * gated on.
 *
 * It is KERNEL code carrying a manifest, exactly like `auth`, `workflow`, `approvals`, `alerts`,
 * `ops` and `resources` — the §4 seam is where permissions are DECLARED, not a statement about
 * which package a file lives in. Without a manifest declaring these two strings,
 * `grantPermissionToRole` would refuse them and no role could ever hold them, which is the same
 * refusal `collectDeskProviders` makes about a card gated on an undeclared permission.
 *
 * ═══ TWO PERMISSIONS, AND THE SPLIT IS THE WHOLE OF DD14 ═══
 *
 * `staff.reports.read` buys the counts: what a named person did, how much they collected, how
 * their week compares to their own median. `staff.reports.drill` buys the rows behind one of those
 * numbers — the patients — and it is a SEPARATE grant on purpose. A supervisor reviewing workload
 * needs the first and not the second, and a hospital that hands out both together has decided,
 * without noticing, that every shift supervisor may read every patient list in the building.
 *
 * ═══ WHO MAY BE READ — DECIDED, and stated rather than left implicit ═══
 *
 * A holder of `staff.reports.read` may read ANY active user's figures. There is no reporting-line
 * table in this system and no data from which one could be derived, so a narrower gate would have
 * to INVENT an org structure — and a fabricated hierarchy that silently decides who may audit whom
 * is worse than an explicit permission somebody grants deliberately. This is the standing rule
 * applied: the most logical Indian-corporate-hospital choice for a single site with tens of staff,
 * marked DECIDED. When a reporting line exists (a worker registry, an HR module), the gate narrows
 * to it and this note is the record of why it was not narrower first.
 */
export const deskManifest: ModuleManifest = {
  key: "desk",
  title: "Desk — the home screen, the daily report and the staff view",
  menu: [{ label: "Staff reports", path: "/staff", permission: "staff.reports.read" }],
  permissions: ["staff.reports.read", "staff.reports.drill"],
  subscriptions: [],
};
