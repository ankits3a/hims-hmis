import { eq, inArray } from "drizzle-orm";
import { createDb, withTx, type Db } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { authManifest } from "../src/kernel/auth/manifest";
import { opsManifest } from "../src/kernel/ops/manifest";
import { usersHoldingRole } from "../src/kernel/workflow/roles";
import { fullAdministrators } from "../src/kernel/auth/users-admin.controller";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import { rolePermissions, roles, users } from "../src/kernel/db/schema";

/**
 * `pnpm --filter @hmis/core seed:roles` — the go-live step that makes EVERY module's permissions
 * reachable by somebody (Plan 11d, D1 + D3).
 *
 * WHY THIS EXISTS, because a script nobody understands is a script nobody runs, and because the
 * defect it closes was already closed once for one module and left open for eight.
 *
 *   - `syncPermissions` mirrors permission NAMES into `permissions` at api boot. It is a CATALOG.
 *     It grants nothing to anybody, and it never has.
 *   - Grants are `role_permissions` rows, written only by `grantPermissionToRole`. Before this
 *     script it had exactly TWO non-test callers in the whole tree: `scripts/seed-admin.ts`,
 *     whose registry holds `authManifest` ALONE (six `auth.*` strings) and which — until Plan 11e
 *     deleted its early return — did nothing at all on a deployment that already had an admin, and
 *     `scripts/seed-ops.ts`, which grants three `ops.*` strings.
 *   - `app.module.ts` installs NINE manifests declaring FIFTY-NINE permissions.
 *
 * MEASURED AGAINST PRODUCTION ON 2026-08-24 (plan §B-MEASURED, four read-only SELECTs): the
 * catalog held 59, the only user held 9 — six `auth.*` and three `ops.*` — and FIFTY declared
 * permissions were held by no role at all. Every `opd.*`, `billing.*`, `patients.*`, `tariff.*`,
 * `workflow.*` and `approvals.*` route on the live box answered 403 to the only user who existed:
 * a patient could not be registered and an invoice could not be issued. The README even
 * instructed the owner to fix it by hand — "Grant the `opd.*` permissions per the table above" —
 * naming a tool that did not exist. This is that tool.
 *
 * WHAT IT DOES, all of it idempotent, so it belongs in the re-deploy path forever:
 *   1. installs `ALL_MANIFESTS` and runs `syncPermissions` — `role_permissions.permission` FKs
 *      `permissions.permission`, so the catalog row must exist before any grant can;
 *   2. creates the nine roles of the model below if absent (`createRole` is a BARE INSERT and is
 *      NOT idempotent on its own — `ensureRole` guards it, exactly as `seed-ops.ts` does);
 *   3. grants each role its permissions, skipping rows that already exist so a second run reports
 *      `already` rather than pretending it did work;
 *   4. checks the REACHABILITY INVARIANT — every declared permission is held by at least one
 *      seeded role, or named in `NOT_YET_MODELLED` with a reason — and reports the census;
 *   5. counts holders per role, because a permission nobody holds is a 403 with extra steps;
 *   6. states a readiness verdict in its last line rather than implying one.
 *
 * IT FOLLOWS THE MANIFESTS, NOT THE README. `grantPermissionToRole` refuses any string
 * `registry.allPermissions()` does not contain, which is the leg that turns a typo into a loud
 * failure instead of a permission nobody can ever hold. If a README cell ever names a permission
 * no manifest declares, this script fails and the README is what is wrong.
 *
 * IT ASSIGNS NOBODY, DELIBERATELY. `seed:roles` mints authority; handing it to humans is a
 * separate command, so that "give Asha the cashier role" and "change what a cashier may do" can
 * never be the same act. `opd_admin`, `display` and `pharmacy` therefore get roles with grants
 * and no humans, which is correct — and a role with zero holders APPEARS IN THE REPORT rather
 * than being silently absent, the same discipline `seed-ops.ts` already applies to `owner`.
 *
 * Usage:
 *   pnpm --filter @hmis/core seed:roles
 */

/** One role and every permission the model grants it. */
export type RoleGrants = { roleKey: string; permissions: readonly string[] };

/** A declared permission no role holds yet, with the reason no grant was invented for it. */
export type NotYetModelled = { permission: string; reason: string };

/**
 * THE ROLE MODEL — the source of truth, transcribed cell for cell from the README's two
 * permission tables (the OPD table under "Permissions (14) and the recommended grants" and the
 * billing table under "Recommended permission grants") plus owner ruling 7 of 2026-08-24.
 *
 * `test/seed-roles.test.ts` parses BOTH tables out of `README.md` and compares them against this
 * constant in both directions, so the README cannot drift from it and it cannot drift from the
 * README. THREE sets of rows appear in NEITHER markdown table — owner ruling 7's eight
 * `patients.*` pairs, the 2026-08-23 workflow ruling's seven, and Plan 09 / DD18's ten
 * `membership.*` — and each is pinned by its own named constant in that test against a README
 * prose line the test quotes VERBATIM. A row that is neither table-derived nor one of those
 * twenty-five FAILS, which is what stops the subset scoping becoming a hole.
 */
