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
      // RC-1 T2 / D5 — the counter-flow lock pill. DECIDED (2026-08-31): no `counter_supervisor`
      // role is minted; this role already carries the desk's SLA escalation and queue-transfer
      // authority, and the flow flip is the same altitude of act. `opd.config.manage` stays on
      // `opd_admin` alone — the pill is not the config editor.
      "opd.counter.flow.manage",
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
      /**
       * RC-2 T4 / D5 — ENROL IS NOT APPLY, and the supervisor is where the line falls.
       *
       * The Registration Counter handoff rules it: "this seat APPLIES membership benefits and
       * cannot ENROL — enrolment is the front-office manager. Model it as two permissions from day
       * one." `front_office` holds `recognise` and deliberately NOT this. The clerk who honours a
       * card at the counter cannot mint one.
       *
       * It guards `POST /membership/instruments/enrol`, which refuses on MEMBERSHIP_SALES_ENABLED
       * while owner ruling O-15 is open. A locked door, not an absent one — which is exactly the
       * distinction `membership.catalog.manage` below is parked for failing.
       */
      "membership.instrument.enrol",
      "membership.grace_honor.request",
      /**
       * PLAN 07c T9 / DD14 — the supervisor's named-staff view, and this is the role the phrase
       * "the supervisor" in that ruling actually means. It buys the FIGURES: what a named person
       * did, how much they collected, how their week compares to their own median. It does NOT buy
       * the patient rows behind those figures — `staff.reports.drill` is a SEPARATE string, and the
       * owner ruled on 2026-08-29 that it goes to `staff_auditor` and to nobody else. This role is
       * three people; that one is one person. The split is DD14 working.
       */
      "staff.reports.read",
    ],
  },
  {
    roleKey: "vitals_desk",
    permissions: [
      "opd.visits.read",
      "opd.vitals.record",
      "opd.queue.read",
      /**
       * VD-1 T4 — the pre-stage read, and it closes a gap the bay could not cross. Staging the
       * file before the patient sits down, and carrying a height forward greyed and locked
       * (flow3 T5's ruling), both need the LAST reading — and the only cross-visit reader was
       * gated on `opd.consult`, which this role does not and should not hold. The narrow
       * permission is the answer; the block below's own argument applies unchanged.
       */
      "opd.vitals.history.read",
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
      // VD-1 T4 — the doctor already reaches every reading through `opd.consult`
      // (`patientVitalsHistory`); this grant is what lets the same screens use the CHEAP one-row
      // pre-stage instead. Granted for symmetry rather than reach: a permission held by the bay
      // and not by the clinician it hands to is a permission somebody will widen the wrong way.
      "opd.vitals.history.read",
      "opd.queue.read",
      "opd.queue.operate",
      "opd.consult",
      // PLAN 16a / DD10, 2026-08-26. The spec's words are "read for any prescriber": the consult
      // screen's formulary autocomplete (T6) sets the `medicineId` that turns a free-text line into
      // a checked one, and a doctor who cannot read the formulary gets the legacy substring allergy
      // check and nothing else. READ ONLY — the master is curated at the pharmacy, not the desk.
      "formulary.read",
      /**
       * PLAN 07d T5 / DD6 — ONE of the two grants DD6 names, and only one. `tariff.read` lets the
       * cockpit browse the priced service catalogue so a doctor can advise tests WITH their prices
       * (DD4) — which is the question a patient actually asks at the chair, and which the doctor
       * currently cannot answer without walking to the counter.
       *
       * **`materials.stock.read` IS DELIBERATELY NOT GRANTED HERE.** DD6 names both, but it belongs
       * to T3/T4 — the drug-availability panel — and those are GATED on owner item O-1: zero
       * `formulary_medicines` are seeded and the `pharmacy` role has no holders, so the panel would
       * ship as a well-built empty box. Granting the permission ahead of the feature would mint
       * authority that reaches nothing, which is exactly the state `NOT_YET_MODELLED` exists to
       * make visible rather than to hide.
       */
      "tariff.read",
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
      /**
       * ═══ PLAN 17 T2 / DD16 — THE DOCTOR ORDERS, AND THE DOCTOR READS ═══
       *
       * `advised_tests` (07d) is a SUGGESTION the counter converts; this is the doctor placing the
       * order themselves. Both halves of the gate are granted together — `orders.place` is useless
       * alone by design (`placeOrder` requires the kernel permission AND the kind's own, so holding
       * one makes a pharmacist no imaging requester) and `lab.orders.place` is unreachable without
       * it.
       *
       * **`lab.results.read` is the safety grant of this whole phase.** DD6's interlock holds a
       * PRINTED report until a self-pay balance settles; it never holds a clinician's read, and
       * `listResultsForEncounter` returns verified results for an unpaid order (T7 A3). That rule
       * needs a permission the doctor can hold WITHOUT being able to key or sign a result, which is
       * why `lab.results.read` is separate from `.enter` and `.verify`.
       *
       * `orders.cancel` rides with them: the doctor who ordered a test is the person who calls it
       * off, and phase 0 parked that string for "the departmental decision" this plan now makes.
       */
      "lab.orders.place",
      "lab.results.read",
      "lab.catalogue.read",
      "orders.place",
      "orders.read",
      "orders.cancel",
      /**
       * ═══ PLAN 18a T2 — THE REFERRING CLINICIAN'S HALF, AND THE ROLE IS `doctor` ═══
       *
       * §5 T2's role sketch names this role `consultant`. **There is no `consultant` role in this
       * repository** — the treating clinician has been `doctor` since Plan 02, it is the key the
       * imaging workflow's own transitions name (`scheduled → cancelled`, `open → satisfied`), and
       * `lab.orders.place` was granted here rather than to an invented sibling for the same reason.
       * Declaring a second clinician role would split every future grant across two keys and make
       * "can the treating doctor do this?" a question with two answers. **DECIDED: grant to
       * `doctor`; recorded as finding F10.**
       *
       * `radiology.reports.read` and not `radiology.worklist.read`: the doctor reads the REPORT of
       * the patient in front of them. The worklist is a departmental queue and, per DD11, a
       * confidentiality-bearing one — a doctor browsing every scan in the hospital is exactly the
       * read the alias rules exist to prevent.
       */
      "radiology.orders.place",
      "radiology.reports.read",
    ],
  },
  {
    roleKey: "opd_admin",
    permissions: [
      "opd.masters.read",
      "opd.masters.manage",
      "opd.config.manage",
      "opd.counter.flow.manage", // RC-1 T2 — the admin who edits the whole config can also flip the flow
      "opd.appointments.read",
      // Owner ruling 2026-08-23: the OPD masters administrator DRAFTS workflow definitions.
      // Drafting only — the SoD pair `workflow_drafter_activator` forbids the same person
      // activating what they drafted, so `.activate` deliberately lives on `owner` instead.
      "workflow.definitions.draft",
      "workflow.definitions.read",
      // ── PLAN 13 / DD14, 2026-08-26 — the registry is read by the role that reads rooms today ──
      //
      // `resources.read` guards the three registry read routes (tree, board, history). It lands on
      // `opd_admin` and NOWHERE ELSE, and that is a minimum-authority choice rather than a
      // conservative one: this role already holds `opd.masters.read` and `opd.masters.manage`, so
      // it already reads and writes the room book. After T6 those rooms ARE registry rows. Granting
      // the registry read to the role that could already see the same data creates NO NEW
      // AUTHORITY — 16a DD10's posture, and the reason this line needs no owner ruling.
      //
      // THERE IS NO `resources.manage`, deliberately (DD14). Master writes for rooms keep going
      // through the `opd.masters.manage`-guarded OPD routes, which now delegate into the registry;
      // the first module that needs a registry WRITE route declares and mounts its own permission
      // with it. A `manage` string declared here would be held by somebody and reach nothing, which
      // is the trap on line 160 seen from the other side.
      "resources.read",
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
      // ── PLAN 16a / DD10, 2026-08-26 — the formulary is curated HERE and nowhere else ──
      //
      // The spec says "pharmacist-gated", twice (§1.1): a mined composition reaches a live table
      // only when a pharmacist admits it, one item at a time. All three strings therefore land on
      // this role, and `formulary.read` is on `doctor` as well because prescribing consumes the
      // master that dispensing curates.
      //
      // THIS GRANTS LIVE AUTHORITY TO NOBODY TODAY, and that is measured rather than hoped:
      // `pharmacy` is one of the three roles this script creates with grants and no holders (see
      // the header). The grant is a door that opens the day a pharmacist account exists — which is
      // the right order, because the alternative is a formulary nobody may curate.
      "formulary.read",
      "formulary.manage",
      "formulary.staging.review",
      // ── PLAN 14 / DD11, 2026-08-27 — THE PHARMACIST IS THE QC SIGNATORY FOR DRUGS ──
      //
      // `materials.grn.qc` is the VERDICT half of DD8's two-stage gate: a storekeeper captures what
      // came off the lorry so the lorry can leave, and somebody competent to judge a drug decides
      // whether it may go on a shelf. Doc 09 §7's "who signs what" gives that signature to the
      // pharmacist for drug classes, and `storekeeper` deliberately does NOT hold it.
      //
      // The two READ halves come with it for a reason that is about this repo rather than about
      // the ward: `pharmacy` already curates the formulary (16a, above), and an item is the shelf
      // side of a medicine. A curator who can see `Crocin 500mg tablet` in `formulary_medicines`
      // and cannot see that it is stocked as `CROC500` in three stores is curating half a fact.
      // `materials.stock.read` is what makes a QC verdict informed — "we already hold 4,000 of
      // these, expiring in March" is the context in which accepting short-dated stock is decided.
      //
      // NOT `materials.items.manage`: registering an item is a master-data act with an HSN code and
      // a GST rate on it, and it belongs to `materials_head`. Read here, write there.
      "materials.items.read",
      "materials.stock.read",
      "materials.grn.qc",
      // PLAN 16c T1 — THE DISPENSING COUNTER, +11. The four `pharmacy.*` strings are the counter's
      // own; `orders.place/read/cancel` because the claim PLACES the `medication` order (D1, the
      // `lab_reception` shape); and the four billing strings `lab_reception` holds for the same
      // reason — a department counter that bills at the window issues the invoice itself (S3).
      // NOT `billing.credit.extend`: credit holds for IPD/TPA are 16d's.
      "pharmacy.dispense.place",
      "pharmacy.dispense.read",
      "pharmacy.dispense.scheduled",
      "pharmacy.sale_items.manage",
      "orders.place",
      "orders.read",
      "orders.cancel",
      "billing.invoice.issue",
      "billing.invoice.read",
      "billing.receipt.record",
      "billing.session.own",
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
      /**
       * PLAN 17 T2 / DD6 — **THE INTERLOCK'S OVERRIDE, AND IT LIVES HERE RATHER THAN IN THE LAB.**
       *
       * A held report is a self-pay balance the hospital has not collected. Releasing it anyway is
       * a decision to carry that receivable, which is this office's decision and not the
       * pathologist's — and the pathologist is the person standing in front of the patient asking.
       * The approval type `lab_release_unpaid` names this same role as its approver, so the ask and
       * the answer are the same desk by design.
       *
       * **The release writes no credit note and moves no dues row** (T7 A4): the money was already
       * a receivable before it and is the same receivable after. A release that quietly wrote off
       * the balance would make the interlock a discount mechanism, which is 02 O-1's opposite.
       */
      "lab.reports.release_unpaid",
      /**
       * PLAN 18a T2 — the imaging BILL-DECISION queue (T7). A repeat scan, a contrast escalation
       * and an abandoned acquisition each raise a question that is only ever answered in money:
       * does the patient pay for the second film? That is this office's decision for the same
       * reason the release above is, and `radiology_receptionist` holds it too because the desk
       * settles the ordinary case at the counter without a queue.
       */
      "radiology.bill_decisions.manage",
      /**
       * ═══ PLAN 07b O-1, ANSWERED BY THE OWNER 2026-08-29: THE BILLING MANAGER COVERS ═══
       *
       * A paise mismatch at close moves a cashier session to `closing` and locks that person out of
       * ALL counter work until a `billing_manager` grants a variance approval. Under ruling R-4 —
       * ONE staffer on the counter, because traffic is low — that closes registration and
       * visit-opening too, not just billing. It closes the hospital's front door.
       *
       * The control is correct and stays. What O-1 asked was **who covers**, and whether they hold
       * counter standing or are granted it at the moment. The owner named `billing_manager`, and
       * the seven strings below are STANDING rather than a temp-role grant for one reason: the
       * counter is DOWN while the cover is arranged. A cover that first needs a `duty_manager` to
       * be on site at 21:00 to grant a temp role is a cover that exists on paper.
       *
       * ═══ WHY THESE SEVEN AND NOT `front_office` + `cashier` WHOLESALE ═══
       *
       * They are exactly what `counter-desk.tsx` calls to work one walk-in end to end: the
       * department list, the queue summary, patient search, the walk-in (which asserts
       * `patients.register` inside the service — the stacked-decorator finding), the fee quote, the
       * invoice, and the manager's OWN drawer. `billing.credit.extend` is DELIBERATELY NOT among
       * them: a credit-extended invoice is a billing exception, this role approves billing
       * exceptions, and a stopgap cover has no business creating one it could then approve.
       *
       * ═══ THE SoD CONTROL THAT MATTERS STILL HOLDS, AND IT WAS CHECKED ═══
       *
       * `assertNotSodPair(REQUESTER_APPROVER_PAIR, requester, actor)` in
       * `kernel/approvals/decisions.ts` compares the two PEOPLE on one item, not the roles a person
       * holds. So a manager covering a counter still cannot approve their own variance — which is
       * the whole reason the lockout exists. Holding both roles is not the violation; acting on
       * both sides of one approval is, and that is refused in its own transaction with a
       * `sod.violation_blocked` row.
       */
      "opd.masters.read",
      "opd.queue.read",
      "patients.read",
      "patients.register",
      "opd.visits.open",
      "billing.invoice.issue",
      "billing.session.own",
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
      // ═══ PLAN 15 / DD14, WITH A CORRECTION THE SPIKE FORCED (finding T2-d) ═══
      //
      // DD14 says *"`billing_counter` (existing) gains `ot.bill.compose`"*. **There is no
      // `billing_counter` role.** It is in no `ROLE_MODEL` row, no `OPD_ROLE_KEYS` entry and no
      // `LOCAL_ROLE_TITLES` key, and Spike Q3 confirmed production has none either — the counter is
      // `cashier` and its supervisor is `billing_manager`. Granting a string to a role that does
      // not exist would make `ot.bill.compose` a permission nobody can ever hold, which is the
      // exact `NOT_YET_MODELLED` failure this file was rewritten to make visible.
      //
      // It goes to `billing_manager` and NOT to `cashier`, deliberately. `composeDischargeBill`
      // does not take a typed amount: it reads the ledger, applies `min(tariff, MRP, ceiling)`,
      // allocates the deposit hold and can raise a refund request. That is the money act of the
      // whole phase, and it belongs with the role that already approves every billing exception,
      // not with the desk that takes the cash.
      "ot.bill.compose",
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
      /**
       * PLAN 07c T9 / DD14 — the same figures, for the same reason the two review desks moved here
       * in the first place: medical-record and staff governance is this role's job (spec §14, role
       * card #39). A Medical Superintendent asked why a department's throughput fell should be able
       * to look without borrowing the technical administrator's account.
       */
      "staff.reports.read",
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
      // PLAN 15 / DD14 — THE OT DEFINITION DESK. `ot_definition_publish` names this role as its
      // `approverRole`, and DD6 puts the criteria whitelist, the privilege list, the deposit policy
      // and the PACU thresholds behind it: what the unit may operate on, and who may operate. That
      // is a clinical-governance decision, which is exactly what this office is. `.read` comes with
      // it because approving a whitelist you cannot open is a coin flip — the same sentence three
      // lines up, applied to a definition instead of a patient.
      "ot.definitions.read",
      "ot.definitions.manage",
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
  /**
   * ═══ PLAN 07c T9 / DD14 — OWNER RULING 2026-08-29: ONE NAMED PERSON MAY OPEN THE ROWS ═══
   *
   * `staff.reports.drill` reveals the PATIENT ROWS behind a colleague's figures. 07c shipped it
   * held by nobody on purpose, because who may read another person's shift is a question for
   * whoever is answerable under DPDP rather than a default. The owner has now answered it.
   *
   * **IT IS ITS OWN ROLE, ASSIGNED TO ONE PERSON, AND THAT IS THE POINT.** The obvious shortcut was
   * to add the permission to `duty_manager`, which the named person already holds — and that would
   * have handed patient rows from every shift to THREE people instead of one, undoing the narrowness
   * DD14 exists to create. A permission whose whole design is "deliberately narrow" must not be
   * widened by the convenience of an existing role.
   *
   * It carries `staff.reports.read` as well, because drilling without reading is incoherent: the
   * drill opens the rows BEHIND a figure, and a holder who cannot see the figure has nothing to
   * drill from.
   *
   * `seed:roles` mints the role and assigns NOBODY (this file's own header rule). Handing it to a
   * human is a separate, deliberate act — the runbook records who.
   */
  { roleKey: "staff_auditor", permissions: ["staff.reports.read", "staff.reports.drill"] },
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
      // RC-2 T4 / D5 — the role that works the holder book is also the role that may put somebody
      // INTO it from the counter. Guards a real route that refuses on MEMBERSHIP_SALES_ENABLED
      // while O-15 is open; see the supervisor block above for the ruling.
      "membership.instrument.enrol",
      // `membership.catalog.manage` is NOT here and that is measured, not squeamish: it guards NO
      // ROUTE ANYWHERE IN THE TREE. Its only occurrence is the manifest. Granting it would hand
      // somebody a key to a door that does not exist — the same mistake `auth.break_glass.use`
      // would have been. It stays in `NOT_YET_MODELLED` with that reason.
      //
      // RC-2 T4 RE-MEASURED IT AND THE ANSWER IS UNCHANGED: still 0 occurrences outside the
      // manifest. `membership.instrument.enrol` was minted beside it in the same commit and DOES
      // get granted, which is the distinction drawn sharply: enrol guards a door that exists and is
      // locked by a flag; catalog.manage guards no door at all. RC-2 builds no catalog screen —
      // that is Plan 22 T1 — so this waits, still, for the screen that would justify it.
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
      /**
       * OWNER RULING 2026-08-29, after Plan 22c-A deployed — THE PRIVACY WRITE SPLIT GETS ITS HOLDER.
       *
       * 22c-A declared these two and granted them to NOBODY on purpose (DD7): the phase that removes
       * a power from `patients.update` must not hand it straight back, and WHO may hide a patient or
       * mark one dead is an owner ruling rather than an engineering choice. The ruling is now made,
       * and it is the MRD officer — the custodian of the medical record, already the only holder of
       * `patients.merge`, and one person in this hospital.
       *
       * Read them beside `patients.merge` above: merging two records for one person and deciding
       * that a person is invisible or deceased are the same kind of authority over the same object,
       * and they now sit with the same role. `patients.confidential.read` stays unheld — seeing a
       * confidential record is a separate question the owner has not been asked yet.
       */
      "patients.confidential.write",
      "patients.deceased.write",
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
  // ------------------------------------------------------------------------------------------
  // PLAN 14 / DD11, 2026-08-27 — TWO ROLES FOR THE STORES, AND THE SPLIT BETWEEN THEM IS THE POINT.
  //
  // Both are created by this script with grants and NO HOLDERS — the `pharmacy` / `tariff_editor`
  // precedent, and it is measured rather than hoped: production held 33 users and no storekeeper at
  // kickoff. The grant is a door that opens the day a storekeeper account exists, which is the
  // right order, because the alternative is a store nobody may operate.
  //
  // ═══ WHY TWO ROLES AND NOT ONE ═══
  //
  // A single `stores` role would be the cheap thing to write and it would collapse the only
  // separation this phase can honestly express. `storekeeper` is an OPERATOR: receive the lorry,
  // move stock between stores, read what is on a shelf. `materials_head` is ACCOUNTABLE: what the
  // hospital may buy, who it may buy from, whose stock is frozen, and whether short-dated goods are
  // accepted.
  //
  // The SoD pairs doc 09 §10 names — PO-approver/GRN-receiver, custodian/counter — cannot be built
  // in this phase, because neither a purchase order (14b) nor a cycle count (14c) exists, and
  // because a two-key rule needs a SECOND APPROVING ACTOR that production does not have (runbook
  // O1: one full admin, 33 users). Inventing a third pair here would be a rule nobody ruled. What
  // IS built is the permission SPLIT those pairs will hang on, so that the day O1 is discharged the
  // strings are already distinct and the pair is a `sod_pairs` row rather than a refactor.
  // ------------------------------------------------------------------------------------------
  {
    roleKey: "materials_head",
    permissions: [
      // All eleven. The person accountable for what the hospital owns holds every string the module
      // declares — including `materials.recall.manage`, which is the narrowest grant in the phase:
      // DD14's freeze is one action that stops every location's stock of a batch at once, and the
      // people who should be able to fire it are the people who will answer for having fired it.
      "materials.items.read",
      "materials.items.manage",
      "materials.vendors.read",
      "materials.vendors.manage",
      "materials.stores.manage",
      "materials.stock.read",
      "materials.grn.capture",
      "materials.grn.qc",
      "materials.stock.issue",
      "materials.stock.receive",
      "materials.recall.manage",
    ],
  },
  {
    roleKey: "storekeeper",
    permissions: [
      // The six an operator needs, and the five absences are the decision. NOT `items.manage` or
      // `vendors.manage`: a storekeeper who could register a vendor could receive from one nobody
      // approved, which is the whole of what a vendor master is for. NOT `grn.qc`: see the
      // `pharmacy` row above. NOT `stores.manage`: creating a stock location changes the shape of
      // the ledger's key space, and `ensureTransitStore` creates the only one an operator needs.
      // NOT `recall.manage`.
      "materials.items.read",
      "materials.vendors.read",
      "materials.stock.read",
      "materials.grn.capture",
      "materials.stock.issue",
      "materials.stock.receive",
    ],
  },
  // ------------------------------------------------------------------------------------------
  // PLAN 15 T2 / DD14 — THE MINI-OT'S SIX ROLES, AND THE THREE SEPARATIONS THAT ARE THE POINT.
  //
  // A day-care theatre is where this system finally has authority worth separating: the person who
  // runs the list, the two who may override a clinical gate, the two who touch the patient, and the
  // one who books. Every separation below is a rule somebody can point at, not an org chart.
  //
  //   1. **`ot_incharge` does NOT hold `ot.gates.override`, `ot.definitions.manage` or
  //      `ot.bill.compose`.** The person under the most pressure to start the list on time is
  //      exactly the person who must not be able to wave a gate through, redefine what the unit may
  //      operate on, or bill for it.
  //   2. **`surgeon` AND `anaesthetist` both hold `ot.gates.override`**, because DD5's override
  //      requires two DISTINCT actors holding those two roles. One role holding it would make the
  //      two-key rule satisfiable by one person with two logins — which is the theatre this
  //      repository already refuses elsewhere.
  //   3. **`recovery_nurse` holds `ot.discharge` and `ot_nurse` does not.** A day-care patient
  //      leaves from the bay, and the person who signs her out is the person who scored her.
  //
  // Every one of these six is minted with grants and NO HOLDERS — the `pharmacy` and
  // `materials_head` precedent, and `seed:roles` assigns nobody by design. Spike Q3 measured
  // production: none of these six role keys exists there yet, so this seed creates all six empty.
  // ------------------------------------------------------------------------------------------
  {
    roleKey: "ot_incharge",
    permissions: [
      "ot.definitions.read",
      "ot.cases.read",
      "ot.cases.book",
      "ot.cases.cancel",
      "ot.list.manage",
      "ot.gates.satisfy",
      "ot.cockpit.operate",
      "ot.implants.scan",
      "ot.counts.record",
      "ot.recovery.operate",
      "ot.discharge",
      // PLAN 17 T2 / DD16 — the pre-op panel. A day-care case's fitness bloods are ordered from the
      // theatre, not from an OPD chair, and the booking coordinator is who does it. Both halves of
      // the gate together, for the reason the `doctor` row above gives at length.
      "lab.orders.place",
      "lab.catalogue.read",
      "orders.place",
      "orders.read",
    ],
  },
  {
    roleKey: "surgeon",
    permissions: [
      "ot.cases.read", "ot.definitions.read", "ot.gates.override", "ot.cockpit.operate",
      // PLAN 17 T2 / DD16 — the surgeon orders the pre-op panel and reads it. NOT `orders.cancel`:
      // calling off a lab order the coordinator placed is the coordinator's act, and the surgeon
      // asking for it is one message rather than one permission.
      "lab.orders.place", "lab.results.read", "lab.catalogue.read", "orders.place", "orders.read",
    ],
  },
  {
    roleKey: "anaesthetist",
    permissions: ["ot.cases.read", "ot.definitions.read", "ot.gates.override", "ot.cockpit.operate"],
  },
  {
    roleKey: "ot_nurse",
    // NOT `ot.discharge` — see separation 3 above. NOT `ot.gates.satisfy`: the gates are the
    // coordinator's and the clinicians', and a scrub nurse satisfying a consent gate is the
    // documentation-gate failure mode this module is built to remove.
    permissions: ["ot.cases.read", "ot.cockpit.operate", "ot.implants.scan", "ot.counts.record"],
  },
  {
    roleKey: "recovery_nurse",
    permissions: ["ot.cases.read", "ot.recovery.operate", "ot.discharge"],
  },
  {
    roleKey: "daycare_coordinator",
    permissions: ["ot.cases.read", "ot.cases.book", "ot.cases.cancel", "ot.gates.satisfy", "ot.list.manage", "ot.definitions.read"],
  },
  // ══════════════ PLAN 17 T2 / DD16 — THE LABORATORY'S FOUR ROLES ══════════════
  //
  // S10 cards 16 (`pathologist`), 17 (`lab_technician`) and 36 (`phlebotomist`), plus the counter
  // role the brainstorm calls lab reception. Four separations decide every row below, and each one
  // is a rule the module ENFORCES rather than a preference:
  //
  //   1. **`lab.results.verify` is the pathologist's alone.** DD11's SoD is enforced per RESULT ROW
  //      (`verified_by <> entered_by`), not by role — but a technologist who could verify would make
  //      the row-level check the ONLY thing standing between a keyed number and a signed report, and
  //      one person with two logins would defeat it. The role separation and the row check are two
  //      controls on one risk, deliberately.
  //   2. **`lab_reception` holds NO `lab.results.*` at all.** It is a counter: it orders, bills,
  //      prints and hands over. A front-office login that could read every result in the building
  //      is exactly the confidentiality hole `restricted` and the alias rule exist to close, and
  //      granting `lab.results.read` "for convenience" would open it at the busiest desk.
  //      **Amended by the OWNER 2026-09-02 (Plan 17c §7, decision 2):** printing IS reading the
  //      paper. The report centre (`/lab/reports`) renders a SIGNED report to `lab.reports.print`
  //      holders — aliased, one `phi_access_log` row per read, and only once the interlock allows
  //      the hand-over; a HELD report never reaches the counter as a page. What stays refused is the
  //      worklist's numbers before signature and every list's restricted test NAMES: the paper is
  //      the decision, the lists are the guard (17c §8.8).
  //   3. **`phlebotomist` reads the worklist and touches no result.** The chair needs to know WHO
  //      is next and WHAT tube; it never needs a number.
  //   4. **`lab.reports.release_unpaid` goes to `billing_manager` and to nobody in the lab.** The
  //      interlock collects a self-pay balance (DD6); the decision to hand the document over anyway
  //      is a decision to carry a receivable, and that is the money office's to make. The lab asks;
  //      billing answers. See `modules/lab/approval-types.ts`.
  //
  // ═══ `billing.credit.extend` ON THREE OF THE FOUR, AND IT IS A MEASUREMENT, NOT A PREFERENCE ═══
  //
  // Spike S1, read from `modules/billing/invoices.ts:783,801`: `issueInvoice` REFUSES an invoice
  // that would leave a remainder unless the caller passes `credit: {reason}` AND **holds
  // `billing.credit.extend`**. DD6 has the lab issue exactly such invoices for the three lines the
  // counter never sees — reflex (T6), add-on (T4) and walk-in accession (T5) — so without this
  // grant those three paths throw `credit_permission_required` at the bench, at the chair and in the
  // verifying transaction. `phlebotomist` does not get it: nothing that role does creates a line.
  //
  // This is a grant of an EXISTING billing permission to new roles, not a new permission, and it is
  // recorded as finding F2 of this phase because DD16 did not predict it.
  {
    roleKey: "pathologist",
    permissions: [
      // The lab's clinical head curates the catalogue: the range book, the critical bands and the
      // reflex rules are clinical documents, and NABL asks who signed them off.
      "lab.catalogue.read",
      "lab.catalogue.manage",
      // 17-E T1 — the bench's machines are the lab head's estate for the same reason the range book
      // is: which analyser reports which test, and under whose code, is a document NABL asks about.
      // The BRIDGE never holds this — it authenticates as an agent and may not enrol itself.
      "lab.instruments.manage",
      "lab.worklist.read",
      "lab.accession.operate",
      "lab.results.enter",
      "lab.results.verify",
      "lab.results.read",
      "lab.criticals.close",
      "lab.reports.publish",
      "lab.reports.print",
      "lab.reports.amend",
      // The pathologist of record is the responsible clinician on a walk-in (DD15) and places the
      // add-on the doctor asks for at the chair (DD9). The kernel half and the kind's half are
      // granted together, which phase 0's own NOT_YET_MODELLED entry calls "the only moment either
      // of them means anything".
      "lab.orders.place",
      "orders.place",
      "orders.read",
      "orders.cancel",
      "billing.credit.extend",
    ],
  },
  {
    roleKey: "lab_technician",
    permissions: [
      "lab.catalogue.read",
      "lab.worklist.read",
      "lab.accession.operate",
      "lab.results.enter",
      "lab.results.read",
      // DD12 — the tech OPENS the critical call at entry and closes it on the read-back. The
      // 15-minute clinical need is the call, not the signature: a ladder that could only be closed
      // by a pathologist would sit open all night in the very case it exists for (02 F1).
      "lab.criticals.close",
      "orders.read",
      // T5's walk-in accession with no prior invoice bills on credit — see the header above.
      "billing.credit.extend",
    ],
  },
  {
    roleKey: "phlebotomist",
    permissions: ["lab.catalogue.read", "lab.worklist.read", "lab.collection.operate", "orders.read"],
  },
  {
    roleKey: "lab_reception",
    permissions: [
      "lab.desk.operate",
      "lab.catalogue.read",
      "lab.worklist.read",
      "lab.orders.place",
      "lab.reports.print",
      "orders.place",
      "orders.read",
      "orders.cancel",
      // The front-office half: the desk registers the walk-in who arrives with an outside slip
      // (DD15) and searches for the patient the doctor advised tests for.
      "patients.register",
      "patients.read",
      "patients.update",
      // The cashier half: DD6 posts the money AT ORDER TIME, at this counter, in the placement
      // transaction. A desk that could place but not bill would be the split that makes the
      // interlock necessary in the first place.
      "billing.invoice.issue",
      "billing.invoice.read",
      "billing.receipt.record",
      "billing.session.own",
      "billing.credit.extend",
      /**
       * OWNER RULING 2026-09-02 (Plan 17c §7, decision 1) — the counter RAISES the release request
       * for a HELD report. DD6 keeps the DECISION with `billing_manager` (the approve/reject pair);
       * this is only the right to ask, and the approval type it asks for (`lab_release_unpaid`) is
       * bound to one order and spent on one hand-over. Until this grant no human role could raise
       * it at all, and the seat's button was a 403 for everyone (17c close review pass 1, F2a).
       */
      "approvals.requests.create",
    ],
  },
  /**
   * ═══ PLAN 18a T2 — THE FOUR RADIOLOGY ROLES, AND THE THREE SEPARATIONS THEY ENCODE ═══
   *
   * All four are DECLARED by this phase and production holds ZERO humans in each (S4). That is the
   * `formulary`/`materials`/`ot` shape: the menu entries exist, every one is gated on a permission
   * whose only holders are these roles, and the window stays empty until somebody is assigned.
   *
   * **The three separations are the point, and a permission census cannot see any of them** — it
   * counts to 147 whether or not `radiographer` can sign. T2 A3 pins all three BY NAME in
   * `test/seed-roles.test.ts`, and the gate separation is additionally pinned in
   * `modules/radiology/workflow-def.test.ts` because the workflow engine gates on ROLE KEYS and
   * never consults a permission (finding F9 — the two planes must both say no).
   */
  {
    roleKey: "radiologist",
    permissions: [
      /**
       * The clinical head of the department: reads the worklist, reports, signs, amends, and
       * acknowledges criticals. **`radiology.gates.override` and NOT `radiology.gates.satisfy`** —
       * DD7 makes the radiologist the second clinical opinion on a gate the technologist raised,
       * and `overrideGate` demands a reason and events it. Satisfying a gate is the floor's act;
       * overriding one is the clinician's, and they are different permissions because they are
       * different decisions with different evidence.
       *
       * `pcpndt.form_f.write` because the sonologist IS a radiologist and is the registered person
       * who signs the Form F. **NOT `pcpndt.form_f.verify`** — see `pcpndt_incharge` below.
       */
      "radiology.worklist.read",
      "radiology.gates.override",
      "radiology.acquire",
      "radiology.reports.write",
      "radiology.reports.sign",
      "radiology.reports.amend",
      "radiology.reports.read",
      "radiology.criticals.ack",
      "radiology.definitions.read",
      /**
       * The study-type book — gate sets, pregnancy policy, critical categories — is a CLINICAL
       * document, and NABL and the AERB both ask who signed it off. The lab's precedent is exact:
       * `lab.catalogue.manage` went to the `pathologist` and for the same reason.
       *
       * This does not let the radiologist publish alone. `imaging_definition_publish` names
       * `medical_superintendent` as approver with `actFirstAllowed: false`, so the drafter and the
       * activator are different people by construction (T4's governance). The permission buys the
       * right to DRAFT; the MS decides whether it goes live.
       */
      "radiology.definitions.manage",
      "pcpndt.form_f.read",
      "pcpndt.form_f.write",
      "pcpndt.registrations.read",
      "orders.read",
      /** PLAN 18c T1 / D2 — the cumulative-dose nudge at protocolling (O4). Reads doses, not the file. */
      "aerb.doses.read",
    ],
  },
  {
    roleKey: "radiographer",
    permissions: [
      /**
       * The technologist: checks the patient in, satisfies the safety gates with evidence,
       * acquires. **NOT `radiology.reports.sign`** — the separation the whole department exists
       * around, and T2 A3's mutant is precisely a grant of it here: the census still counts to 147
       * and the separation is gone.
       *
       * `pcpndt.form_f.read` and not `.write`: the radiographer must be able to see that a Form F
       * exists before acquiring (DD14's cannot-close rule refuses the acquisition without one), and
       * writing the statutory declaration is the registered person's act.
       */
      "radiology.worklist.read",
      "radiology.checkin",
      "radiology.gates.satisfy",
      "radiology.acquire",
      "radiology.reports.read",
      "radiology.definitions.read",
      "pcpndt.form_f.read",
      "orders.read",
      // PLAN 18b T1 — the worklist export, so a radiographer can check what the console will show.
      "radiology.mwl.read",
      /**
       * PLAN 18c T1 / D2 — the patient's twelve-month cumulative dose, which is the nudge the
       * console shows before a repeat CT (O4). **`aerb.doses.read` and NOT `aerb.registers.read`**:
       * the licence file, the QA book and the badge register are the RSO's, and a radiographer has
       * no business in any of them.
       */
      "aerb.doses.read",
    ],
  },
  {
    roleKey: "radiology_receptionist",
    permissions: [
      /**
       * The counter: places the order the outside slip carries, schedules it, takes the money and
       * works the bill-decision queue.
       *
       * **NOT `radiology.gates.satisfy`.** The person who books the scan and takes the money does
       * not get to record that the patient is not pregnant. This is the first of the three
       * separations, it is pinned by name in `seed-roles.test.ts`, and — because the workflow
       * engine reads role keys rather than permissions — the role is also absent from the
       * `imaging_gate` definition's `open → satisfied` transition (F8). Withholding it here alone
       * would have been a separation that did not hold.
       *
       * **NOT `radiology.checkin` either**: check-in is where the gate set OPENS from the patient's
       * sex, age and the study type's flags, and it is the radiographer's act at the console.
       */
      "radiology.orders.place",
      "radiology.schedule",
      "radiology.worklist.read",
      "radiology.bill_decisions.manage",
      "radiology.definitions.read",
      "orders.place",
      "orders.read",
      "patients.register",
      "patients.read",
      "billing.invoice.issue",
      "billing.invoice.read",
      "billing.receipt.record",
      "billing.session.own",
    ],
  },
  {
    roleKey: "pcpndt_incharge",
    permissions: [
      /**
       * The statutory officer. Manages the facility registration, the registered machines and the
       * registered persons, and VERIFIES the Form F.
       *
       * **NOT `pcpndt.form_f.write`.** The in-charge verifies what others wrote — the third
       * separation. `verifyFormF` additionally refuses when the verifier IS `signed_by`
       * (`same_actor`), so the rule survives one person holding two roles, which is the state a
       * hospital with one sonologist will actually be in. An officer who could write and
       * self-verify a statutory declaration is a single point of failure with a criminal statute
       * behind it.
       */
      "pcpndt.registrations.manage",
      "pcpndt.registrations.read",
      "pcpndt.form_f.read",
      "pcpndt.form_f.verify",
    ],
  },
  {
    /**
     * PLAN 18c T1 / D2 — **THE RADIOLOGICAL SAFETY OFFICER, the other statutory officer, and the
     * role the Rules require by name.**
     *
     * AERB approves an RSO for the institution; the appointment is a row in `aerb_persons` and this
     * is the login that goes with it. The RSO files the equipment licences, records the quality-
     * assurance results (and thereby blocks a machine that failed one), issues the TLD badges and
     * enters the readings that come back from the laboratory.
     *
     * **Holds no clinical string at all** — not `radiology.acquire`, not `radiology.reports.sign`.
     * The recommended appointee is a senior radiographer (O-13) who will ALSO hold `radiographer`,
     * and the separation that matters survives that: the QA record blocks the device through the
     * registry, so an RSO cannot both fail a machine and quietly scan on it, whichever hat they are
     * wearing.
     */
    roleKey: "radiation_safety_officer",
    permissions: [
      "aerb.registers.manage",
      "aerb.registers.read",
      "aerb.doses.read",
    ],
  },
  {
    /**
     * PLAN 18b T1 — **A MACHINE ACCOUNT, AND THE ONLY ROLE IN THIS MODEL WITH ONE STRING.**
     *
     * The bridge on the PACS host pulls `GET /radiology/mwl` every few seconds and writes what it
     * gets into the modality worklist directory. It needs exactly that read and nothing else, and
     * the role exists so that it never holds anything else: the shortcut — a bridge logging in as a
     * `radiographer` — would hand a cron job `radiology.gates.satisfy`, which is a clinical
     * declaration about a patient's pregnancy. The kernel has no service-account door (18b S1), so
     * the bridge is a user with this role and a password in the runbook's vault line.
     */
    roleKey: "modality_bridge",
    permissions: ["radiology.mwl.read"],
  },
  /**
   * PLAN 17-E T2 — THE LAB'S BRIDGE, AND IT IS `modality_bridge`'S SHAPE ON PURPOSE.
   *
   * A machine account holding exactly what a machine needs: the right to ASK WHAT TO RUN on a tube
   * it has in front of it. NOT `lab.instruments.manage` — an account that could register machines
   * and re-map their codes could rename any test it reports, and the bench PC is on a flat hospital
   * LAN speaking a clear-text protocol.
   *
   * A USER rather than an agent, and that is forced rather than chosen: `guards.ts` throws
   * `agents hold no permissions yet` for any non-user actor before `hasPermission` is reached, so
   * the `agents` table cannot carry a permission until Plan 12's `agent_permissions` ships. 18b met
   * this first and `modality_bridge` is its answer.
   */
  {
    roleKey: "lab_bridge",
    permissions: ["lab.instruments.read", "lab.results.interface"],
  },
  /**
   * PLAN 16c T1 — THE DISPENSING AIDE (doc 16 role 25c). May claim, verify-assist and pick; may
   * read the patient and the formulary (stock is read for it by the counter's own routes, under the
   * pharmacy permission). **Holds no `pharmacy.dispense.scheduled`**:
   * the Pharmacy Act 1948 §42 reserves the completion of a Schedule H/H1 dispense to a registered
   * pharmacist, and `handOver` refuses the transition rather than trusting a screen to hide it.
   * Holds no billing string either — the aide picks, the pharmacist bills.
   */
  {
    roleKey: "pharmacy_assistant",
    permissions: [
      "pharmacy.dispense.place",
      "pharmacy.dispense.read",
      "orders.read",
      "patients.read",
      "formulary.read",
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
  // PLAN 22c-A T1/DD7's two privacy-write strings LEFT this list on 2026-08-29, the day after they
  // joined it: the owner ruled that `mrd_officer` holds both, beside the `patients.merge` it already
  // had. That is the shortest stay any entry has had bar `staff.reports.drill`, and it is what this
  // list is FOR — a permission parked with a reason until somebody rules, never a permanent home.
  // `patients.confidential.read` stays: SEEING a confidential record is a different question, and it
  // has not been asked.
  // ─────────── PLAN 17 PHASE 0 T5 — the four `orders.*` strings, held by nobody ───────────
  //
  // THE ENVELOPE HAS NO CONSUMERS ON THE DAY IT LANDS, and that is what makes granting any of
  // these premature rather than cautious: no manifest claims an order KIND, so `placeOrder`
  // refuses everything with `unknown_kind` and there is no route to reach. A role granted
  // `orders.place` today would hold authority over nothing — and would be the reason nobody
  // checks the grant again when Plan 17's lab module gives it something to do.
  //
  // Each string gets its holder from the plan that gives it a surface: 17 grants `orders.place`
  // and `orders.read` beside its own `lab.orders.place`; 18a does the same for imaging.
  // ─────────── PLAN 17 T2 — THREE OF THE FOUR `orders.*` STRINGS LEFT THIS LIST ───────────
  //
  // `orders.place`, `orders.read` and `orders.cancel` are GRANTED as of this commit, exactly as
  // phase 0's own entries above predicted: *"Each string gets its holder from the plan that gives
  // it a surface: 17 grants `orders.place` and `orders.read` beside its own `lab.orders.place`."*
  // The pair is granted together because `placeOrder` requires BOTH, so either alone is authority
  // over nothing. `orders.cancel` goes with them under the same entry's own rule — *"a departmental
  // decision"* — and Plan 17 is the department making it: `doctor`, `pathologist` and
  // `lab_reception` may call off a lab order, and nobody else can.
  //
  // Holders as of this commit: `doctor`, `pathologist`, `lab_reception` (all three strings);
  // `lab_technician`, `phlebotomist`, `surgeon`, `ot_incharge` (read, and place for the two OT
  // roles' pre-op panel).
  //
  // **`orders.read.restricted` STAYS**, and it is the one that matters: it is the Class-A grant
  // phase 0 handed to the owner, and this phase deliberately does not take it. Nothing in Plan 17
  // needs it — the lab's own worklists read the lab's own tables, and the ordering clinician
  // already sees their own restricted item through `read.ts`'s clinician leg. Granting it to run a
  // bench would decide, without anyone noticing, that a role may read every restricted
  // investigation in the building.
  {
    permission: "orders.read.restricted",
    reason:
      "PLAN 17 PHASE 0 / DD11 — the same argument `patients.confidential.read` above is still " +
      "waiting on an owner for, one door over. This buys the HIV order, the exposure-protocol " +
      "source test and the PCPNDT-class USG that the ward's list omits; the ordering clinician " +
      "already sees their own without it. Handing it out with `orders.read` would decide, " +
      "without anyone noticing, that every clerk may read every restricted investigation in the " +
      "building — so it is a Class-A grant the runbook hands to the owner",
  },
  // `approvals.requests.create` LEFT this list on 2026-09-02: the owner ruled it onto
  // `lab_reception` (Plan 17c §7, decision 1) — the counter asks, the billing manager decides.
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
  // PLAN 14 / DD11, 2026-08-27. Neither is an OPD station, so neither is in `OPD_ROLE_KEYS`.
  // § 4A item 5: these KEYS are the brainstorm's S10 names and they are what the code matches on.
  // If the owner's org chart says "Purchase Manager" or "Store In-charge", the TITLE changes here
  // and the key does not — `ensureRole(db, key, title)` takes both, and a key rename would orphan
  // every `role_assignments` row and every `role_permissions` grant already written against it.
  materials_head: "Materials Head (item and vendor masters, QC verdicts, recall freeze)",
  storekeeper: "Storekeeper (receives, issues and moves stock; does not sign the QC verdict)",
  // PLAN 15 / DD14, 2026-08-28. None is an OPD station, so none is in `OPD_ROLE_KEYS`. The KEYS are
  // spec §11.16-A's names and are what the code matches on — `signIn` checks `anaesthetist`,
  // `overrideGate` checks `surgeon` AND `anaesthetist`. If the owner's org chart says "OT Manager"
  // or "Scrub Nurse", the TITLE changes here and the key does not: a key rename would orphan every
  // `role_assignments` row and every `role_permissions` grant already written against it.
  ot_incharge: "OT In-charge (runs the list; cannot override a gate, publish criteria or bill)",
  surgeon: "Surgeon (operates; one half of the two-actor clinical gate override)",
  anaesthetist: "Anaesthetist (signs the case in; the other half of the override)",
  ot_nurse: "OT Nurse (cockpit, counts and implant scanning; does not discharge)",
  recovery_nurse: "Recovery Nurse (PACU scoring and the escort-gated discharge)",
  // OWNER RULING 2026-08-29 (Plan 07c T9 / DD14). Not an OPD station — a governance seat, held by
  // ONE person on purpose. The key is what the code matches on; if the org chart calls the person
  // something else, the TITLE changes here and the key does not.
  staff_auditor: "Staff Auditor (reads a named colleague's figures, and may open the patient rows behind them)",
  daycare_coordinator: "Day-care Coordinator (books cases, chases gates, publishes the list)",
  // PLAN 17 T2 / DD16, 2026-08-29. None of the four is an OPD station — a bench is not a consulting
  // room — so none is in `OPD_ROLE_KEYS`. The KEYS are 02 S10's names (cards 16, 17 and 36) and are
  // what the code matches on: the `lab_item` definition's `verify` transition declares
  // `pathologist`, and DD11's SoD refusal reads `entered_by` rather than a role. If the owner's org
  // chart says "Chief Pathologist" or "Lab Front Desk", the TITLE changes here and the key does not
  // — a key rename would orphan every `role_assignments` row and every `role_permissions` grant
  // already written against it.
  pathologist: "Pathologist (verifies and signs reports; the only role that may release a result)",
  lab_technician: "Lab Technician (accessions, runs the bench and keys results; never verifies)",
  phlebotomist: "Phlebotomist (calls the queue, scans the patient, draws and labels the tube)",
  lab_reception: "Lab Reception (orders, bills, prints the signed report and hands it over; reads no result before signature)",
  // PLAN 18a T2 — the four radiology roles. Each title names the SEPARATION the role is defined by,
  // because a staffing card is where a hospital administrator decides who to assign, and "can this
  // person sign a report?" is the question the card has to answer without reading the code.
  radiologist: "Radiologist (reports, signs, amends; overrides a gate with a reason; writes Form F)",
  radiographer: "Radiographer (checks in, satisfies the safety gates, acquires; signs no report)",
  radiation_safety_officer:
    "Radiological Safety Officer (AERB licences, QA records and the machine block, TLD badges; no clinical act)",
  radiology_receptionist: "Imaging Reception (orders, schedules, bills; satisfies no safety gate)",
  pcpndt_incharge: "PCPNDT In-charge (registration, machines, persons; VERIFIES Form F, writes none)",
  // PLAN 18b T1 — a machine account. The title says so, because a staffing card is where an
  // administrator would otherwise assign it to a person.
  modality_bridge: "Modality bridge (a MACHINE account: pulls the worklist export; holds nothing else)",
  // PLAN 17-E T2 — the analyser bridge, the same shape one department over.
  lab_bridge: "Laboratory instrument bridge (a MACHINE account: asks what to run on a tube and posts what it measured; holds nothing else)",
  // PLAN 16c T1 — the aide's title names the one thing the role cannot do.
  pharmacy_assistant: "Pharmacy Assistant (claims, picks and labels; completes NO Schedule H/H1 dispense)",
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
