import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E2.4 LINEN (issue #728, decision 0072) — three permissions, and LD-1's four.
 *   · `linen.view` — the supervisor board: wards below par, laundry out and in, infected batches, weekly loss.
 *   · `linen.handle` — the handler's phone: top up, soiled and infected returns, ward counts, laundry out and in,
 *     borrowing between wards, and raising a condemn request.
 *   · `linen.manage` — set a ward's par over the computed one, approve or reject a condemn request (never one's own).
 * LD-1 (#978, decision 0087) adds four:
 *   · `linen.plant` — the laundry plant: machines up and down, wash cycles, release to quality check, send to vendor.
 *   · `linen.qc` — quality check: pass, rewash, mend, condemn (the condemn still waits for a second person).
 *   · `linen.cssd_receive` — signs for theatre sets at CSSD (the OT nurse in-charge; there is no CSSD module yet).
 *   · `linen.hold.release` — releases an MLC hold to the police (a nurse in-charge) or a radioactive hold (the RSO,
 *     checked against the AERB appointment too). Placing a hold is `linen.handle`.
 * LD-2 (#979, decisions 0087 and 0092) adds four:
 *   · `linen.vendor` — the laundry desk: vendors and rate cards, challans and dock returns, the monthly report and raising
 *     a recovery, checking the vendor's bill, piece tags, the plant's licences and item costs.
 *   · `linen.uniform` — issue, exchange and take back staff uniforms.
 *   · `linen.recovery.approve` — the owner or finance approves, edits or rejects a vendor recovery (never their own).
 *   · `linen.bill.approve` — stores approves (or refuses) a vendor bill's excess over the accepted pieces.
 * No subscription; the linen clock (holds, rounds) runs in the worker's job list, so the manifest stays API-only.
 */
export const LINEN_VIEW = "linen.view";
export const LINEN_HANDLE = "linen.handle";
export const LINEN_MANAGE = "linen.manage";
export const LINEN_PLANT = "linen.plant";
export const LINEN_QC = "linen.qc";
export const LINEN_CSSD_RECEIVE = "linen.cssd_receive";
export const LINEN_HOLD_RELEASE = "linen.hold.release";
export const LINEN_VENDOR = "linen.vendor";
export const LINEN_UNIFORM = "linen.uniform";
export const LINEN_RECOVERY_APPROVE = "linen.recovery.approve";
export const LINEN_BILL_APPROVE = "linen.bill.approve";

export const linenManifest: ModuleManifest = {
  key: "linen",
  title: "Linen",
  menu: [
    { label: "Linen counts", path: "/linen/handle", permission: LINEN_HANDLE },
    { label: "Linen board", path: "/linen", permission: LINEN_VIEW },
    // LD-1 (#978) — the runner's ward hand-over, the laundry floor and the linen store (paths match the web router's nav).
    { label: "Linen rounds", path: "/linen/rounds", permission: LINEN_HANDLE },
    { label: "Laundry floor", path: "/linen/plant", permission: LINEN_PLANT },
    { label: "Linen store", path: "/linen/store", permission: LINEN_VIEW },
    // LD-2 (#979) — the vendor laundry desk and staff uniforms.
    { label: "Vendor laundry", path: "/linen/vendor", permission: LINEN_VENDOR },
    { label: "Uniforms", path: "/linen/uniforms", permission: LINEN_UNIFORM },
  ],
  permissions: [LINEN_VIEW, LINEN_HANDLE, LINEN_MANAGE, LINEN_PLANT, LINEN_QC, LINEN_CSSD_RECEIVE, LINEN_HOLD_RELEASE,
    LINEN_VENDOR, LINEN_UNIFORM, LINEN_RECOVERY_APPROVE, LINEN_BILL_APPROVE],
  subscriptions: [],
};