export const ROLE_MODEL: readonly RoleGrants[] = [
  {
    roleKey: "front_office",
    permissions: [
      "opd.masters.read",
      "opd.appointments.read",
      "opd.appointments.manage",
      "opd.visits.read",
      "opd.visits.open",
      "opd.queue.read",
      // Owner ruling 7 — without these the desk cannot register a patient and the OPD flow this
      // plan exists to enable dies at step one.
      "patients.register",
      "patients.read",
      "patients.update",
      // PLAN 09 / DD18 — the counter's three. This desk registers the patient who presents a card,
      // so it is where recognition has to work; requesting a grace-honor goes with it because the
      // person holding the card is standing there. Approving one does NOT (see billing_manager).
      "membership.instrument.read",
      "membership.instrument.recognise",
      "membership.grace_honor.request",
    ],
  },
  {
    roleKey: "front_office_supervisor",
    permissions: [
      "opd.masters.read",
      "opd.appointments.read",
      "opd.appointments.manage",
      "opd.visits.read",
      "opd.visits.open",
      "opd.queue.read",
      "opd.queue.transfer",
      "patients.register", // owner ruling 7
      "patients.read",
      "patients.update",
      // PLAN 09 / DD18 — the same three as `front_office`: a supervisor who cannot do what the
      // desk does cannot cover it.
      "membership.instrument.read",
      "membership.instrument.recognise",
      "membership.grace_honor.request",
    ],
  },
  {
    roleKey: "vitals_desk",
    permissions: [
      "opd.visits.read",
      "opd.vitals.record",
      "opd.queue.read",
      // Owner ruling 7, and the NARROWER half of it on purpose: vitals are recorded against a
      // patient who already exists, so `patients.register` stays with the two desk roles. A
      // narrow grant can be widened later without anybody being locked out in the meantime.
      "patients.read",
      "patients.update",
    ],
  },
  {
    roleKey: "doctor",
    permissions: [
      "opd.masters.read",
      "opd.appointments.read",
      "opd.visits.read",
      "opd.vitals.record",
      "opd.queue.read",
      "opd.queue.operate",
      "opd.consult",
      // ═══ GROUP B, owner ruling 2026-08-26 — THE SHARPEST ROW IN THIS FILE ═══
      //
      // THE DOCTOR COULD NOT READ A PATIENT RECORD, AND THAT INCLUDED THE ALLERGY LIST.
      //
      // `opd-consult.tsx` fetches `GET /patients/:id` and `GET /patients/:id/allergies` to render
      // the consultation panel; both are `@RequirePermission("patients.read")`. This role held
      // seven `opd.*` strings and no `patients.*` at all, so BOTH CALLS ANSWERED 403 — measured
      // against production 2026-08-26, where all three active doctors returned
      // `has patients.read: false`. A doctor prescribing without the allergy register is the
      // failure mode the whole formulary safety layer is being designed to prevent, and it was
      // live.
      //
      // Owner ruling 7 gave `patients.read` + `patients.update` to the two desk roles and to
      // `vitals_desk` "for quick allergies" and stopped there — the omission is visible in that
      // ruling's own shape: every role that touches the patient BEFORE the doctor got it, and the
      // doctor did not.
      //
      // `patients.update` rides along for the same reason it went to `vitals_desk`: `POST
      // /patients/:id/allergies` is gated on it, and an allergy discovered DURING a consultation
      // is the single most valuable moment to record one. `patients.register` deliberately stays
      // with the desk — a doctor does not create the record, they act on it.
      "patients.read",
      "patients.update",
    ],
  },
  {
    roleKey: "opd_admin",
    permissions: [
      "opd.masters.read",
      "opd.masters.manage",
      "opd.config.manage",
      "opd.appointments.read",
      // Owner ruling 2026-08-23: the OPD masters administrator DRAFTS workflow definitions.
      // Drafting only — the SoD pair `workflow_drafter_activator` forbids the same person
      // activating what they drafted, so `.activate` deliberately lives on `owner` instead.
      "workflow.definitions.draft",
      "workflow.definitions.read",
    ],
  },
  { roleKey: "display", permissions: ["opd.display.read"] },
  {
    roleKey: "pharmacy",
    permissions: [
      "opd.prescriptions.verify",
      // GROUP B, 2026-08-26. `verifyPrescriptionQr` hands back the lines and a patient SUMMARY and
      // no allergies at all, so a pharmacist scanning an e-Rx could read what was prescribed and
      // never what the patient reacts to. Dispensing is the last gate before the drug reaches the
      // person; it is the wrong place to be blind.
      //
      // READ ONLY, deliberately. The allergy REGISTER belongs to the clinicians who examine the
      // patient — `patients.update` stays with the desk, vitals and the doctor. The `vitals_desk`
      // precedent applies: a narrow grant can be widened later without anybody being locked out in
      // the meantime, and the reverse is not true.
      "patients.read",
    ],
  },
  {
    roleKey: "cashier",
    permissions: [
      "billing.invoice.issue",
      "billing.invoice.read",
      "billing.credit.extend",
      "billing.receipt.record",
      "billing.credit_note.issue",
      "billing.refund.request",
      "billing.refund.pay",
      "billing.session.own",
      // PLAN 09 / DD18 — the counter that ISSUES THE INVOICE is the one that must recognise the
      // card at the moment of billing, because a benefit not applied then cannot be applied
      // afterwards without a credit note, an approval and a queue (§1's ordering argument).
      "membership.instrument.read",
      "membership.instrument.recognise",
      "membership.grace_honor.request",
    ],
  },
  {
    roleKey: "billing_manager",
    permissions: [
      "billing.invoice.read",
      "billing.allocation.reverse",
      "billing.session.read",
      "billing.recon.upload",
      "billing.reports.read",
      "billing.config.write",
      "billing.eie.mark",
      // The billing table's last cell is `approvals.requests.read` / `.decide` — TWO permissions
      // from a DIFFERENT manifest, written as one shorthand. `billing_manager` is the
      // `approverRole` on all five billing approval types, so it needs the generic approvals pair.
      "approvals.requests.read",
      "approvals.requests.decide",
      // PLAN 09 / DD18 — approving a grace-honor belongs with the role that already approves every
      // other billing exception, and it is the ONLY membership string this role gets. It is not
      // given `membership.instrument.read`: the approval carries its own subject, and minting a
      // read of every member's instrument to authorise one exception is authority nobody asked for.
      "membership.grace_honor.approve",
    ],
  },
  // ------------------------------------------------------------------------------------------
  // THE TWO GOVERNANCE ROLES (owner ruling 2026-08-23). Both keys are ALREADY declared by
  // `OPD_ROLE_KEYS` — the `opd_visit` definition names them in its Class A policy
  // (`definitions.ts` CHANGE_CLASS_POLICY.A) — and `seed:opd` creates them holding nothing.
  // Until this ruling they were role keys with no permission column anywhere, which is why
  // production carried an `owner` role with ZERO grants and no `medical_superintendent` at all,
  // and why runbook step 4 could not be performed by any account that existed.
  //
  // They grant DEFINITION-GOVERNANCE only, never `workflow.instances.*`: approving a change to
  // the OPD state machine and driving a patient through it are different authorities, and the
  // second one the OPD module exercises in-process rather than over HTTP.
  // ------------------------------------------------------------------------------------------
  {
    roleKey: "owner",
    permissions: [
      "workflow.definitions.approve",
      // The ACTIVATOR half of the two-key ceremony. `opd_admin` drafts; whoever holds `owner`
      // activates; `sod.ts`'s `workflow_drafter_activator` pair means they cannot be one person.
      "workflow.definitions.activate",
      "workflow.definitions.read",
      // ─── GROUP A, owner ruling 2026-08-26: the ACTIVATOR half of the tariff, too ───
      //
      // The price list had NO holder for any of its five strings: nobody could add a service or
      // publish a revision from a screen, and the README's own tariff section described a flow no
      // account could perform. `tariff_editor` below drafts; `owner` activates. That is the
      // workflow-definition ceremony applied to money, and it is deliberate rather than symmetric
      // by accident — a price list that one person can both write and publish is the single
      // control every revenue audit asks about first. `tariff_revision` already routes the
      // submission through `billing_manager` for approval, so the published version has three
      // hands on it.
      //
      // `tariff.read` rides along because activating a version you cannot open is not a ceremony,
      // it is a coin flip.
      "tariff.read",
      "tariff.versions.activate",
      // Rounding, GST posture and the pricing knobs. A configuration act over money, which is the
      // same authority class as activating a version.
      "tariff.config.manage",
      // Registering or editing an APPROVAL TYPE changes who may approve what, for every module at
      // once — the approvals engine's own governance. It belongs with the role that already holds
      // the activator key, and nowhere below it.
      "approvals.types.manage",
      // ─── GROUP B, 2026-08-26: the owner can finally see the money ───
      //
      // This role held three `workflow.*` strings and could not open a single invoice, dues ledger
      // or daybook — the person who carries the hospital's financial risk had no read on its
      // revenue. These three are what the back-office and dues screens are gated on
      // (`billing.reports.read`, `billing.invoice.read`) plus oversight of cashier sessions
      // somebody else owns (`billing.session.read`, the same string `billing_manager` holds).
      //
      // `patients.read` IS DELIBERATELY ABSENT, and the absence is the ruling. The owner is an
      // administrative principal, not a clinical one: DPDP minimum-necessary and spec §14's
      // confidential-record posture both argue against a blanket clinical read for a role whose
      // job is governance and money. If the owner is ALSO a clinician on this deployment, that is
      // a second role assignment, visible on the admin screen, rather than a permission quietly
      // folded into this one.
      "billing.reports.read",
      "billing.invoice.read",
      "billing.session.read",
    ],
  },
  {
    roleKey: "medical_superintendent",
    permissions: [
      // The clinical half of Class A. CHANGE_CLASS_POLICY.A requires an approval from THIS role
      // as well as from `owner`, so a patient-journey flow cannot be activated on the strength of
      // administrative sign-off alone. No `.activate`: approving and activating stay separate.
      "workflow.definitions.approve",
      "workflow.definitions.read",
      // ─── GROUP C, owner ruling 2026-08-26: the two REVIEW desks leave the superuser ───
      //
      // Both of these used to be held by `admin` and by nobody else, because `seed:admin` grants
      // the whole `authManifest` to that role and no model row ever mentioned them. That put the
      // review of EXCEPTIONAL ACCESS with the technical administrator — the account that exists to
      // repair the deployment — when spec §14 and role card #39 both put medical-record governance
      // with the Medical Superintendent. `admin` KEEPS them (seed:admin is unchanged); what
      // changes is that the person whose job this is can finally do it.
      //
      // `auth.elevation.review` is the live one: the emergency-elevation queue shipped in
      // `fc9e49a` and, until this row, answered 403 to everyone but `admin`. Reviewing who handed
      // themselves authority is exactly the "worklist of governance decisions" card #39 describes.
      //
      // `auth.break_glass.review` is granted in the SAME breath deliberately, even though its
      // queue cannot fill yet (see the `auth.break_glass.use` note below): the two reviews are one
      // desk, and splitting them across two commits would leave a second correction to remember.
      "auth.break_glass.review",
      "auth.elevation.review",
      // ─── The merge approver's kit, owner ruling 2026-08-26 ───
      //
      // `patient_merge` and `patient_unmerge` name THIS role as `approverRole`, and an approver who
      // cannot reach the worklist is an approval nobody can decide. The pair is generic
      // (`approvals.*` is one engine for every module), which is the same reason `billing_manager`
      // holds it.
      "approvals.requests.read",
      "approvals.requests.decide",
      // AND THE RECORDS THEMSELVES, because approving a merge without being able to open the two
      // patients is not an approval, it is a coin flip. This is also the narrow half of Group B's
      // "the MS cannot read a patient record": `patients.update` and `.register` stay with the desk
      // roles — the superintendent decides about records, they do not keep them.
      "patients.read",
    ],
  },
  // ------------------------------------------------------------------------------------------
  // GROUP C, owner ruling 2026-08-26 — THE DUTY MANAGER GAINS THE MECHANISM BUILT FOR THEM.
  //
  // `duty_manager` has existed since `seed:ops` and held THREE `ops.*` strings, so it appears in
  // `GRANTED_BY_OTHER_SEEDS` and, until now, in no model row. `temp_role_grants` — the table, the
  // route, the auto-expiry sweep — was built for the staffing spec's §10 night-shift bundling
  // matrix and its workforce mechanism 4 (surge rosters, "pre-verified locum pool with
  // auto-expiring grants"). Every one of those is a duty-manager act at 2 a.m., and the permission
  // sat on `admin`: the one person the mechanism exists to avoid waking.
  //
  // ═══ THIS ROW WAS UNSAFE TO WRITE BEFORE `fc9e49a`, AND THAT IS THE POINT ═══
  //
  // `grantTempRole` used to accept ANY role key. A duty manager holding this permission could have
  // granted a colleague `admin` — a twelve-hour hospital-scope superuser, invisible to both the
  // lockout invariant and the takeover rule, and long enough to mint a permanent assignment. The
  // elevation ceiling (`temp-roles.ts`) now refuses any role carrying authority over access on
  // BOTH grant doors, which is why the header there says "one rule, both doors" and names this
  // exact move as the reason the admin-granted door had to be guarded too.
  //
  // It gets ONLY `auth.temp_role.grant`. Not `auth.users.manage`, not `auth.roles.manage`: the
  // night shift needs to lend authority for an hour, never to create an account or change what a
  // role means.
  // ------------------------------------------------------------------------------------------
  { roleKey: "duty_manager", permissions: ["auth.temp_role.grant"] },
  // ------------------------------------------------------------------------------------------
  // GROUP A, owner ruling 2026-08-26 — THREE ROLES FOR PERMISSIONS THAT HAD NO HOLDER AT ALL.
  //
  // Each of these guarded LIVE ROUTES that answered 403 to every account on the deployment. That
  // is the state `NOT_YET_MODELLED` exists to make visible rather than to excuse, and the entries
  // for these strings said "no owner ruling exists yet" — a decision waiting to be made. It has
  // been made; the eight strings leave that list in this commit and the census moves to prove it.
  // ------------------------------------------------------------------------------------------
  {
    roleKey: "tariff_editor",
    permissions: [
      "tariff.read",
      "tariff.services.manage",
      // DRAFT ONLY. `tariff.versions.activate` is `owner`'s (above), so the person who writes a
      // price cannot be the person who publishes it. There is no `tariff_drafter_activator` SoD
      // pair to enforce that at act time — the separation here is the whole control, which is why
      // it is a role boundary rather than a convention in a runbook.
      "tariff.versions.draft",
    ],
  },
  {
    roleKey: "membership_admin",
    permissions: [
      // The holder book arrives as an operator import and lands in quarantine; somebody has to
      // work the queue that never auto-links (Plan 09 DD5). Both strings guard live routes.
      "membership.import.run",
      "membership.reconcile.operate",
      // `membership.catalog.manage` is NOT here and that is measured, not squeamish: it guards NO
      // ROUTE ANYWHERE IN THE TREE. Its only occurrence is the manifest. Granting it would hand
      // somebody a key to a door that does not exist — the same mistake `auth.break_glass.use`
      // would have been. It stays in `NOT_YET_MODELLED` with that reason.
    ],
  },
  {
    roleKey: "mrd_officer",
    permissions: [
      // Card #7: "every record findable, releasable only lawfully, retained per schedule". Merging
      // two records for one person is the sharp end of "findable".
      "patients.read",
      "patients.update",
      // THE PERMISSION GROUP A REFUSED TO GRANT ON ITS OWN. It was not a ruling that was missing —
      // it was the machinery: `patient_merge` was registered by no seed, so `requestApproval` threw
      // `unknown_type` and the lane was dead at step one for every account. `seed:patients` closes
      // that, and the two land in the same commit so the button this grants is a button that works.
      //
      // IT IS NOT A UNILATERAL POWER. `executeMerge` refuses anything but a `granted` approval, the
      // approver is `medical_superintendent`, and `assertNotSodPair("requester_approver", …)` means
      // one person holding both roles still cannot approve their own merge.
      "patients.merge",
    ],
  },
  {
    roleKey: "biomedical_engineer",
    permissions: [
      // Card #33. Registering an analyzer or device feed, and deactivating one, is this person's
      // job — they are the reason the interface exists. `duty_manager` KEEPS it (via `seed:ops`,
      // untouched): the night shift must be able to silence a screaming interface without waking
      // the engineer, which is the §10 bundling matrix working as designed. This is a second
      // holder, not a transfer.
      "ops.interface.manage",
    ],
  },
];

/**
 * ═══ WHY `auth.break_glass.use` IS NOT GRANTED TO ANY CLINICAL ROLE — MEASURED 2026-08-26 ═══
 *
 * It is the obvious fourth Group C row and it is DELIBERATELY ABSENT, because granting it today
 * would ship a lie. Spec §14 promises "ER staff can open any record instantly"; the honest state of
 * the tree is that **break-glass unlocks nothing at all**.
 *
 * `PermissionGuard` consults `hasActiveBreakGlass` only when a route's requirement carries
 * `breakGlassBypass: true` (`guards.ts`). **NO ROUTE IN THIS TREE SETS IT.** The only occurrences of
 * that flag are its own type definition, the decorator signature, the guard's check, and one
 * comment. Separately, the confidentiality gate that would matter most is not a route guard at all:
 * `patients.confidential.read` is read through direct `hasPermission` calls inside
 * `search-provider.ts`, `search.ts` and `qr.ts`, which the guard's bypass could never reach.
 *
 * So a doctor granted this permission could record a grant, fill the review queue, and open exactly
 * nothing. That is worse than the current gap: it manufactures the APPEARANCE of an emergency path,
 * and the first person to rely on it would do so in an emergency.
 *
 * WHAT IT NEEDS IS A RULING PLUS WIRING, not a role row: which routes accept a bypass, whether a
 * bypass may cross the confidential gate (spec §14 says a VIP record is restricted BEYOND normal
 * RBAC, so "open any record" and "confidential stays sealed" are in direct tension and only the
 * owner can resolve it), and only then which roles hold the key. It is written up in
 * `docs/superpowers/plans/reports/2026-08-26-roles-access-relay.md` §7.
 */

/**
 * THE TWENTY-THREE DECLARED PERMISSIONS NO ROLE HOLDS YET, EACH WITH ITS REASON.
 *
 * SEVENTEEN until 2026-08-23, when the owner ruled the four `workflow.definitions.*` strings onto
 * roles and this list shrank by four — exactly the mechanism the last paragraph below predicted.
 *
 * THIS IS NOT AN EXCEPTIONS LIST AND MUST NOT BE READ AS ONE. An exception says "unreachable on
 * purpose". Nine of the thirteen still say "no owner ruling exists yet" — a decision waiting to be
 * made rather than a door deliberately nailed shut, and writing the second as the first is how a
 * gap becomes a decision nobody made. The four `workflow.instances.*` strings are now the OTHER
 * kind and say so in their reason: they guard a controller no live path traverses.
 *
 * The day any of them gains a holder this list shrinks by one, the census in
 * `test/seed-roles.test.ts` fails, and the commit that grants it has to say so.
 */
export const NOT_YET_MODELLED: readonly NotYetModelled[] = [
  // The four `workflow.definitions.*` strings LEFT this list on 2026-08-23: the owner ruled the
  // Class A ceremony onto `opd_admin` (draft), `owner` (approve + activate) and
  // `medical_superintendent` (approve). See ROLE_MODEL above and the README paragraph beneath the
  // OPD permission table. The four below stay, and the reason is now specific rather than pending.
  ...[
    "workflow.instances.start",
    "workflow.instances.transition",
    "workflow.instances.read",
    "workflow.instances.remediate",
  ].map((permission) => ({
    permission,
    reason:
      "the generic workflow-instance controller is not on any live path: `modules/opd/encounters.ts` " +
      "calls `startInstance` and `transition` in-process, so the OPD flow never traverses these " +
      "routes; granting them would mint authority no role needs (owner ruling 2026-08-23)",
  })),
  {
    permission: "patients.confidential.read",
    reason:
      "spec section 14 confidential/VIP visibility beyond normal RBAC — it wants an owner ruling " +
      "about WHO may see a confidential record, and Plan 11d does not have one",
  },
  {
    permission: "approvals.requests.create",
    reason:
      "billing raises its own approval requests inside the issue transaction; no owner ruling " +
      "yet names a human role that creates one directly (the billing table grants only the " +
      "read/decide pair, to billing_manager)",
  },
  // ──────────────────────────────── PLAN 09 / DD18 — the ten ────────────────────────────────
  //
  // DD18 grants the counter's four (see ROLE_MODEL above) and enters everything partner-facing
  // here, WITH ITS REASON. The reason is the tariff precedent word for word, and it has three
  // parts that all have to be true at once: no role model for these is published anywhere, the
  // pilot's catalogs and agreements are seeded by script rather than maintained by a human at a
  // route (DD3), and every lane they guard ships structurally OFF pending the owner's O-8 ruling
  // on the CA/counsel register. Granting them now would mint authority nobody has asked for, on a
  // trust hospital, for routes that refuse to do anything.
  //
  // AND THIS LIST IS STILL NOT AN EXCEPTIONS LIST. The day the owner rules O-8, these entries
  // leave it, the census below fails, and the commit that grants them has to say so. That is the
  // mechanism working.
  {
    permission: "membership.catalog.manage",
    reason:
      "IT GUARDS NO ROUTE (measured 2026-08-26): its only occurrence in the tree is the membership " +
      "manifest itself. The pilot's plan and coupon catalogs are CONFIG ROWS loaded at " +
      "commissioning rather than maintained by a human at a route (Plan 09 DD3), so there is " +
      "nothing for a holder to reach. Its two siblings — import.run and reconcile.operate — DO " +
      "guard live routes and left this list on 2026-08-26 with the membership_admin role. This one " +
      "waits for the screen that would justify it",
  },
  ...[
    "partners.counterparty.manage",
    "partners.agreement.manage",
    "partners.attribution.issue",
    "partners.ledger.read",
    "partners.statement.import",
    "partners.receivable.operate",
    "partners.pnl.read",
  ].map((permission) => ({
    permission,
    reason:
      "every partner-facing lane ships structurally OFF pending the owner's ruling on the " +
      "CA/counsel register (Plan 09 O-8, deliberately NOT taken this phase): commission accrual, " +
      "receivable expectations and coupon issuance are each gated by a config flag that defaults " +
      "false, no role model for partner administration is published anywhere, and the pilot's " +
      "partners and agreements are seeded at commissioning (Plan 09 DD3/DD18)",
  })),
];

/**
 * The grants OTHER seed scripts already write, derived from the SAME manifests those scripts
 * install so this file cannot become a second copy of them (§2.54). The reachability census
 * counts them as held: they are, on any deployment where those two scripts have run — which
 * production has, measured.
 */
export const GRANTED_BY_OTHER_SEEDS: readonly {
  seed: string;
  roleKey: string;
  permissions: readonly string[];
}[] = [
  { seed: "seed:admin", roleKey: "admin", permissions: authManifest.permissions },
  { seed: "seed:ops", roleKey: "duty_manager", permissions: opsManifest.permissions },
];

/**
 * Titles for the three roles no shipped constant carries. `pharmacy` is a column in the README's
 * OPD permission table and is in NO role-keys constant anywhere in the tree; `cashier` and
 * `billing_manager` are created by `seed:billing` and are absent from `OPD_ROLE_KEYS`. The other
 * six titles are IMPORTED from `OPD_ROLE_KEYS` rather than re-listed, because a fourth copy of
 * "the role keys" is exactly the mechanism this plan exists to close.
 */
export const LOCAL_ROLE_TITLES: Readonly<Record<string, string>> = {
  pharmacy: "Pharmacy (prescription verification)",
  cashier: "Cashier",
  billing_manager: "Billing Manager",
  // Group A, 2026-08-26. None of the three is in `OPD_ROLE_KEYS` and none should be: they are not
  // OPD stations. `tariff_editor` has no staffing card of its own — the price list is maintained by
  // whoever the owner designates, and the card list is a workforce document rather than an RBAC one.
  tariff_editor: "Tariff Editor (drafts the price list; the owner activates)",
  membership_admin: "Membership Administrator (holder-book import and the reconcile queue)",
  biomedical_engineer: "Biomedical Engineer (device and analyzer interfaces)",
  mrd_officer: "MRD Officer (records; requests merges, never approves one)",
};

/** The title for a model role key. Throws rather than inventing one — an unresolved role is a defect. */
export function roleTitle(roleKey: string): string {
  const fromOpd = OPD_ROLE_KEYS.find((r) => r.key === roleKey);
  if (fromOpd !== undefined) return fromOpd.title;
  const local = LOCAL_ROLE_TITLES[roleKey];
  if (local !== undefined) return local;
  throw new Error(
    `role "${roleKey}" resolves to no title — it is in neither OPD_ROLE_KEYS nor LOCAL_ROLE_TITLES. ` +
      `Add it to LOCAL_ROLE_TITLES in the same commit that adds it to ROLE_MODEL.`,
  );
}

/** Every permission the model itself grants, deduped and sorted. */
export function modelPermissions(): string[] {
  return [...new Set(ROLE_MODEL.flatMap((r) => r.permissions))].sort();
}

/**
 * THE MODEL'S CLAIM about what is held once every seed script has run — deduped and sorted.
 *
 * **This is a PREDICTION, not a measurement, and MAJOR 1 was what happens when the two are
 * confused.** Until 2026-08-23 `seedRoles` computed its census and its READY verdict from this
 * function, so it reported permissions as held on the strength of `GRANTED_BY_OTHER_SEEDS` saying
 * `seed:admin` grants them — on a box where `seed-admin.ts` RETURNED EARLY because an admin already
 * existed, and therefore never granted a newly declared `auth.*` string at all (Plan 11e T5 removed
 * that early return; the distinction between a PREDICTION and a MEASUREMENT below is why this
 * function still exists). The census counted
 * 42 held where 33 were granted, which is MAJOR 4's mechanism living inside the artefact built to
 * abolish it.
 *
 * It is still the right thing to state — the model SHOULD be able to say what it expects — but it
 * is now compared against `heldInDatabase()` rather than substituted for it.
 */
export function heldPermissions(): string[] {
  return [
    ...new Set([...modelPermissions(), ...GRANTED_BY_OTHER_SEEDS.flatMap((g) => g.permissions)]),
  ].sort();
}

/**
 * Every permission ACTUALLY held by some role in THIS database, deduped and sorted.
 *
 * Deliberately unfiltered by `ROLE_MODEL`: a permission is reachable if ANY role holds it, and a
 * role this file has never heard of still makes its routes reachable to whoever holds that role.
 * Production carried exactly such a role — `owner`, created by `seed:opd`, holding nothing — for
 * the whole of Plan 11d, and a model-scoped query could not have seen it.
 */
export async function heldInDatabase(db: Db): Promise<string[]> {
  const rows = await db.select({ permission: rolePermissions.permission }).from(rolePermissions);
  return [...new Set(rows.map((r) => r.permission))].sort();
}

export type RoleOutcome = {
  roleKey: string;
  title: string;
  created: boolean;
  granted: string[];
  already: string[];
  holders: number;
};

export type SeedRolesReport = {
  declared: number;
  /** MEASURED from `role_permissions`, never derived from the model (MAJOR 1). */
  held: number;
  notYetModelled: number;
  /** Permissions the model EXPECTS another seed to have granted, which this database does not hold. */
  expectedElsewhereAbsent: number;
  /**
   * The takeover rule's mitigation, MEASURED (11f D2): usernames of the active users holding the
   * whole `auth.*` set at hospital scope. Usernames rather than ids because this is a transcript a
   * person reads — and a username is not credential material, which is why it may appear here.
   */
  fullAdministrators: string[];
  /**
   * States an operator must ACT on that are not verdicts about roles and grants, so they print
   * loudly and leave `ready` — and therefore the exit code — alone. Today: the two-admin shortfall.
   */
  warnings: string[];
  roles: RoleOutcome[];
  problems: string[];
  ready: boolean;
};

/** `createRole` is a bare INSERT and is not idempotent. Guarded here exactly as seed-ops.ts guards it. */
async function ensureRole(db: Db, key: string, title: string): Promise<boolean> {
  const existing = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, key));
  if (existing.length > 0) return false;
  await createRole(db, key, title);
  return true;
}

/**
 * Installs every manifest, syncs the catalog, ensures the nine roles, writes the grants, and
 * returns what it did. Exported so the suite can run it TWICE against one database and prove the
 * idempotence claim by execution rather than by reading the code (Book V5).
 */
export async function seedRoles(db: Db): Promise<SeedRolesReport> {
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);
  await syncPermissions(db, registry);

  const modelKeys = ROLE_MODEL.map((r) => r.roleKey);
  const existingGrants = await db
    .select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleKey, modelKeys));
  const alreadyGranted = new Set(existingGrants.map((g) => `${g.roleKey}\u0000${g.permission}`));

  const outcomes: RoleOutcome[] = [];
  for (const { roleKey, permissions } of ROLE_MODEL) {
    const title = roleTitle(roleKey);
    const created = await ensureRole(db, roleKey, title);
    const granted: string[] = [];
    const already: string[] = [];
    for (const permission of permissions) {
      if (alreadyGranted.has(`${roleKey}\u0000${permission}`)) {
        already.push(permission);
        continue;
      }
      // Refuses any string the installed manifests do not declare — the leg that turns a typo
      // into a loud failure instead of a permission nobody can ever hold.
      await grantPermissionToRole(db, registry, roleKey, permission);
      granted.push(permission);
    }
    const holders = await withTx(db, (tx) => usersHoldingRole(tx, roleKey));
    outcomes.push({ roleKey, title, created, granted, already, holders: holders.length });
  }

  const declared = registry.allPermissions();
  // MAJOR 1's fix. This was `new Set(heldPermissions())` — the model describing itself. It is now
  // read back out of the database this run just wrote to, so every verdict below is about THIS
  // deployment rather than about the constants at the top of this file.
  const held = new Set(await heldInDatabase(db));
  const notYetModelled = new Set(NOT_YET_MODELLED.map((n) => n.permission));

  const problems: string[] = [];
  const orphans = declared.filter((p) => !held.has(p) && !notYetModelled.has(p)).sort();
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} declared permission(s) are held by NO role and are not listed as ` +
        `not-yet-modelled: ${orphans.join(", ")}. Each one is a route that answers 403 to ` +
        `everybody, for ever, with nothing anywhere saying so.`,
    );
  }
  const both = declared.filter((p) => held.has(p) && notYetModelled.has(p)).sort();
  if (both.length > 0) {
    problems.push(
      `${both.length} permission(s) are BOTH granted and listed as not-yet-modelled: ` +
        `${both.join(", ")}. That list is where a gap is recorded, never where a grant is hidden.`,
    );
  }
  const undeclared = [...held, ...notYetModelled].filter((p) => !declared.includes(p)).sort();
  if (undeclared.length > 0) {
    problems.push(
      `${undeclared.length} string(s) in the role model or the not-yet-modelled list are declared ` +
        `by NO installed manifest: ${undeclared.join(", ")}.`,
    );
  }
  // The leg MAJOR 1 was missing. `GRANTED_BY_OTHER_SEEDS` asserts that `seed:admin` and `seed:ops`
  // have granted their manifests' permissions; this is where that assertion meets the database.
  // Before Plan 11e, `seed-admin.ts` returned early on any deployment that already had an admin,
  // so a permission declared AFTER first boot was never granted there and nothing else would ever
  // have noticed. T5 deleted that early return; this check stays, because it is what MEASURES
  // whether the repair was actually run.
  const expectedElsewhere = heldPermissions().filter((p) => !modelPermissions().includes(p));
  const expectedElsewhereAbsent = expectedElsewhere.filter((p) => !held.has(p)).sort();
  if (expectedElsewhereAbsent.length > 0) {
    problems.push(
      `${expectedElsewhereAbsent.length} permission(s) the role model EXPECTS another seed to have ` +
        `granted are not held by any role in this database: ${expectedElsewhereAbsent.join(", ")}. ` +
        `GRANTED_BY_OTHER_SEEDS names ${GRANTED_BY_OTHER_SEEDS.map((g) => g.seed).join(" and ")}; ` +
        `run the missing one. Since Plan 11e, RE-RUNNING seed:admin IS the repair: it reconciles ` +
        `its grants on every invocation instead of returning early on a deployment that already ` +
        `has an admin.`,
    );
  }

  /**
   * PLAN 11f D2 — THE TWO-ADMIN DETECTOR. The count comes from `fullAdministrators`, the helper
   * `assertMayTakeOver` reads, and NOT from a join written here: §2.89's rule, and C2 was the price
   * of ignoring it. This census is the surface an operator runs before go-live, so it is where an
   * unmet operational mitigation belongs.
   *
   * ═══ IT IS A WARNING, NOT A PROBLEM, AND THE DIFFERENCE IS THE EXIT CODE ═══
   *
   * CORRECTED at 11f's close, on the independent reviewer's M1. This first shipped in `problems`,
   * which feeds `ready`, which feeds `process.exitCode` — so a deployment with one administrator
   * exited 1 for ever, and that is CODE ENFORCEMENT of the very invariant D2 marked dead in place
   * as unsatisfiable. Worse, it is enforcement through the one channel 11d built to mean something
   * else: `seed:roles`'s exit value is a verdict about ROLES AND GRANTS, the deploy checklist says
   * "confirm it exits 0", and a permanently-1 exit teaches an operator to stop reading it — which
   * is §2.63(b)'s dead-watchdog problem arriving from the other direction.
   *
   * `warnings` prints as loudly as `problems` and changes no verdict. That is exactly what D2 says
   * ships: the census "prints the full-administrator count and warns by name when it is below two".
   */
  const adminIds = await withTx(db, (tx) => fullAdministrators(tx));
  const adminNames = adminIds.length === 0
    ? []
    : (await db.select({ username: users.username, id: users.id }).from(users)
        .where(inArray(users.id, adminIds))).map((u) => u.username).sort();
  const warnings: string[] = [];
  if (adminNames.length < 2) {
    warnings.push(
      `${adminNames.length} user(s) hold the FULL auth.* set at hospital scope` +
        (adminNames.length === 0 ? "" : `: ${adminNames.join(", ")}`) +
        `. The takeover rule (2026-08-24) lets a credential reset be performed only by somebody ` +
        `whose auth.* set is a SUPERSET of the target's — so below TWO holders, a forgotten ` +
        `password at the TOP of this deployment may have no repair but direct database access. ` +
        `Create a second one and assign it the admin role; this line goes quiet at two.`,
    );
  }

  const unheld = outcomes.filter((o) => o.holders === 0).map((o) => o.roleKey);
  if (unheld.length === outcomes.length) {
    problems.push(
      `NO USER HOLDS ANY OF THE ${outcomes.length} ROLES — the grants above exist and every one ` +
        `of those routes still answers 403 to every user on this deployment. Roles are minted ` +
        `here and ASSIGNED separately, at hospital scope.`,
    );
  } else if (unheld.length > 0) {
    problems.push(`roles with zero holders: ${unheld.join(", ")} — their routes are reachable by nobody.`);
  }

  return {
    declared: declared.length,
    held: held.size,
    notYetModelled: notYetModelled.size,
    expectedElsewhereAbsent: expectedElsewhereAbsent.length,
    fullAdministrators: adminNames,
    roles: outcomes,
    problems,
    warnings,
    // `warnings` is DELIBERATELY not part of this: see the two-admin block above.
    ready: problems.length === 0,
  };
}

/** The transcript. Returned as lines so its shape is testable and `main` prints it verbatim. */
export function formatReport(report: SeedRolesReport): string[] {
  const lines: string[] = [];
  lines.push(`permissions catalog synced from ALL_MANIFESTS: ${report.declared} declared`);
  lines.push("");
  for (const role of report.roles) {
    lines.push(
      `role "${role.roleKey}": ${role.created ? "CREATED" : "already present"} · ` +
        `${role.granted.length} granted, ${role.already.length} already · ${role.holders} holder(s)`,
    );
  }
  lines.push("");
  // The census RECONCILES or it says why it does not. Before MAJOR 1's fix these three numbers
  // always summed, because two of them were computed from the same constants — a sum that proved
  // arithmetic rather than a deployment.
  const unaccounted =
    report.declared - report.held - report.notYetModelled - report.expectedElsewhereAbsent;
  lines.push(
    `census (MEASURED from role_permissions): ${report.declared} declared · ${report.held} held by ` +
      `a role in THIS database · ${report.notYetModelled} not yet modelled` +
      (report.expectedElsewhereAbsent > 0
        ? ` · ${report.expectedElsewhereAbsent} expected from another seed but ABSENT here`
        : "") +
      (unaccounted !== 0 ? ` · ${unaccounted} UNACCOUNTED` : ""),
  );
  lines.push(
    "the model is checked against the MANIFESTS, never against the README: grantPermissionToRole " +
      "refuses any string no installed manifest declares.",
  );
  // Printed on EVERY run, green or not (11f D2). A detector that speaks only when it is unhappy
  // cannot be told apart from a detector that has stopped looking — §2.63(b)'s heartbeat lesson,
  // one surface over.
  lines.push(
    `full administrators (whole auth.* set, hospital scope, active): ${report.fullAdministrators.length}` +
      (report.fullAdministrators.length === 0 ? "" : ` — ${report.fullAdministrators.join(", ")}`),
  );
  lines.push("");
  // Printed BEFORE the verdict and just as loudly, because a warning that scrolls past above a
  // green READY line is a warning nobody reads. It does not change the verdict below.
  if (report.warnings.length > 0) {
    lines.push("** ACT ON THIS — it does not change the verdict below".padEnd(72, " "));
    for (const warning of report.warnings) lines.push(`** ${warning}`);
    lines.push("");
  }
  if (report.problems.length > 0) {
    lines.push("!! NOT READY".padEnd(72, " "));
    for (const problem of report.problems) lines.push(`!! ${problem}`);
    lines.push("");
    lines.push("Roles and grants are in place; what is named above is not.");
  } else {
    lines.push(
      `READY: every one of the ${report.declared} declared permissions is reachable — ` +
        `${report.held} held by a role, ${report.notYetModelled} recorded as not yet modelled — ` +
        `and every role in the model has at least one holder.`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await seedRoles(db);
    for (const line of formatReport(report)) console.log(line);
    // THE EXIT CODE FOLLOWS THE VERDICT, because a caller that cannot see the transcript still has
    // to be told. This script previously exited 0 unconditionally — while reporting orphaned
    // permissions, undeclared strings, or that no user holds any role — and `seed-staff.ts` (11d
    // T2) already does the right thing, so the two disagreed about what one printed verdict meant.
    // 11d's discovery review measured the disagreement and named the cost: the deploy checklist
    // asks an operator to "confirm it exits 0", which was a check that could not fail, and
    // `seed:roles && ...` under `set -e` went green on a run that had named real problems.
    process.exitCode = report.ready ? 0 : 1;
  } finally {
    await pool.end();
  }
}

// Guarded so `test/seed-roles.test.ts` can import the model and `seedRoles` without the script
// running itself on import. `tsx scripts/seed-roles.ts` still runs it: apps/core declares no
// `"type": "module"`, so this file is CommonJS and `require.main` is this module.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
