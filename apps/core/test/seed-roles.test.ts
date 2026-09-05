import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setupTestDb, truncateAll } from "./helpers/db";
import type { Db } from "../src/kernel/db/client";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { OPD_ROLE_KEYS } from "../src/modules/opd/config";
import {
  GRANTED_BY_OTHER_SEEDS,
  LOCAL_ROLE_TITLES,
  NOT_YET_MODELLED,
  ROLE_MODEL,
  heldInDatabase,
  heldPermissions,
  modelPermissions,
  formatReport,
  roleTitle,
  seedRoles,
} from "../scripts/seed-roles";
import { assignRole, createRole, grantPermissionToRole } from "../src/kernel/auth/permissions";
import { createUser } from "../src/kernel/auth/identity";
import { authManifest } from "../src/kernel/auth/manifest";
import { rolePermissions } from "../src/kernel/db/schema";

/**
 * Plan 11d / D1 + D3, Book rows V1, V2, V3 and V5 — the role model is CODE, the README is pinned
 * to it, and every declared permission is reachable by somebody.
 *
 * WHAT EACH LEG BUYS, because a parity test that has never been watched to fail is §2.22's "not a
 * pre-flight":
 *   V1  every string the model grants is DECLARED by an installed manifest — catches a typo
 *       (`billing.invoice.isue`) and an orphan grant.
 *   V2  every DECLARED permission is held by at least one role or named in `NOT_YET_MODELLED`
 *       WITH ITS REASON — the reachability invariant, which is the assertion that fails the build
 *       the day a module adds a permission and forgets the role model. That failure mode produced
 *       MAJOR 4 twice.
 *   V3  the README's two markdown tables and the model agree cell for cell, BOTH DIRECTIONS, over
 *       the TABLE-DERIVED subset — plus a leg of its own for the eight `patients.*` pairs owner
 *       ruling 7 added, which appear in NEITHER table. A model row that is neither table-derived
 *       nor one of those eight FAILS: that is what stops the subset scoping becoming a hole.
 *   V5  the seed is idempotent, proven by running it twice against one database.
 *
 * §2.49 / GC15 — THIS TEST CAN PASS VACUOUSLY AND MUST NOT. Two parsers that both return `[]`
 * agree with each other forever. Three things prevent it here, copied from
 * `caddyfile-parity.test.ts`'s discipline: both README parsers THROW rather than return empty on
 * a shape they do not recognise (a missing header, a mismatched column count, a cell that is
 * neither a tick nor blank, a permission cell that is not a backticked dotted name); the CENSUS
 * BLOCK below pins every count — manifests, roles, pairs, table shapes — BEFORE anything is
 * compared; and one test drives the parsers against deliberately garbled input to watch them
 * throw.
 *
 * THE BILLING TABLE'S LAST ROW IS `approvals.requests.read` / `.decide` IN ONE CELL — two
 * permissions from a DIFFERENT manifest written as a shorthand. The parser EXPANDS it. It must
 * never silently skip it: skipping is how a parity test passes vacuously, and the pair count in
 * the census is what proves the expansion happened.
 */
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const README = resolve(REPO_ROOT, "README.md");

/** The README prose line that authorises owner ruling 7's `patients.*` grants. Quoted, not paraphrased. */
const RULING_7_README_PROSE =
  "Plan 05's `patients.register` / `patients.read` (and `patients.update` for quick allergies) stay";

/** The eight (role, permission) pairs owner ruling 7 added, which appear in NEITHER README table. */
const RULING_7_PAIRS: readonly string[] = [
  "front_office/patients.read",
  "front_office/patients.register",
  "front_office/patients.update",
  "front_office_supervisor/patients.read",
  "front_office_supervisor/patients.register",
  "front_office_supervisor/patients.update",
  "vitals_desk/patients.read",
  "vitals_desk/patients.update",
];

/** The README prose line that authorises the 2026-08-23 workflow ruling. Quoted, not paraphrased. */
const WORKFLOW_RULING_README_PROSE =
  "Owner ruling of 2026-08-23 assigns the four `workflow.definitions.*` strings, which appear in no";

/**
 * The seven (role, permission) pairs the 2026-08-23 workflow ruling added, which appear in NEITHER
 * README table. The SECOND set of non-table rows, and the reason V3's last leg compares against a
 * union rather than a single constant: `workflow.*` is declared by the workflow manifest and has no
 * permission column anywhere, exactly as ruling 7's `patients.*` pairs do not.
 */
const WORKFLOW_RULING_PAIRS: readonly string[] = [
  "medical_superintendent/workflow.definitions.approve",
  "medical_superintendent/workflow.definitions.read",
  "opd_admin/workflow.definitions.draft",
  "opd_admin/workflow.definitions.read",
  "owner/workflow.definitions.activate",
  "owner/workflow.definitions.approve",
  "owner/workflow.definitions.read",
];

/** The README prose line that authorises Plan 09's DD18 grants. Quoted, not paraphrased. */
const PLAN_09_README_PROSE =
  "Plan 09's four `membership.*` strings appear in neither table above";

/**
 * The ten (role, permission) pairs Plan 09's DD18 added, which appear in NEITHER README table.
 *
 * THE THIRD set of non-table rows, landed the same way the two above did — a named constant here
 * plus a README prose line this test quotes verbatim — because `membership.*` is declared by a new
 * manifest and has no permission column anywhere, exactly as `patients.*` and `workflow.*` do not.
 * The alternative was restructuring the two shipped tables to carry a third module, which would
 * have made a role-model ruling look like a documentation refactor in the diff.
 *
 * The SHAPE of the ruling is visible in the list: three roles get the counter's three, ONE role
 * gets the approval, and nothing else is granted at all. Every partner-facing string is in
 * `NOT_YET_MODELLED` with its reason instead.
 */
const PLAN_09_PAIRS: readonly string[] = [
  "billing_manager/membership.grace_honor.approve",
  "cashier/membership.grace_honor.request",
  "cashier/membership.instrument.read",
  "cashier/membership.instrument.recognise",
  "front_office/membership.grace_honor.request",
  "front_office/membership.instrument.read",
  "front_office/membership.instrument.recognise",
  "front_office_supervisor/membership.grace_honor.request",
  "front_office_supervisor/membership.instrument.read",
  "front_office_supervisor/membership.instrument.recognise",
];

/** The README prose line that authorises RC-2 T4's enrol/apply split. Quoted, not paraphrased. */
const RC2_ENROL_README_PROSE =
  "RC-2 adds a fifth `membership.*` string, `membership.instrument.enrol`";

/**
 * The two (role, permission) pairs RC-2 T4 added, which appear in NEITHER README table.
 *
 * THE FIFTH set of non-table rows, landed exactly as the four above were — a named constant here
 * plus a README prose line this test quotes verbatim.
 *
 * ═══ WHY THIS IS NOT APPENDED TO `PLAN_09_PAIRS` ═══
 *
 * It would have typechecked, passed, and been shorter. It would also have recorded an RC-2 decision
 * as Plan 09's DD18 — and that constant's own comment says "the SHAPE of the ruling is visible in
 * the list". A census kept green by making the record false is worse than a census that fails: the
 * failure is loud and the false record is permanent. Same reason RC-2 does not edit
 * `PLAN_09_README_PROSE`'s "four `membership.*` strings" to read "five": that count is scoped to
 * Plan 09, not to the module, so it is still true and changing it would break a verbatim-quoted
 * constant in order to write down something untrue.
 *
 * THE SHAPE IS THE RULING: the seat that APPLIES a benefit cannot MINT one. `front_office` holds
 * `membership.instrument.recognise` and is absent from this list on purpose.
 */
const RC2_ENROL_PAIRS: readonly string[] = [
  "front_office_supervisor/membership.instrument.enrol",
  "membership_admin/membership.instrument.enrol",
];

/** The README prose line that authorises the 2026-08-26 Group C grants. Quoted, not paraphrased. */
const GROUP_C_README_PROSE =
  "Owner ruling of 2026-08-26 moves three `auth.*` strings off `admin`, which appear in no table";

/**
 * The three (role, permission) pairs the 2026-08-26 Group C ruling added, which appear in NEITHER
 * README table. The FOURTH set of non-table rows, landed exactly as the three above were.
 *
 * `auth.*` is declared by `authManifest` and has no permission column anywhere — and until this
 * ruling it had no MODEL row anywhere either, because `seed:admin` grants the whole manifest to
 * `admin` and that made every `auth.*` string look "held" to the reachability census while being
 * reachable by exactly one account. Held is not the same as held BY THE RIGHT ROLE, and the census
 * was never designed to notice the difference; this constant is where that difference is written
 * down.
 *
 * THE SHAPE IS THE RULING: two review desks to the Medical Superintendent, one lending mechanism
 * to the Duty Manager, and NOTHING that creates an account or changes what a role means. The
 * fourth Group C candidate, `auth.break_glass.use`, is absent on purpose — `seed-roles.ts` carries
 * the measurement that explains why, and it is a wiring gap rather than a grant gap.
 */
const GROUP_C_PAIRS: readonly string[] = [
  "duty_manager/auth.temp_role.grant",
  "medical_superintendent/auth.break_glass.review",
  "medical_superintendent/auth.elevation.review",
];

/** The README prose line that authorises the 2026-08-26 Group A grants. Quoted, not paraphrased. */
const GROUP_A_README_PROSE =
  "Owner ruling of 2026-08-26 assigns ten pairs that appear in no table above";

/**
 * The ten (role, permission) pairs the 2026-08-26 Group A ruling added. The FIFTH non-table set.
 *
 * These are different in kind from the four sets above, and the difference is the point: every one
 * of these strings was in `NOT_YET_MODELLED` — declared, guarding a LIVE route, and held by nobody,
 * so the route answered 403 to every account on the deployment. Eight entries left that list in the
 * same commit, which is the mechanism its header promises ("the day any of them gains a holder this
 * list shrinks by one, the census fails, and the commit that grants it has to say so").
 *
 * TWO OMISSIONS ARE LOAD-BEARING and both are measurements rather than caution:
 *   - `membership.catalog.manage` guards NO route in the tree, so a holder could reach nothing;
 *   - `patients.merge` stays because `patient_merge` is registered by no seed, so `requestApproval`
 *     throws `unknown_type` and the merge lane is dead at step one for everybody.
 */
const GROUP_A_PAIRS: readonly string[] = [
  "biomedical_engineer/ops.interface.manage",
  "membership_admin/membership.import.run",
  "membership_admin/membership.reconcile.operate",
  "owner/approvals.types.manage",
  "owner/tariff.config.manage",
  "owner/tariff.read",
  "owner/tariff.versions.activate",
  "tariff_editor/tariff.read",
  "tariff_editor/tariff.services.manage",
  "tariff_editor/tariff.versions.draft",
];

/** The README prose line that authorises the merge-lane grants. Quoted, not paraphrased. */
const MERGE_LANE_README_PROSE =
  "Owner ruling of 2026-08-26 opens the patient-merge lane, which had never worked";

/**
 * The six (role, permission) pairs that opened the patient-merge lane. The SIXTH non-table set.
 *
 * It is the smallest of the six and the only one whose blocker was MACHINERY rather than a ruling:
 * `patient_merge` was named by `merge.ts` from Plan 05 and registered by no seed, so every merge
 * request threw `unknown_type` regardless of who held what. `seed:patients` and these grants land
 * together, which is why `patients.merge` left `NOT_YET_MODELLED` in the same commit that made it
 * mean something.
 *
 * `medical_superintendent/patients.read` is here rather than in a Group B commit because an
 * approver who cannot open the two records is not an approver.
 */
const MERGE_LANE_PAIRS: readonly string[] = [
  "medical_superintendent/approvals.requests.decide",
  "medical_superintendent/approvals.requests.read",
  "medical_superintendent/patients.read",
  "mrd_officer/patients.merge",
  "mrd_officer/patients.read",
  "mrd_officer/patients.update",
];

/** The README prose line that authorises the 2026-08-26 Group B grants. Quoted, not paraphrased. */
const GROUP_B_README_PROSE =
  "Owner ruling of 2026-08-26 widens three roles that could not do their own jobs";

/**
 * The six (role, permission) pairs Group B added. The SEVENTH non-table set, and the only one that
 * closed a CLINICAL SAFETY gap rather than an administrative one.
 *
 * `doctor/patients.read` is the row that matters: `opd-consult.tsx` fetches `GET /patients/:id` and
 * `GET /patients/:id/allergies` — both `patients.read` — and the `doctor` role held seven `opd.*`
 * strings and no `patients.*` at all, so a doctor in consultation was refused the allergy register.
 * Measured against production 2026-08-26: all three active doctors, `has patients.read: false`.
 *
 * The shape of owner ruling 7 is where the omission is visible: every role that touches the patient
 * BEFORE the doctor got `patients.read`, and the doctor did not.
 *
 * `owner/patients.read` is NOT here, and the absence is a ruling too — see the README sentence.
 */
const GROUP_B_PAIRS: readonly string[] = [
  "doctor/patients.read",
  "doctor/patients.update",
  "owner/billing.invoice.read",
  "owner/billing.reports.read",
  "owner/billing.session.read",
  "pharmacy/patients.read",
];

/** The README prose line that authorises Plan 16a's DD10 grants. Quoted, not paraphrased. */
const FORMULARY_README_PROSE =
  "the formulary is curated at the pharmacy and read by every prescriber";

/**
 * The four (role, permission) pairs Plan 16a / DD10 added. The EIGHTH non-table set, and the first
 * whose permissions are declared by a module with no README table of its own — `formulary.*` has
 * three strings and two holders, which is a table with more explanation than cells.
 */
const FORMULARY_PAIRS: readonly string[] = [
  "doctor/formulary.read",
  "pharmacy/formulary.manage",
  "pharmacy/formulary.read",
  "pharmacy/formulary.staging.review",
];

/** The README prose line that authorises Plan 13's DD14 grant. Quoted, not paraphrased. */
const RESOURCES_README_PROSE =
  "the registry is read by the role that already reads the room book";

/**
 * The ONE (role, permission) pair Plan 13 / DD14 added. The NINTH non-table set, and the smallest
 * any of them will ever be.
 *
 * `resources.*` has exactly one string and one holder, which is a table with more explanation than
 * cells — the `formulary.*` reasoning one phase later, and the same conclusion. It is a non-table
 * set for the structural reason all nine are: the permission is declared by a manifest that has no
 * column in either README table, and restructuring the two shipped tables to carry a third module
 * would make a role-model ruling look like a documentation refactor in the diff.
 *
 * **NO NEW AUTHORITY IS CREATED BY IT**, and that is what makes it a DD14 decision rather than an
 * owner ruling: `opd_admin` already holds `opd.masters.read` and `opd.masters.manage` over the room
 * book, and after T6 those rooms ARE the registry rows this permission reads.
 */
const RESOURCES_PAIRS: readonly string[] = [
  "opd_admin/resources.read",
];

/** The README prose line that authorises Plan 15's two out-of-table OT grants. Quoted, not paraphrased. */
/**
 * PLAN 07c T9 — the README prose line that authorises owner ruling O-2's grants. Quoted, not
 * paraphrased, and asserted for the same reason as the nine below: the README is what an operator
 * reads to learn who may do what, and a grant that lives only in code is a grant nobody can review.
 */
/** PLAN 07d T5 — the README prose line that authorises the doctor's tariff grant. Quoted, not paraphrased. */
/** PLAN 07c T9 — the README prose line authorising the 2026-08-29 drill ruling. Quoted, not paraphrased. */
const STAFF_AUDITOR_README_PROSE =
  "`staff_auditor`, carries `staff.reports.read` AND `staff.reports.drill`, and it is assigned to **one";

/** PLAN 07b O-1 — the README prose line authorising the counter cover. Quoted, not paraphrased. */
const COUNTER_COVER_README_PROSE =
  "who covers a locked-out counter (owner ruling, 2026-08-29): the billing manager.";

const DOCTOR_TARIFF_README_PROSE =
  "gains `tariff.read`, because a doctor advising an ultrasound should be able to tell the patient what";

const STAFF_REPORT_README_PROSE =
  "`staff.reports.drill`, which reveals the patient rows behind those figures, is granted";

const OT_README_PROSE =
  "`ot.bill.compose`, because composing a discharge bill reads the ledger, applies the regulated clamp,";

/**
 * PLAN 15 / DD14 — THE THREE (role, permission) PAIRS THAT SIT OUTSIDE THE OT TABLE. The TENTH
 * non-table set, and the first one whose existence is a CORRECTION rather than a decision.
 *
 * The other twelve OT strings are a table (see `otTable` below): fourteen strings across six roles
 * is a shape, and a grid shows a shape. These three are held by roles that pre-date the module and
 * have no column in it — the same structural reason every non-table set exists.
 *
 * **`billing_manager/ot.bill.compose` is where the plan was wrong.** DD14 says
 * *"`billing_counter` (existing) gains `ot.bill.compose`"*, and there is no `billing_counter` role:
 * not in `ROLE_MODEL`, not in `OPD_ROLE_KEYS`, not in `LOCAL_ROLE_TITLES`, and — Spike Q3 —
 * not on production, where the counter is `cashier` and its supervisor is `billing_manager`.
 * Granting a declared string to a role that does not exist produces a permission nobody can ever
 * hold, which is exactly the state `NOT_YET_MODELLED` exists to make visible.
 */
const OT_PAIRS: readonly string[] = [
  "medical_superintendent/ot.definitions.read",
  "medical_superintendent/ot.definitions.manage",
  "billing_manager/ot.bill.compose",
];

/**
 * PLAN 07c T9 / DD14 — THE TWO PAIRS THAT SIT OUTSIDE EVERY TABLE. The ELEVENTH non-table set, and
 * the smallest possible one: `desk` declares two strings, one of them is granted, and it goes to
 * two roles that pre-date it and have no column anywhere.
 *
 * There is deliberately no fifth README table. A table shows a SHAPE — fourteen strings across six
 * roles is a grid worth drawing — and one granted string across two roles is a sentence. Owner
 * ruling O-2 (2026-08-28) is that sentence: *a supervisor may see a named staff member's daily
 * report*, constrained by DD14 to what they did rather than whom they did it to.
 */
/**
 * PLAN 07d T5 / DD6 — THE ONE PAIR THAT SITS OUTSIDE EVERY TABLE. The TWELFTH non-table set, and
 * the smallest there can be: a single grant of an existing string to an existing role.
 *
 * `doctor` gains `tariff.read` so the cockpit can browse the priced service catalogue and advise
 * tests WITH their prices — the question a patient actually asks at the chair. It is a TARIFF
 * string held by an OPD role, so it belongs to neither table by construction.
 *
 * **DD6 names TWO grants and this is one of them.** `materials.stock.read` is not here, because the
 * drug-availability panel it serves is gated on owner item O-1 (zero medicines seeded, `pharmacy`
 * held by nobody). A permission granted ahead of the feature reaches nothing.
 */
const DOCTOR_TARIFF_PAIRS: readonly string[] = ["doctor/tariff.read"];

/**
 * PLAN 07c T9 / DD14 — OWNER RULING 2026-08-29. The THIRTEENTH non-table set: a role of its own,
 * carrying both staff-report strings, so the person who may open patient rows from a colleague's
 * shift is exactly ONE named human rather than everybody who happens to hold a supervisory role.
 */
const STAFF_AUDITOR_PAIRS: readonly string[] = [
  "staff_auditor/staff.reports.read",
  "staff_auditor/staff.reports.drill",
];

/**
 * PLAN 07b O-1 — OWNER RULING 2026-08-29. The FOURTEENTH non-table set, and the largest single
 * addition to this list: seven strings that let a `billing_manager` WORK A COUNTER.
 *
 * A variance lockout closes the whole front door under ruling R-4's one-staffer counter, and the
 * owner named this role as the cover. These are exactly what `counter-desk.tsx` calls to complete
 * one walk-in — not `front_office` + `cashier` wholesale, and deliberately without
 * `billing.credit.extend`: this role approves billing exceptions and a stopgap cover has no
 * business creating one it could then approve.
 */
const COUNTER_COVER_PAIRS: readonly string[] = [
  "billing_manager/opd.masters.read",
  "billing_manager/opd.queue.read",
  "billing_manager/patients.read",
  "billing_manager/patients.register",
  "billing_manager/opd.visits.open",
  "billing_manager/billing.invoice.issue",
  "billing_manager/billing.session.own",
];

/**
 * OWNER RULING 2026-08-29, taken on the deployed system the day after Plan 22c-A shipped — the
 * FIFTEENTH non-table set, and the smallest: two strings, one role, one holder.
 *
 * 22c-A split `patients.confidential.write` and `patients.deceased.write` out of `patients.update`
 * and granted them to nobody, deliberately (DD7): a phase that removes a power must not hand it
 * straight back, or the split is cosmetic. That left both fields unsettable by anyone in the
 * hospital — safe in one direction and worse in the other — so the grant was always a runbook step
 * waiting on a person.
 *
 * The owner ruled `mrd_officer`, and the argument is adjacency: merging two records for one person
 * (`patients.merge`, which this role already held alone) and deciding that a person is invisible or
 * deceased are the same kind of authority over the same object. `patients.confidential.read` was
 * deliberately NOT included — SEEING a confidential record is a different question, and it is still
 * the one entry `NOT_YET_MODELLED` is holding on this subject.
 */
const PRIVACY_WRITE_PAIRS: readonly string[] = [
  "mrd_officer/patients.confidential.write",
  "mrd_officer/patients.deceased.write",
];

/**
 * PLAN 17 T2 / DD16 — THE THIRTY-FOUR GRANTS THAT ARE NOT IN THE LAB TABLE, and they fall into
 * three groups that are three different decisions.
 *
 * **The kernel's three `orders.*` strings, granted for the first time in this repository.** Phase 0
 * declared them and granted them to nobody, and its own `NOT_YET_MODELLED` entry predicted this
 * commit in as many words: *"Each string gets its holder from the plan that gives it a surface: 17
 * grants `orders.place` and `orders.read` beside its own `lab.orders.place`."* The pair is granted
 * TOGETHER because `placeOrder` requires both, so either alone is authority over nothing.
 * `orders.read.restricted` is deliberately absent and stays the owner's Class-A decision.
 *
 * **The lab strings held by roles that already exist**: `doctor` orders and reads, `surgeon` and
 * `ot_incharge` order the pre-op panel, `billing_manager` releases a held report. None of the four
 * has a column in the lab table and none should — a table column is a lab STATION.
 *
 * **`lab_reception`'s front-office and cashier strings, and `billing.credit.extend` on three
 * roles.** The second of those is a MEASUREMENT (spike S1): `issueInvoice` refuses an invoice that
 * would leave a remainder unless the caller holds `billing.credit.extend`, and DD6 has the lab
 * issue exactly such invoices for the reflex, add-on and walk-in lines. Without it those three
 * paths throw `credit_permission_required` at the bench, at the chair and inside the verifying
 * transaction. Recorded as this phase's finding F2 because DD16 did not predict it.
 */
/**
 * PLAN 18a T2 — the thirteen grants outside the radiology table, each quoted in the README prose
 * beneath it. Two shapes: the strings the four new roles hold from OTHER modules (the kernel's
 * `orders.*` and the receptionist's counter set), and this phase's own strings held by roles that
 * are not columns in its table (`doctor`, `billing_manager`).
 */
const RADIOLOGY_PAIRS: readonly string[] = [
  "radiologist/orders.read",
  "radiographer/orders.read",
  "radiology_receptionist/orders.place",
  "radiology_receptionist/orders.read",
  "radiology_receptionist/patients.register",
  "radiology_receptionist/patients.read",
  "radiology_receptionist/billing.invoice.issue",
  "radiology_receptionist/billing.invoice.read",
  "radiology_receptionist/billing.receipt.record",
  "radiology_receptionist/billing.session.own",
  "doctor/radiology.orders.place",
  "doctor/radiology.reports.read",
  "billing_manager/radiology.bill_decisions.manage",
];

const LAB_PAIRS: readonly string[] = [
  "pathologist/orders.place",
  "pathologist/orders.read",
  "pathologist/orders.cancel",
  "pathologist/billing.credit.extend",
  "lab_technician/orders.read",
  "lab_technician/billing.credit.extend",
  "phlebotomist/orders.read",
  "lab_reception/orders.place",
  "lab_reception/orders.read",
  "lab_reception/orders.cancel",
  "lab_reception/patients.register",
  "lab_reception/patients.read",
  "lab_reception/patients.update",
  "lab_reception/billing.invoice.issue",
  "lab_reception/billing.invoice.read",
  "lab_reception/billing.receipt.record",
  "lab_reception/billing.session.own",
  "lab_reception/billing.credit.extend",
  "doctor/lab.orders.place",
  "doctor/lab.results.read",
  "doctor/lab.catalogue.read",
  "doctor/orders.place",
  "doctor/orders.read",
  "doctor/orders.cancel",
  "ot_incharge/lab.orders.place",
  "ot_incharge/lab.catalogue.read",
  "ot_incharge/orders.place",
  "ot_incharge/orders.read",
  "surgeon/lab.orders.place",
  "surgeon/lab.results.read",
  "surgeon/lab.catalogue.read",
  "surgeon/orders.place",
  "surgeon/orders.read",
  "billing_manager/lab.reports.release_unpaid",
];

/**
 * PLAN 16c T1 — the TEN grants outside the pharmacy table: the kernel's `orders.*` (the claim
 * places the `medication` order), the four cashier strings (the `lab_reception` precedent), and the
 * aide's reads. NOT `billing.credit.extend` — the README says why.
 */
const PHARMACY_README_PROSE =
  "It does NOT gain\n`billing.credit.extend`: an OPD dispense is paid before the drug leaves, and the credit holds for\nIPD and TPA are 16d's.";
const PHARMACY_PAIRS: readonly string[] = [
  "pharmacy/orders.place",
  "pharmacy/orders.read",
  "pharmacy/orders.cancel",
  "pharmacy/billing.invoice.issue",
  "pharmacy/billing.invoice.read",
  "pharmacy/billing.receipt.record",
  "pharmacy/billing.session.own",
  "pharmacy_assistant/orders.read",
  "pharmacy_assistant/patients.read",
  "pharmacy_assistant/formulary.read",
];

const STAFF_REPORT_PAIRS: readonly string[] = [
  "front_office_supervisor/staff.reports.read",
  "medical_superintendent/staff.reports.read",
];

/** All NINETEEN non-table sets. A model row outside this union fails V3's last leg. */
/** The README prose line that authorises the 2026-09-02 owner ruling (Plan 17c §7). Quoted, not paraphrased. */
const LAB_RELEASE_REQUEST_README_PROSE =
  "the counter may raise the release request for a held report";

/**
 * The ONE pair the owner added on 2026-09-02 (Plan 17c §7, decision 1): `lab_reception` may
 * CREATE a `lab_release_unpaid` approval request. DD6 keeps the decision with `billing_manager`
 * (approve/reject); until this grant no human role could raise the request at all, and the report
 * centre's button was a 403 for everyone (17c close review pass 1, F2a). A kernel string held by a
 * lab role belongs to neither README table by construction.
 */
const LAB_RELEASE_REQUEST_PAIRS: readonly string[] = [
  "lab_reception/approvals.requests.create",
];

const NON_TABLE_PAIRS: readonly string[] = [
  ...RULING_7_PAIRS, ...WORKFLOW_RULING_PAIRS, ...PLAN_09_PAIRS, ...GROUP_C_PAIRS, ...GROUP_A_PAIRS,
  ...MERGE_LANE_PAIRS, ...GROUP_B_PAIRS, ...FORMULARY_PAIRS, ...RESOURCES_PAIRS, ...OT_PAIRS,
  ...STAFF_REPORT_PAIRS, ...DOCTOR_TARIFF_PAIRS, ...STAFF_AUDITOR_PAIRS, ...COUNTER_COVER_PAIRS,
  ...PRIVACY_WRITE_PAIRS, ...LAB_PAIRS, ...RADIOLOGY_PAIRS, ...RC2_ENROL_PAIRS, ...PHARMACY_PAIRS, ...LAB_RELEASE_REQUEST_PAIRS,
];

type GrantTable = {
  roles: string[];
  /** permission -> the roles ticked for it */
  cells: Map<string, string[]>;
  /** how many markdown ROWS the table had, before the shorthand cell was expanded */
  rowCount: number;
};

const PERMISSION_RE = /^`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`$/;
const SHORTHAND_RE = /^`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`\s*\/\s*`(\.[a-z][a-z0-9_]*)`$/;
const SEPARATOR_RE = /^\|(?:\s*:?-{2,}:?\s*\|)+$/;

/** `| a | b |` -> `["a", "b"]`. Throws on a line that is not a table row. */
function splitRow(line: string, label: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    throw new Error(`${label}: "${trimmed}" is not a markdown table row — this parser is stale`);
  }
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

/**
 * The permission(s) a first cell names. Expands the `\`a.b.c\` / \`.d\`` shorthand into two
 * permissions and THROWS on anything else — never returns `[]`, which is the shape that would let
 * a row be silently dropped.
 */
function expandPermissionCell(cell: string, label: string): string[] {
  const single = PERMISSION_RE.exec(cell);
  if (single?.[1] !== undefined) return [single[1]];
  const shorthand = SHORTHAND_RE.exec(cell);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    const full = shorthand[1];
    const base = full.slice(0, full.lastIndexOf("."));
    return [full, `${base}${shorthand[2]}`];
  }
  throw new Error(
    `${label}: permission cell ${JSON.stringify(cell)} is neither a backticked dotted permission ` +
      `nor the \`a.b.c\` / \`.d\` shorthand — this parser is stale, and skipping the row is how a ` +
      `parity test passes vacuously`,
  );
}

/**
 * Every `| Permission | <role> | … |` table in a markdown document. Throws on any shape it does
 * not recognise and on a document that carries none.
 */
function permissionTables(source: string, label: string): GrantTable[] {
  const lines = source.split("\n");
  const tables: GrantTable[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!/^\|\s*Permission\s*\|/.test(line.trim())) continue;
    const header = splitRow(line, label);
    const roleColumns = header.slice(1);
    if (roleColumns.length === 0) {
      throw new Error(`${label}: a Permission table declares no role columns — this parser is stale`);
    }
    const separator = lines[i + 1] ?? "";
    if (!SEPARATOR_RE.test(separator.trim())) {
      throw new Error(
        `${label}: the row after a Permission header is ${JSON.stringify(separator)} rather than a ` +
          `markdown separator — this parser is stale`,
      );
    }
    if (splitRow(separator, label).length !== header.length) {
      throw new Error(`${label}: separator column count disagrees with the header — this parser is stale`);
    }
    const cells = new Map<string, string[]>();
    let rowCount = 0;
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const row = (lines[j] ?? "").trim();
      if (!row.startsWith("|")) break;
      const columns = splitRow(row, label);
      if (columns.length !== header.length) {
        throw new Error(
          `${label}: row ${JSON.stringify(row)} has ${columns.length} columns against the header's ` +
            `${header.length} — this parser is stale`,
        );
      }
      rowCount += 1;
      const permissions = expandPermissionCell(columns[0] ?? "", label);
      const ticked: string[] = [];
      for (let c = 1; c < columns.length; c += 1) {
        const value = columns[c] ?? "";
        if (value === "") continue;
        if (value !== "✓") {
          throw new Error(
            `${label}: cell ${JSON.stringify(value)} in row ${JSON.stringify(columns[0] ?? "")} is ` +
              `neither a tick nor blank — this parser is stale`,
          );
        }
        const role = roleColumns[c - 1];
        if (role === undefined) throw new Error(`${label}: no role column at index ${c}`);
        ticked.push(role);
      }
      for (const permission of permissions) {
        cells.set(permission, [...(cells.get(permission) ?? []), ...ticked]);
      }
    }
    if (rowCount === 0) {
      throw new Error(`${label}: a Permission table has no rows — this parser is stale`);
    }
    tables.push({ roles: roleColumns, cells, rowCount });
    i = j - 1;
  }
  if (tables.length === 0) {
    throw new Error(`${label}: no \`| Permission | … |\` table found at all — this parser is stale`);
  }
  return tables;
}

/** `role/permission` for every ticked cell of a table, sorted. */
function tablePairs(table: GrantTable): string[] {
  const pairs: string[] = [];
  for (const [permission, roleList] of table.cells) {
    for (const role of roleList) pairs.push(`${role}/${permission}`);
  }
  return pairs.sort();
}

/** `role/permission` for every grant in the seed's model, sorted. */
function modelPairs(): string[] {
  return ROLE_MODEL.flatMap((r) => r.permissions.map((p) => `${r.roleKey}/${p}`)).sort();
}

function installedRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);
  return registry;
}

const readme = readFileSync(README, "utf8");
const tables = permissionTables(readme, "README.md");
const opdTable = tables.find((t) => t.roles[0] === "front_office");
const billingTable = tables.find((t) => t.roles[0] === "cashier");
/**
 * PLAN 14 T2 / DD11 — THE THIRD TABLE, and the first new one since Plan 11d wrote this parser.
 *
 * `formulary.*` (three strings, two holders) and `resources.*` (one string, one holder) both
 * declined a table and became NON-TABLE PAIRS instead, each with a quoted README prose line — the
 * reasoning being that a table with more explanation than cells is worse than a sentence. Materials
 * is the other side of that line: **eleven strings across three roles is twenty ticks**, and the
 * SHAPE of the grants is the decision (who may sign a QC verdict, who may not register a vendor).
 * A grid shows that at a glance and a paragraph does not, which is why DD11 rules the table IN and
 * why `NON_TABLE_PAIRS` does not grow by twenty.
 */
const materialsTable = tables.find((t) => t.roles[0] === "materials_head");
/**
 * PLAN 15 T2 / DD14 — THE FOURTH TABLE, and it clears the materials bar by a wide margin: twelve
 * strings across SIX roles is thirty ticks, and the SHAPE is the whole decision — who may override a
 * gate, who may discharge, what the in-charge is deliberately denied. A paragraph cannot show a
 * shape. The three grants that fall outside it are `OT_PAIRS`.
 */
const otTable = tables.find((t) => t.roles[0] === "ot_incharge");
/**
 * PLAN 17 T2 / DD16 — THE FIFTH TABLE, and it clears the materials bar the way the OT's did:
 * **fifteen strings across FOUR roles is twenty-six ticks**, and the SHAPE is the whole decision —
 * who may verify, who may only enter, who touches no result at all, and which counter role is
 * deliberately denied every `lab.results.*` string. A paragraph cannot show a shape. The
 * thirty-four grants that fall outside it are `LAB_PAIRS`.
 */
const labTable = tables.find((t) => t.roles[0] === "pathologist");
/**
 * PLAN 18a T2 — **THE SIXTH TABLE**, and it clears the bar the lab's did: twenty strings across FOUR
 * roles is twenty-nine ticks, and the SHAPE is the whole decision. Three separations are visible as
 * EMPTY CELLS and could not be stated in a paragraph without a reader taking them on trust — the
 * `radiographer` column blank at `reports.sign`, the `radiology_receptionist` column blank at
 * `gates.satisfy`, and the `pcpndt_incharge` column blank at `form_f.write` while ticked at
 * `form_f.verify`. The thirteen grants that fall outside it are `RADIOLOGY_PAIRS`.
 */
const radiologyTable = tables.find((t) => t.roles[0] === "radiologist");
/**
 * PLAN 16c T1 — **THE SEVENTH TABLE**, and it is SMALL on purpose: four strings across two roles is
 * six ticks, and the whole decision is the two EMPTY CELLS in the `pharmacy_assistant` column —
 * `.scheduled` (the Pharmacy Act) and `.sale_items.manage` (the price). Two empty cells a paragraph
 * would have to ask the reader to take on trust. The ten grants outside it are `PHARMACY_PAIRS`.
 */
const pharmacyTable = tables.find((t) => t.roles[0] === "pharmacy");
if (
  opdTable === undefined || billingTable === undefined || materialsTable === undefined
  || otTable === undefined || labTable === undefined || radiologyTable === undefined
  || pharmacyTable === undefined
) {
  throw new Error(
    "README.md: could not identify all four permission tables by their first role column " +
      `(found: ${tables.map((t) => t.roles.join("+")).join(" | ")}) — this parser is stale`,
  );
}

describe("seed:roles — the census pins, stated before anything is compared (§2.49)", () => {
  it("ALL_MANIFESTS declares one hundred and thirty-four permissions, by module", () => {
    const byKey = new Map(ALL_MANIFESTS.map((m) => [m.key, m.permissions.length]));
    expect(Object.fromEntries(byKey)).toEqual({
      auth: 7, // 11e's six + `auth.elevation.review` (the elevation-review queue)
      workflow: 8,
      approvals: 4,
      patients: 7, // PLAN 22c-A T1 — 5 -> 7: the privacy write split (DD7), both held by nobody
      tariff: 5,
      // RC-1 T2 / D5 — 14 -> 15 with `opd.counter.flow.manage`: the supervisor's lock pill,
      // deliberately narrower than `opd.config.manage` (which stays opd_admin's alone).
      // VD-1 T4 — 15 -> 16 with `opd.vitals.history.read`: the vitals bay's one-row pre-stage
      // read. Narrower than `opd.consult` (the whole consultation surface) and narrower than
      // `patientVitalsHistory` (every reading across the merge chain) — the bay needs the LAST
      // one, to stage the file and to carry a height forward greyed and locked.
      opd: 16,
      billing: 14,
      alerts: 0,
      ops: 3,
      // PLAN 09 T1. BOTH modules declare their whole phase's permissions HERE, ahead of the routes
      // that guard on them, because `seed-roles.ts` and this file are named in T1's Files list and
      // in no later task's (§6.0 S9): a permission declared by T5 would fail this build for a task
      // that is not allowed to fix it.
      membership: 8, // RC-2 T4 added `membership.instrument.enrol` (D5's enrol/apply split)
      partners: 7,
      // PLAN 16a T2 / DD10. Declared here ahead of the routes that guard on them, for exactly the
      // reason the paragraph above gives: `seed-roles.ts` and this file are named in T2's Files
      // list and in no later task's, so a string first declared by T7 or T8 would fail this build
      // for a task that is not allowed to fix it.
      formulary: 3,
      // PLAN 13 T2 / DD14. ONE string, and the only one this phase can declare: `resources.read`
      // guards T5's three read routes. There is deliberately no `resources.manage` — registry
      // master writes keep going through OPD's `opd.masters.manage` routes, which delegate into the
      // registry from T6 (DD9), and a `manage` string declared here would be a permission held by
      // somebody and reaching nothing.
      resources: 1,
      // PLAN 17 T2 / DD16. FIFTEEN strings, all declared here ahead of the routes that guard on
      // them, for the reason the `membership`/`partners` paragraph above gives: `seed-roles.ts`,
      // this file and `README.md` are named in T2's Files list and in NO later task's, so a string
      // first declared by T7 or T8 would fail this build for a task that is not allowed to fix it.
      lab: 18, // 17-E T1: 15 -> 16 (lab.instruments.manage); T2: -> 17 (lab.instruments.read); T3: -> 18 (lab.results.interface)
      // PLAN 14 T2 / DD11. ELEVEN strings, all declared here ahead of the routes that guard on
      // them, for the reason the `membership`/`partners` paragraph above gives: `seed-roles.ts`,
      // this file and `README.md` are named in T2's Files list and in NO later task's, so a string
      // first declared by T6 or T8 would fail this build for a task that is not allowed to fix it.
      //
      // The split across the eleven is the phase's one RBAC decision (DD11): `materials_head` holds
      // all of them, `storekeeper` holds six, and `pharmacy` gains the three that make a QC verdict
      // informed. `grn.capture` and `grn.qc` are DELIBERATELY two strings for what is one desk
      // today — DD8's two-stage gate — so that the day a PO-approver/receiver SoD pair is ruled
      // (14b, and O1), it is a `sod_pairs` row rather than a refactor.
      materials: 11,
      // PLAN 15 T2 / DD14 — fourteen, declared on the manifest ahead of every route that guards on
      // them (T8 mounts the routes). The count is the module's whole authority surface: four about
      // the case (`read/book/cancel` + `list.manage`), three about the gates
      // (`satisfy/override` + `definitions.read`), one about definition governance
      // (`definitions.manage`), four about the theatre floor
      // (`cockpit.operate`, `implants.scan`, `counts.record`, `recovery.operate`), one about
      // leaving (`discharge`) and one about the money (`bill.compose`).
      ot: 14,
      // PLAN 07c T9 / DD14 — TWO strings, and the split between them IS the design decision.
      // `staff.reports.read` buys a named person's FIGURES (counts, money, timings) and is granted
      // to `front_office_supervisor` and `medical_superintendent`; `staff.reports.drill` buys the
      // PATIENT ROWS behind those figures and is held by nobody, on the `patients.confidential.read`
      // argument — the mechanism is built and audited, and who holds it is an owner/DPO ruling.
      desk: 2,
      // PLAN 17 PHASE 0 T5 — FOUR strings, and every one of them is in `NOT_YET_MODELLED`.
      // `orders.place` is the kernel half of a TWO-permission gate (the kind declares the other
      // half, e.g. `lab.orders.place`), `orders.read` guards the cross-kind readers,
      // `orders.cancel` is enforced by the claiming module's route rather than by the kernel, and
      // `orders.read.restricted` is DD11's separate grant for HIV/NACO, exposure-protocol and
      // PCPNDT-class items. Declared here ahead of every route for the `membership`/`materials`
      // reason above: `seed-roles.ts` and this file are named in T5's Files list and in no later
      // task's.
      orders: 4,
      /**
       * PLAN 18a T2 — the statutory register's five and radiology's fifteen, declared at T2 ahead
       * of every route that guards on them. `pcpndt` is its own module (DD1) so that 15b and 62 can
       * install the register WITHOUT radiology: one gap-free Form F serial series per machine per
       * year, whichever department held the probe.
       */
      pcpndt: 5,
      /**
       * PLAN 18c T1 — the AERB registers' three, and `aerb` is its own module for the reason
       * `pcpndt` is (D1): the cath lab (63) and radiation oncology (64) file an equipment licence
       * and write a dose row without installing a department. One register for one inspector.
       */
      aerb: 3,
      pharmacy: 4, // PLAN 16c T1
      radiology: 16, // PLAN 18b T1 — `radiology.mwl.read`
    });
    // VD-1 T4 — +1 with `opd.vitals.history.read` (vitals_desk + doctor).
    expect(installedRegistry().allPermissions()).toHaveLength(160); // RC-1 T2: 146 -> 147; VD-1 T4: 148; RC-2 T4: 149; 18b T1: 150 (radiology.mwl.read); 16c T1: 154, the four pharmacy.* strings; 18c T1: 157, the three aerb.* strings; 17-E T1: 158 (lab.instruments.manage)
  });

  it("the role model is thirty-seven roles, three hundred and five grants, one hundred and forty distinct permissions", () => {
    expect(ROLE_MODEL.map((r) => r.roleKey)).toEqual([
      "front_office",
      "front_office_supervisor",
      "vitals_desk",
      "doctor",
      "opd_admin",
      "display",
      "pharmacy",
      "cashier",
      "billing_manager",
      // The two governance roles, added by the 2026-08-23 workflow ruling.
      "owner",
      "medical_superintendent",
      // Group C, 2026-08-26: `duty_manager` had existed since `seed:ops` with three `ops.*` and no
      // model row at all. It joins for ONE string — the temp-role mechanism built for the night
      // shift — and that row was unsafe to write before the elevation ceiling landed.
      "duty_manager",
      // OWNER RULING 2026-08-29 (Plan 07c T9 / DD14) — the TWENTY-FIFTH role, registered directly
      // after the duty manager. It exists so `staff.reports.drill` reaches exactly ONE named
      // person: adding the string to `duty_manager`, which that person already holds, would have
      // handed patient rows from every shift to three people and undone DD14's whole point.
      "staff_auditor",
      // Group A, 2026-08-26: three roles for permissions that previously had NO holder, so their
      // live routes answered 403 to every account on the deployment.
      "tariff_editor",
      "membership_admin",
      // The merge lane, 2026-08-26: blocked on machinery rather than on a ruling until
      // `seed:patients` registered `patient_merge`.
      "mrd_officer",
      "biomedical_engineer",
      // PLAN 14 / DD11, 2026-08-27 — the two stores roles, APPENDED so the sixteen above keep the
      // order they were added in. Both are created with grants and no holders, the `pharmacy`
      // precedent: production held 33 users and no storekeeper at kickoff.
      "materials_head",
      "storekeeper",
      // PLAN 15 / DD14, 2026-08-28 — the six OT roles, APPENDED so the eighteen above keep the
      // order they were added in. All six are created with grants and no holders (Spike Q3: none
      // of the six keys exists on production), the `materials_head` precedent one phase later.
      "ot_incharge",
      "surgeon",
      "anaesthetist",
      "ot_nurse",
      "recovery_nurse",
      "daycare_coordinator",
      // PLAN 17 T2 / DD16, 2026-08-29 — the four LAB roles, APPENDED so the twenty-five above keep
      // the order they were added in. All four are created with grants and no holders, the
      // `pharmacy` and `storekeeper` precedent: production held no lab staff at kickoff and the
      // roster that hires them is §9.9's runbook act, not this seed's.
      "pathologist",
      "lab_technician",
      "phlebotomist",
      "lab_reception",
      // PLAN 18a T2 — the four radiology roles, appended in ROLE_MODEL order.
      "radiologist",
      "radiographer",
      "radiology_receptionist",
      "pcpndt_incharge",
      // PLAN 18c T1 — the other statutory officer, appended beside the first.
      "radiation_safety_officer",
      // PLAN 18b T1 — the machine account that pulls the modality worklist.
      "modality_bridge",
      // PLAN 17-E T2 — the analyser bridge, `modality_bridge`'s shape one department over, and it
      // sits HERE rather than at the end: it is declared beside its sibling in `seed-roles.ts`, and
      // this list is in ROLE_MODEL order.
      "lab_bridge",
      // PLAN 16c T1 — the dispensing aide, appended.
      "pharmacy_assistant",
    ]);
    expect(Object.fromEntries(ROLE_MODEL.map((r) => [r.roleKey, r.permissions.length]))).toEqual({
      // Plan 09 / DD18 moved four of these: +3 each to the two desk roles and the cashier (read,
      // recognise, request), +1 to billing_manager (approve). No other role gained anything, and
      // `vitals_desk` deliberately gained nothing — vitals are recorded against a patient who is
      // already at the counter, and recognition happens where the invoice is.
      front_office: 12,
      // PLAN 07c T9 — 13 → 14 with `staff.reports.read`. This is the role the phrase "the
      // supervisor" in owner ruling O-2 actually means.
      // RC-1 T2 — 14 -> 15 with the counter-flow lock (D5): the pill, not the config editor.
      // RC-2 T4 — 15 -> 16 with `membership.instrument.enrol` (D5): this role may MINT a card;
      // `front_office` above may only honour one, which is the whole of the enrol/apply split.
      front_office_supervisor: 16,
      vitals_desk: 6, // VD-1 T4 — 5 -> 6 with `opd.vitals.history.read`, the bay's pre-stage read
      // Group B, 2026-08-26: +2, the patient record and the allergy register.
      // Plan 16a / DD10: +1, the formulary read the consult autocomplete needs.
      // PLAN 07d T5 / DD6 — 10 -> 11 with `tariff.read`, so the cockpit can price advised tests.
      // PLAN 17 T2 / DD16 — 11 -> 17: `lab.orders.place`, `lab.results.read`, `lab.catalogue.read`
      // and the kernel's three `orders.*`. The doctor orders the test and reads the result, and
      // `lab.results.read` is the grant that makes DD6's safety rule true — the interlock holds a
      // printed report, never a clinician's screen.
      // PLAN 18a T2 — 17 -> 19: `radiology.orders.place` and `radiology.reports.read`. The
      // referring clinician orders the scan and reads the REPORT — not the worklist, which is a
      // departmental queue and, per DD11, a confidentiality-bearing one.
      doctor: 20, // VD-1 T4 — 19 -> 20, the same string: the bay reads it and the clinician it hands to must too
      // Plan 13 / DD14: +1, the registry read — the same room book this role already administers,
      // now behind a kernel permission. No new authority (see RESOURCES_PAIRS).
      opd_admin: 8, // RC-1 T2 — 7 -> 8: the admin who edits the whole config can also flip the flow

      display: 1,
      // Group B, 2026-08-26: +1, the allergy register at the dispensing counter.
      // Plan 16a / DD10: +3, the whole formulary — read, manage, and staging review. The module is
      // curated at the pharmacy and nowhere else.
      // PLAN 14 / DD11: +3, the materials READ halves and the drug QC verdict. The pharmacist is
      // the QC signatory for drugs (doc 09 §7), and an item is the shelf side of a medicine this
      // same role already curates — a curator who cannot see that `Crocin 500mg tablet` is stocked
      // as `CROC500` in three stores is curating half a fact.
      // PLAN 16c T1: 8 -> 19, the counter (four pharmacy.*, three orders.*, four billing.*).
      pharmacy: 19,
      cashier: 11,
      // PLAN 07b O-1, OWNER RULING 2026-08-29 — 11 -> 18. Seven strings that let this role WORK A
      // COUNTER while a cashier's drawer is locked pending its variance approval. Under R-4's
      // one-staffer counter that lockout closes the hospital's front door, and a cover that first
      // needs a temp-role grant from somebody who may not be on site is a cover on paper.
      // PLAN 17 T2 / DD6 — 18 -> 19: `lab.reports.release_unpaid`. The interlock's override belongs
      // to the office that carries the receivable, not to the pathologist standing in front of the
      // patient who is asking.
      // PLAN 18a T2 — 19 -> 20: the imaging bill-decision queue (T7). A repeat film and a
      // contrast escalation are questions answered in money, which is this office's call.
      billing_manager: 20,
      // Group A, 2026-08-26: +4 — tariff.read, the activator key, tariff config, and approval-type
      // governance. `owner` is now the activator for BOTH ceremonies, workflow and price list.
      // Group B then added +3: the invoice, the daybook and the cashier sessions. NOT patients.read.
      owner: 10,
      // Group C, 2026-08-26: +2, the break-glass and elevation review desks. The merge lane then
      // added +3 — the approvals pair it is the approverRole for, and the records it decides about.
      // PLAN 07c T9 — 9 → 10 with `staff.reports.read`, for the reason the two review desks moved
      // to this role in the first place: staff and medical-record governance is its job (spec §14,
      // role card #39), not the technical administrator's.
      medical_superintendent: 10,
      duty_manager: 1,
      // OWNER RULING 2026-08-29 — two strings, one role, one holder: the figures and the rows.
      staff_auditor: 2,
      tariff_editor: 3,
      // RC-2 T4 — 2 -> 3 with `membership.instrument.enrol`: the role that works the holder book
      // may also put somebody into it from the counter (the lane itself stays flag-OFF, O-15).
      membership_admin: 3,
      // OWNER RULING 2026-08-29 — 3 -> 5: the privacy write split gets its holder. Merging two
      // records for one person and deciding a person is invisible or deceased are the same kind
      // of authority over the same object, so they sit with the role that already holds
      // `patients.merge`.
      mrd_officer: 5,
      biomedical_engineer: 1,
      // PLAN 14 T2 / DD11 — the two stores roles. `pharmacy` moved 5 → 8 in the same commit (the
      // three read/QC strings), which is why the grant total moves by twenty and not by seventeen.
      materials_head: 11,
      storekeeper: 6,
      // PLAN 15 T2 / DD14 — the six OT roles. `medical_superintendent` moved 12 → 14 and
      // `billing_manager` 9 → 10 in the same commit (the three `OT_PAIRS`), which is why the grant
      // total moves by thirty-five and not by thirty-two.
      // PLAN 17 T2 / DD16 — 11 -> 15: the pre-op panel is ordered from the theatre, not from an
      // OPD chair, and the coordinator is who orders it.
      ot_incharge: 15,
      // PLAN 17 T2 / DD16 — 4 -> 9: orders the pre-op panel and reads it. NOT `orders.cancel`:
      // calling off a lab order the coordinator placed is the coordinator's act.
      surgeon: 9,
      anaesthetist: 4,
      ot_nurse: 4,
      recovery_nurse: 3,
      daycare_coordinator: 6,
      // ── PLAN 17 T2 / DD16 — the LAB's four, and the SHAPE is the decision ──
      // `pathologist` 17 against `lab_technician` 8: the difference is `lab.results.verify`,
      // `lab.catalogue.manage`, `lab.instruments.manage`, the three `lab.reports.*` and the
      // ordering pair — the signature, the range book, the BENCH's machines, the report and the
      // add-on. 17-E T1 added the machines for the same reason the range book is there: which
      // analyser reports which test is a document NABL asks about. `phlebotomist` 4 is the narrowest role in this
      // file after `display` and `biomedical_engineer`, deliberately: the chair needs a name and a
      // tube, never a number. `lab_reception` 16 is a COUNTER — eleven of its sixteen are
      // `patients.*`, `billing.*` and `orders.*`, and not one is a `lab.results.*`.
      pathologist: 17, // 17-E T1: +1, lab.instruments.manage; T2: +1, lab.instruments.read
      // PLAN 18a T2 — the four new roles. `radiologist` at 14 against `radiographer` at 8 IS the
      // separation this phase is built around: reports.write/sign/amend and gates.override on one
      // side, checkin and gates.satisfy on the other, and neither list overlaps the other's core.
      pcpndt_incharge: 4,
      // PLAN 18c T1 — the RSO's three: manage, read, and the dose read the register is built on.
      radiation_safety_officer: 3,
      lab_technician: 8,
      phlebotomist: 4,
      radiographer: 10, // 18b T1: +`radiology.mwl.read`; 18c T1: +`aerb.doses.read`
      radiologist: 15, // 18c T1: +`aerb.doses.read`, the cumulative nudge at protocolling
      radiology_receptionist: 13,
      lab_reception: 17, // 17c owner ruling 2026-09-02: +approvals.requests.create
      // PLAN 18b T1 — one string, on purpose (see the role's docstring in seed-roles.ts).
      modality_bridge: 1,
      lab_bridge: 2, // PLAN 17-E T2 -> T3: +lab.results.interface. PLAN 17-E T2 — the analyser bridge, one string like its radiology sibling
      pharmacy_assistant: 5, // PLAN 16c T1
    });
    // PLAN 07c T9 — 156 → 158: `staff.reports.read` to `front_office_supervisor` and to
    // `medical_superintendent`. Two grants, one string, no new role.
    // 159 -> 168: the 2026-08-29 rulings add `staff_auditor`'s two and the counter cover's seven.
    // 168 -> 170: the same day's LAST ruling, after 22c-A deployed — `mrd_officer` gains both
    // privacy-write strings, which is TWO pairs and TWO new distinct strings, because no other
    // role held either one.
    // 170 -> 230 with Plan 17 T2: twenty-six lab-table ticks plus thirty-four non-table grants.
    // 230 -> 272 with Plan 18a T2: the four radiology roles bring 14 + 8 + 13 + 4 = 39, and three
    // existing roles gain three more — `doctor` the two referring-clinician strings, and
    // `billing_manager` the imaging bill-decision queue.
    // 272 -> 274 with RC-1 T2: `opd.counter.flow.manage` to `front_office_supervisor` and to
    // `opd_admin` — two grants, one string, no new role.
    // VD-1 T4 — 274 -> 276: `opd.vitals.history.read` to `vitals_desk` and to `doctor`.
    // 18c T1 — 297 -> 302: the RSO's three, plus `aerb.doses.read` to `radiologist` and to
    // `radiographer` (D2 — the cumulative-dose nudge is clinical; the licence file is not).
    expect(modelPairs()).toHaveLength(305); // 17c owner ruling: +1, approvals.requests.create to lab_reception; RC-2 T4: +2, the enrol grants; 18b T1: +2 (radiology.mwl.read); 16c T1: +16 (pharmacy +11, pharmacy_assistant +5); 17-E T1: +1 (lab.instruments.manage to pathologist); T2: +1 (lab.instruments.read to lab_bridge)
    // PLAN 07c T9 — 83 → 84 DISTINCT: one new string (`staff.reports.read`) across two roles.
    // 84 -> 85 DISTINCT: only `staff.reports.drill` is new to the MODEL. Every other string the
    // two rulings grant was already held by another role — the counter cover moves WHO may act,
    // not WHAT the system can do.
    // 87 -> 105 DISTINCT: the lab's fifteen strings are all new to the model, and so are the
    // kernel's `orders.place`, `orders.read` and `orders.cancel`. Every other string the phase
    // grants — `patients.*`, `billing.*` — was already held by another role: `lab_reception` moves
    // WHO may act at a counter, not WHAT the system can do.
    // 105 -> 125 DISTINCT: all twenty of this phase's strings are new to the model, because no
    // role could have held a `radiology.*` or `pcpndt.*` string before the manifests declaring them
    // were installed. Every other string the four new roles hold — `orders.*`, `patients.*`,
    // `billing.*` — was already in the model: the receptionist moves WHO may act at a counter, not
    // WHAT the system can do, exactly as `lab_reception` did.
    // 125 -> 126 DISTINCT: only the flow lock is new to the model.
    // VD-1 T4 — 126 -> 127 distinct model permissions.
    // 18c T1 — 134 -> 137: all three `aerb.*` strings are new to the model, because no role could
    // have held one before the manifest declaring them was installed.
    expect(modelPermissions()).toHaveLength(140); // 17c owner ruling: +1, approvals.requests.create; RC-2 T4: +1, membership.instrument.enrol; 18b T1: +1, radiology.mwl.read; 16c T1: +4, pharmacy.*; 17-E T1: +1, lab.instruments.manage
    // No role lists the same permission twice — a duplicate would inflate the counts above
    // without changing a single row of `role_permissions`.
    for (const role of ROLE_MODEL) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it("the reachability census closes: 157 declared = 142 held + 15 not yet modelled", () => {
    // VD-1 T4 — 147 -> 148 declared and 132 -> 133 held, NOT_YET_MODELLED UNCHANGED at fifteen:
    // the permission is granted in the same commit that declares it, so it never passes through.
    expect(installedRegistry().allPermissions()).toHaveLength(160);
    // 42 + 13 until the 2026-08-23 ruling moved the four `workflow.definitions.*` strings across;
    // 46 + 13 until Plan 09 declared fourteen and DD18 granted four of them.
    // 50 until `auth.elevation.review` was declared; it is held from the first deploy because
    // `seed:admin` grants every `authManifest` string to `admin` (GRANTED_BY_OTHER_SEEDS), so it
    // never passes through NOT_YET_MODELLED.
    // 51 + 23 until Group A (2026-08-26) granted eight strings that had guarded live routes with
    // no holder at all; they moved from one side of this sum to the other, which is exactly what
    // NOT_YET_MODELLED's header promises happens the day a gap is closed.
    // 60 + 14 until Plan 16a declared three `formulary.*` strings and DD10 granted ALL THREE —
    // the first phase in a while whose new permissions pass NOT_YET_MODELLED by entirely, because
    // the role that holds them (`pharmacy`) already existed and the spec already said who curates.
    // 63 + 14 until Plan 13 declared ONE `resources.*` string and DD14 granted it in the same
    // commit — so, like the formulary before it, it passes NOT_YET_MODELLED by entirely. The list
    // of fourteen is UNCHANGED by this phase, which is the number worth reading here: a phase that
    // declares a permission and cannot grant it in the same task is a phase that has to add a row
    // to that list with a reason, and this one did not have to.
    // PLAN 14 T2 — 78 → 89 declared and 64 → 75 held, and **NOT_YET_MODELLED IS UNCHANGED AT
    // FOURTEEN**, which is the number worth reading here. All eleven new strings are granted in the
    // same commit that declares them, so this phase adds nothing to the list of permissions held by
    // nobody — the property the paragraph above says a phase "has to add a row with a reason" for.
    // PLAN 15 T2 — 89 → 103 declared and 75 → 89 held, and **NOT_YET_MODELLED IS UNCHANGED AT
    // FOURTEEN** for the third phase running. All fourteen new strings are granted in the same
    // commit that declares them. One of the fourteen nearly was not: DD14 assigned
    // `ot.bill.compose` to a `billing_counter` role that does not exist, and a grant to a
    // non-existent role is not a grant — the string would have landed on the other side of this
    // sum with nothing anywhere saying so. It goes to `billing_manager` (finding T2-d).
    // PLAN 07c T9 — 103 → 105 declared, 89 → 90 held, and **NOT_YET_MODELLED MOVES FOR THE FIRST
    // TIME IN FOUR PHASES: 14 → 15.** That is the phase's decision showing up in the arithmetic
    // rather than being buried in it: `staff.reports.drill` is granted to nobody ON PURPOSE (DD14
    // splits the figures from the rows), so unlike the last three phases this one does add a
    // permission that no role holds — with a reason, which is what the list is for.
    // OWNER RULING 2026-08-29 — `staff.reports.drill` LEAVES the not-yet-modelled list (15 -> 14)
    // and joins the held set (90 -> 91). It is the only string this ruling moves: every other
    // permission the two rulings grant was already held by some other role.
    // PLAN 22c-A T1 — 105 -> 107 declared, held UNCHANGED at 91, and NOT_YET_MODELLED 14 -> 16.
    // PLAN 17 PHASE 0 T5 — 107 -> 111 declared, held UNCHANGED at 91, NOT_YET_MODELLED 16 -> 20.
    // The envelope has no consumers on the day it lands: no manifest claims an order kind, so
    // `placeOrder` refuses everything with `unknown_kind` and there is no route any of the four
    // could guard. A grant now would be authority over nothing, and would be the reason nobody
    // looks at it again when Plan 17's lab module gives it something to do (§8.11).
    // Both new strings land on the unheld side ON PURPOSE (DD7), which makes this the second
    // phase running to move that list — and unlike 07c's single row, this one adds two and grants
    // nothing. That is the whole content of the privacy write split: `patients.confidential.write`
    // and `patients.deceased.write` exist so that `patients.update` stops carrying them, and
    // granting either one here would have re-opened the door the split closes. The owner's grant
    // is a runbook step, and until it happens NOBODY can set those fields — which is strictly
    // safer than today, where seventeen users can.
    // OWNER RULING 2026-08-29, the day AFTER 22c-A shipped them unheld: 91 -> 93 held and
    // 20 -> 18 unmodelled, declared UNCHANGED at 111. Two strings crossed from one side of this
    // sum to the other without a new permission existing — which is exactly what
    // NOT_YET_MODELLED's header promises happens the day somebody rules, and the second time
    // this list has emptied in two days.
    // PLAN 17 T2 — 93 -> 111 held and **18 -> 15 unmodelled, which is the number worth reading
    // here**: the phase declares fifteen new strings AND takes three OFF the unmodelled list at the
    // same time. Every one of its own fifteen is granted in the commit that declares them, so it
    // adds nothing to the list of permissions held by nobody; and `orders.place`, `orders.read` and
    // `orders.cancel` cross from one side of this sum to the other exactly as phase 0's entries
    // predicted they would. **`orders.read.restricted` stays**, deliberately — see the note in
    // `seed-roles.ts` where those three entries were removed.
    expect(heldPermissions()).toHaveLength(146); // 17c owner ruling: 140 (approvals.requests.create); PLAN 18a T2: 111 -> 131; VD-1 T4: 133; RC-2 T4: 134; 18b T1: 135; 16c T1: 139, the four pharmacy.* strings, granted in the commit that declares them; 18c T1: 143; 17-E T1: 144, the three aerb.* strings, likewise granted where they are declared
    // RC-1 T2 — 146 -> 147 declared and 131 -> 132 held, NOT_YET_MODELLED UNCHANGED at fifteen:
    // the flow lock is granted in the same commit that declares it.
    expect(NOT_YET_MODELLED).toHaveLength(14); // 17c owner ruling: approvals.requests.create is held now
    expect(heldPermissions().length + NOT_YET_MODELLED.length).toBe(160); // 18b T1: +1; 16c T1: +4; 18c T1: +3; 17-E T1: +1
  });

  it("the README carries exactly four permission tables, of the measured shapes", () => {
    // FOUR since Plan 15 T2 / DD14 — see the `materialsTable` and `otTable` docstrings above for
    // why materials and the OT take tables where `formulary` and `resources` took non-table pairs.
    // SIX since Plan 18a T2 — see the `radiologyTable` docstring for why radiology takes a table
    // where `formulary` and `resources` took non-table pairs: three separations that are EMPTY
    // CELLS, and a paragraph cannot show an empty cell.
    // SEVEN since Plan 16c T1 — see the `pharmacyTable` docstring: two empty cells are the decision.
    expect(tables).toHaveLength(7);
    expect(opdTable.roles).toEqual([
      "front_office",
      "front_office_supervisor",
      "vitals_desk",
      "doctor",
      "opd_admin",
      "display",
      "pharmacy",
    ]);
    // RC-1 T2 — 14 -> 15 rows and 29 -> 31 ticks: the flow lock lands in the TABLE (its module
    // already has one), ticked for the supervisor and the admin.
    // VD-1 T4 — 15 -> 16 rows and 31 -> 33 ticks: `opd.vitals.history.read` lands in the TABLE
    // (its module already has one), ticked for `vitals_desk` and `doctor`.
    expect(opdTable.rowCount).toBe(16);
    expect(opdTable.cells.size).toBe(16);
    expect(tablePairs(opdTable)).toHaveLength(33);

    expect(billingTable.roles).toEqual(["cashier", "billing_manager"]);
    // FIFTEEN rows yielding SIXTEEN permissions is the proof that the `/ .decide` shorthand was
    // EXPANDED rather than skipped. A parser that dropped it would report 15 and 15.
    expect(billingTable.rowCount).toBe(15);
    expect(billingTable.cells.size).toBe(16);
    expect(billingTable.cells.get("approvals.requests.read")).toEqual(["billing_manager"]);
    expect(billingTable.cells.get("approvals.requests.decide")).toEqual(["billing_manager"]);
    expect(tablePairs(billingTable)).toHaveLength(17);

    // PLAN 14 T2 / DD11 — the third table. ELEVEN rows, eleven permissions (no shorthand cell) and
    // TWENTY ticks: 11 for `materials_head`, 6 for `storekeeper`, 3 for `pharmacy`. The three
    // counts are pinned separately from the total because the total alone would survive a diff that
    // moved a tick from one role to another — and "who may sign the QC verdict" is exactly the cell
    // a well-meaning edit would move.
    expect(materialsTable.roles).toEqual(["materials_head", "storekeeper", "pharmacy"]);
    expect(materialsTable.rowCount).toBe(11);
    expect(materialsTable.cells.size).toBe(11);
    expect(tablePairs(materialsTable)).toHaveLength(20);
    expect(tablePairs(materialsTable).filter((p) => p.startsWith("materials_head/"))).toHaveLength(11);
    expect(tablePairs(materialsTable).filter((p) => p.startsWith("storekeeper/"))).toHaveLength(6);
    expect(tablePairs(materialsTable).filter((p) => p.startsWith("pharmacy/"))).toHaveLength(3);
    // DD8's two-stage gate, as two cells: the storekeeper captures and does NOT sign the verdict.
    expect(materialsTable.cells.get("materials.grn.capture")).toEqual(["materials_head", "storekeeper"]);
    expect(materialsTable.cells.get("materials.grn.qc")).toEqual(["materials_head", "pharmacy"]);
    // The narrowest grant in the module: one action stops every location's stock of a batch.
    expect(materialsTable.cells.get("materials.recall.manage")).toEqual(["materials_head"]);

    // PLAN 15 T2 / DD14 — the fourth table. TWELVE rows, twelve permissions (no shorthand cell) and
    // THIRTY-TWO ticks. Per-role counts are pinned separately from the total for the materials reason,
    // which bites harder here: the total alone would survive a diff that moved `ot.gates.override`
    // from `surgeon` to `ot_incharge`, and that single tick is the difference between a two-key
    // clinical override and a list manager waving a gate through to start on time.
    expect(otTable.roles).toEqual([
      "ot_incharge", "surgeon", "anaesthetist", "ot_nurse", "recovery_nurse", "daycare_coordinator",
    ]);
    expect(otTable.rowCount).toBe(12);
    expect(otTable.cells.size).toBe(12);
    expect(tablePairs(otTable)).toHaveLength(32);
    expect(tablePairs(otTable).filter((p) => p.startsWith("ot_incharge/"))).toHaveLength(11);
    expect(tablePairs(otTable).filter((p) => p.startsWith("surgeon/"))).toHaveLength(4);
    expect(tablePairs(otTable).filter((p) => p.startsWith("anaesthetist/"))).toHaveLength(4);
    expect(tablePairs(otTable).filter((p) => p.startsWith("ot_nurse/"))).toHaveLength(4);
    expect(tablePairs(otTable).filter((p) => p.startsWith("recovery_nurse/"))).toHaveLength(3);
    expect(tablePairs(otTable).filter((p) => p.startsWith("daycare_coordinator/"))).toHaveLength(6);

    // ── The three separations DD14 exists for, as cells rather than as prose ──
    //
    // 1. The override is the two clinicians' and NOBODY else's — least of all the in-charge.
    expect(otTable.cells.get("ot.gates.override")).toEqual(["surgeon", "anaesthetist"]);
    // 2. The patient leaves from the bay: the person who scores her signs her out.
    expect(otTable.cells.get("ot.discharge")).toEqual(["ot_incharge", "recovery_nurse"]);
    // 3. `ot.definitions.manage` and `ot.bill.compose` appear in NO column of this table at all —
    //    they are `OT_PAIRS`, held by the MS and by `billing_manager`. A table cell for either
    //    would be the in-charge redefining the unit's scope or billing for its own list.
    expect(otTable.cells.get("ot.definitions.manage")).toBeUndefined();

    expect(pharmacyTable.roles).toEqual(["pharmacy", "pharmacy_assistant"]);
    expect(pharmacyTable.rowCount).toBe(4);
    expect(pharmacyTable.cells.size).toBe(4);
    expect(tablePairs(pharmacyTable)).toHaveLength(6);
    expect(pharmacyTable.cells.get("pharmacy.dispense.scheduled")).toEqual(["pharmacy"]);
    expect(pharmacyTable.cells.get("pharmacy.sale_items.manage")).toEqual(["pharmacy"]);
    expect(otTable.cells.get("ot.bill.compose")).toBeUndefined();

    // ── PLAN 17 T2 / DD16 — THE FIFTH TABLE, and the four separations it exists to show ──
    //
    // Fourteen rows rather than fifteen: `lab.reports.release_unpaid` appears in NO column,
    // because the role that holds it is `billing_manager` and a lab station column for it would be
    // the lab approving its own override.
    expect(labTable.rowCount).toBe(17); // 17-E T1: +1, lab.instruments.manage; T2: +1, lab.instruments.read; T3: +1, lab.results.interface
    expect(labTable.roles).toEqual(["pathologist", "lab_technician", "phlebotomist", "lab_reception", "lab_bridge"]);
    expect(tablePairs(labTable)).toHaveLength(29); // 17-E T1: +1; T2: +1; T3: +1 (the bridge's second tick)
    expect(tablePairs(labTable).filter((p) => p.startsWith("pathologist/"))).toHaveLength(13); // 17-E T1: +1
    expect(tablePairs(labTable).filter((p) => p.startsWith("lab_technician/"))).toHaveLength(6);
    expect(tablePairs(labTable).filter((p) => p.startsWith("phlebotomist/"))).toHaveLength(3);
    expect(tablePairs(labTable).filter((p) => p.startsWith("lab_reception/"))).toHaveLength(5);

    // 1. The signature is the pathologist's alone. DD11's SoD is enforced per RESULT ROW as well,
    //    and the two controls are deliberate duplication on one risk: a technologist who could
    //    verify would make the row check the only thing between a keyed number and a signed report.
    expect(labTable.cells.get("lab.results.verify")).toEqual(["pathologist"]);
    // 2. THE COUNTER READS NO RESULT. Every `lab.results.*` string omits `lab_reception`, and this
    //    is the assertion that says so as a shape rather than as a promise in a comment.
    for (const permission of ["lab.results.enter", "lab.results.verify", "lab.results.read"]) {
      expect(labTable.cells.get(permission)).not.toContain("lab_reception");
    }
    // 3. The phlebotomist touches no result at all — the chair needs a name and a tube, never a
    //    number — and holds the ONLY `lab.collection.operate` cell.
    expect(labTable.cells.get("lab.collection.operate")).toEqual(["phlebotomist"]);
    expect(tablePairs(labTable).filter((p) => p.startsWith("phlebotomist/lab.results"))).toEqual([]);
    // 4. `lab.reports.release_unpaid` is in no column of this table: releasing a held report is a
    //    decision to carry a receivable, and that is `billing_manager`'s (see `LAB_PAIRS`).
    expect(labTable.cells.get("lab.reports.release_unpaid")).toBeUndefined();
  });

  it("both README parsers THROW on a shape they do not recognise, never return []", () => {
    expect(() => permissionTables("no table here at all\n", "synthetic")).toThrow(/no .* table found/);
    expect(() =>
      permissionTables("| Permission | cashier |\n| `billing.invoice.issue` | ✓ |\n", "synthetic"),
    ).toThrow(/rather than a markdown separator/);
    expect(() =>
      permissionTables("| Permission | cashier |\n|---|---|\n| `billing.invoice.issue` | yes |\n", "synthetic"),
    ).toThrow(/neither a tick nor blank/);
    expect(() =>
      permissionTables("| Permission | cashier |\n|---|---|\n| billing.invoice.issue | ✓ |\n", "synthetic"),
    ).toThrow(/neither a backticked dotted permission/);
    expect(() =>
      permissionTables("| Permission | cashier |\n|---|---|\n| `billing.invoice.issue` | ✓ | x |\n", "synthetic"),
    ).toThrow(/columns against the header's/);
    // And the shorthand really does expand, rather than the real table merely happening to parse.
    const expanded = permissionTables(
      "| Permission | billing_manager |\n|---|---|\n| `approvals.requests.read` / `.decide` | ✓ |\n",
      "synthetic",
    );
    expect([...(expanded[0]?.cells.keys() ?? [])]).toEqual([
      "approvals.requests.read",
      "approvals.requests.decide",
    ]);
  });

  it("every model role resolves to a title, from OPD_ROLE_KEYS or from LOCAL_ROLE_TITLES", () => {
    const opdKeys = OPD_ROLE_KEYS.map((r) => r.key);
    const modelKeys = ROLE_MODEL.map((r) => r.roleKey);
    // The two sources are NOT nested sets, and this pins the measured difference in both
    // directions: six model roles come from the constant, three are declared locally, and four
    // constant entries are role keys with no permission column anywhere.
    expect(modelKeys.filter((k) => opdKeys.includes(k))).toEqual([
      "front_office",
      "front_office_supervisor",
      "vitals_desk",
      "doctor",
      "opd_admin",
      "display",
      // `OPD_ROLE_KEYS` declared these two all along — the `opd_visit` Class A policy names them.
      // Before the 2026-08-23 ruling they were the third and fourth entries of the list below:
      // role keys with a title and no permission column anywhere.
      "owner",
      "medical_superintendent",
      // Group C, 2026-08-26. `OPD_ROLE_KEYS` had declared it all along; it simply held no model row.
      "duty_manager",
    ]);
    // Group A's three are declared locally: none of them is an OPD station.
    // PLAN 14 / DD11 appends two: neither `materials_head` nor `storekeeper` is an OPD station, so
    // neither belongs in `OPD_ROLE_KEYS` — a store is not a consulting room.
    expect(modelKeys.filter((k) => !opdKeys.includes(k))).toEqual([
      "pharmacy", "cashier", "billing_manager",
      // OWNER RULING 2026-08-29 — `staff_auditor` is declared locally: it is not an OPD station, it
      // is a governance seat, held by ONE person by design (DD14). This list is in ROLE_MODEL
      // order, and the role is registered directly after `duty_manager`.
      "staff_auditor",
      "tariff_editor", "membership_admin", "mrd_officer",
      "biomedical_engineer", "materials_head", "storekeeper",
      // PLAN 15 / DD14 appends six: a theatre is not a consulting room either, and `surgeon` and
      // `anaesthetist` in particular are NOT `doctor` — `doctor` is an OPD station key, these two
      // are what `signIn` and `overrideGate` match on.
      "ot_incharge", "surgeon", "anaesthetist", "ot_nurse", "recovery_nurse", "daycare_coordinator",
      // PLAN 17 T2 / DD16 appends four: a bench is not a consulting room, and `pathologist` in
      // particular is NOT `doctor` — `doctor` is an OPD station key, and this one is what the
      // `lab_item` definition's `verify` transition matches on.
      "pathologist", "lab_technician", "phlebotomist", "lab_reception",
      "radiologist", "radiographer", "radiology_receptionist", "pcpndt_incharge",
      "radiation_safety_officer", // PLAN 18c T1 — the RSO, a statutory seat and not a station
      "modality_bridge", // PLAN 18b T1 — the machine account
      "lab_bridge", // PLAN 17-E T2 — the analyser bridge
      // PLAN 16c T1 appends the dispensing aide.
      "pharmacy_assistant",
    ]);
    // `nurse` is now the ONLY constant entry with no permission column anywhere — `duty_manager`
    // left this list on 2026-08-26 when Group C gave it one.
    expect(opdKeys.filter((k) => !modelKeys.includes(k))).toEqual(["nurse"]);
    // The UNION covers the model exactly, and neither source shadows the other.
    expect(Object.keys(LOCAL_ROLE_TITLES).sort()).toEqual([
      "anaesthetist", "billing_manager", "biomedical_engineer", "cashier", "daycare_coordinator",
      "materials_head", "membership_admin", "mrd_officer", "ot_incharge", "ot_nurse", "pharmacy",
      // OWNER RULING 2026-08-29 — this list is SORTED, so `staff_auditor` lands between the
      // recovery nurse and the storekeeper. It is a governance seat with one holder, not a station.
      // PLAN 17 T2 / DD16 — this list is SORTED, so the lab's four land in three separate places.
      "lab_reception", "lab_technician", "pathologist", "phlebotomist",
      // PLAN 18a T2 — the four radiology roles. `.sort()` on both sides, so the source order here
      // is irrelevant; they are grouped for a reader rather than for the comparison.
      "radiologist", "radiographer", "radiology_receptionist", "pcpndt_incharge", "modality_bridge",
      // PLAN 18c T1 — the RSO.
      "radiation_safety_officer",
      "lab_bridge", // PLAN 17-E T2 — the analyser bridge
      "recovery_nurse", "staff_auditor", "storekeeper", "surgeon", "tariff_editor",
      "pharmacy_assistant",
    ].sort());
    expect(Object.keys(LOCAL_ROLE_TITLES).filter((k) => opdKeys.includes(k))).toEqual([]);
    for (const key of modelKeys) expect(roleTitle(key).length).toBeGreaterThan(0);
    expect(() => roleTitle("no_such_role")).toThrow(/resolves to no title/);
  });
});

describe("seed:roles — the reachability invariant (V1, V2)", () => {
  it("V1: every granted string is DECLARED by an installed manifest", () => {
    const declared = new Set(installedRegistry().allPermissions());
    const undeclared: string[] = [];
    for (const role of ROLE_MODEL) {
      for (const permission of role.permissions) {
        if (!declared.has(permission)) undeclared.push(`${role.roleKey}/${permission}`);
      }
    }
    for (const grant of GRANTED_BY_OTHER_SEEDS) {
      for (const permission of grant.permissions) {
        if (!declared.has(permission)) undeclared.push(`${grant.roleKey}/${permission}`);
      }
    }
    // A string no manifest declares is a permission `grantPermissionToRole` refuses outright and
    // therefore a grant that can never exist — a typo the seed would only find at run time, on a
    // live box, halfway through.
    expect(undeclared.sort()).toEqual([]);
  });

  it("V2: every declared permission is held by a role, or named as not yet modelled", () => {
    const declared = installedRegistry().allPermissions();
    const held = new Set(heldPermissions());
    const notYetModelled = new Set(NOT_YET_MODELLED.map((n) => n.permission));
    const orphans = declared.filter((p) => !held.has(p) && !notYetModelled.has(p)).sort();
    // The invariant. It fails the build the day a module adds a permission and forgets the role
    // model, which is the failure mode that produced MAJOR 4 twice.
    expect(orphans).toEqual([]);
  });

  it("V2: the not-yet-modelled list is disjoint from the grants, and every entry carries its reason", () => {
    const held = new Set(heldPermissions());
    const declared = new Set(installedRegistry().allPermissions());
    // A permission may not be both granted and recorded as unmodelled: that list is where a gap
    // is written down, never where an orphan is hidden.
    expect(NOT_YET_MODELLED.map((n) => n.permission).filter((p) => held.has(p))).toEqual([]);
    expect(NOT_YET_MODELLED.map((n) => n.permission).filter((p) => !declared.has(p))).toEqual([]);
    expect(new Set(NOT_YET_MODELLED.map((n) => n.permission)).size).toBe(NOT_YET_MODELLED.length);
    // The REASONS are asserted present, not merely the names. A list of bare strings is an
    // exceptions list wearing a different label, and "unreachable on purpose" is a different
    // claim from "no owner ruling exists yet".
    for (const entry of NOT_YET_MODELLED) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
    expect(NOT_YET_MODELLED.map((n) => n.permission).sort()).toEqual([
      // `approvals.requests.create` LEFT on 2026-09-02: the owner ruled it onto `lab_reception`
      // (Plan 17c §7) — the counter asks, the billing manager decides.
      // `approvals.types.manage` LEFT on 2026-08-26 (Group A → `owner`), and the five `tariff.*`
      // strings left with it. That is eight departures in one commit; the census above is what
      // proves they went somewhere rather than merely stopping being counted.
      //
      // Of Plan 09 / DD18's ten, only `membership.catalog.manage` remains — and its reason CHANGED
      // rather than persisted: it is now "guards no route in the tree", a measurement, where its
      // two siblings left because they guard live routes and gained `membership_admin`. The seven
      // `partners.*` still guard lanes that ship structurally OFF pending the owner's O-8 ruling.
      "membership.catalog.manage",
      // PLAN 17 PHASE 0 T5 — the envelope's four, all unheld on purpose (§8.11). No manifest
      // claims an order kind yet, so `placeOrder` refuses everything with `unknown_kind` and there
      // is no route any of these could guard. 17 and 18a grant them beside their own kind
      // permission, which is the first moment either half means anything.
      "orders.read.restricted",
      "partners.agreement.manage",
      "partners.attribution.issue",
      "partners.counterparty.manage",
      "partners.ledger.read",
      "partners.pnl.read",
      "partners.receivable.operate",
      "partners.statement.import",
      // `patients.confidential.write` and `patients.deceased.write` were here for ONE DAY. 22c-A
      // put them here because the phase that removed the power from `patients.update` must not hand
      // it straight back; the owner ruled the next day and both went to `mrd_officer`. What stays
      // is `confidential.read`, and the distinction is worth keeping in view: this list now holds
      // the question "who may SEE a confidential record", which nobody has answered, and no longer
      // the question "who may MAKE one", which somebody has.
      "patients.confidential.read",
      // `staff.reports.drill` LEFT this list on 2026-08-29, one day after it joined it: the owner
      // named who may open patient rows from a colleague's shift, and it is `staff_auditor` — a
      // role of its own, held by one person. It is the shortest stay any entry has had, and it is
      // what this list is FOR: a permission parked here with a reason, until somebody rules.
      // `patients.merge` LEFT on 2026-08-26 — not because a ruling arrived (it had one) but
      // because `seed:patients` finally registered `patient_merge`, so the grant means something.
      // The four `workflow.definitions.*` strings left this list on 2026-08-23 — see
      // WORKFLOW_RULING_PAIRS. The four instance strings below stay, and their reason is now
      // "no live path traverses that controller" rather than "no ruling exists yet".
      "workflow.instances.read",
      "workflow.instances.remediate",
      "workflow.instances.start",
      "workflow.instances.transition",
    ]);
  });
});

describe("seed:roles — README parity, cell for cell (V3)", () => {
  it("V3: the four tables and the model agree over the table-derived subset, both directions", () => {
    const fromReadme = [
      ...tablePairs(opdTable), ...tablePairs(billingTable), ...tablePairs(materialsTable),
      ...tablePairs(otTable), ...tablePairs(labTable), ...tablePairs(radiologyTable),
      ...tablePairs(pharmacyTable),
    ].sort();
    const fromModel = modelPairs().filter((pair) => !NON_TABLE_PAIRS.includes(pair));
    // 46 until Plan 14 T2 added the twenty ticks of the materials table; 66 until Plan 15 T2 added
    // the thirty-two of the OT table.
    // 98 until Plan 17 T2 added the twenty-six ticks of the lab table.
    // 124 until Plan 18a T2 added the radiology table's ticks.
    // 126 since RC-1 T2 — the flow lock's two ticks in the OPD table.
    // 128 since VD-1 T4 — `opd.vitals.history.read`'s two ticks. NOT an RC-2 delta: this counts
    // README TABLE pairs, and `membership.instrument.enrol` is in no table. Corrected here only
    // because a50e68a moved the `opdTable` pins and not this base derived from them.
    // 129 since 17-E T1 — `lab.instruments.manage`'s single tick, the pathologist's alone.
    // 130 since 17-E T2 — `lab.instruments.read`'s single tick, the bridge's alone.
    // 131 since 17-E T3 — `lab.results.interface`, the bridge's second and last.
    expect(fromReadme).toHaveLength(131 + tablePairs(radiologyTable).length + tablePairs(pharmacyTable).length);
    // Direction 1: nothing the README ticks is missing from the model.
    expect(fromReadme.filter((p) => !fromModel.includes(p))).toEqual([]);
    // Direction 2: nothing the model grants from a table is missing from that table.
    expect(fromModel.filter((p) => !fromReadme.includes(p))).toEqual([]);
    expect(fromModel).toEqual(fromReadme);
  });

  it("V3: the rulings' seventy-four pairs are exactly the model's non-table rows, with every README prose line quoted", () => {
    const fromReadme = new Set([
      ...tablePairs(opdTable), ...tablePairs(billingTable), ...tablePairs(materialsTable),
      ...tablePairs(otTable), ...tablePairs(labTable), ...tablePairs(radiologyTable),
      ...tablePairs(pharmacyTable),
    ]);
    const nonTable = modelPairs().filter((pair) => !fromReadme.has(pair));
    // This is the leg that stops the subset scoping above becoming a hole: a model row that is
    // neither table-derived nor one of the three rulings' twenty-five pairs fails HERE.
    expect(nonTable).toEqual([...NON_TABLE_PAIRS].sort());
    // STILL 55 after Plan 14, and that is the assertion rather than an oversight: materials' twenty
    // grants are TABLE-derived (DD11 ruled the third table in), so a phase that added eleven
    // permissions and two roles added NOTHING to this list. A materials pair appearing here would
    // mean the README table and the model had drifted.
    // 55 → 58 after Plan 15: THIRTY-TWO of the OT's thirty-five grants are TABLE-derived (DD14 ruled
    // the fourth table in) and exactly three are not — `medical_superintendent`'s two definition
    // strings and `billing_manager`'s `ot.bill.compose`, held by roles that pre-date the module and
    // have no column in it. An `ot_incharge` or `surgeon` pair appearing here would mean the README
    // table and the model had drifted.
    // 58 → 60 after Plan 07c T9: the two `staff.reports.read` grants. There is no fifth table
    // (see `STAFF_REPORT_PAIRS`) — one granted string across two pre-existing roles is a sentence,
    // not a grid, and the sentence is owner ruling O-2.
    // 60 -> 61 after Plan 07d T5: `doctor/tariff.read` (DD6). A tariff string held by an OPD role
    // belongs to neither README table by construction.
    // 61 -> 70 after the 2026-08-29 owner rulings: `staff_auditor`'s two and the seven that let a
    // `billing_manager` cover a locked-out counter (07b O-1).
    // 70 -> 72 with the LAST ruling of that same day, taken on the deployed system: the two
    // privacy-write strings 22c-A shipped unheld, now `mrd_officer`'s.
    // 72 -> 106 with Plan 17 T2's thirty-four: the kernel's three `orders.*` strings granted for
    // the first time, the lab strings held by four roles that pre-date the module, and
    // `lab_reception`'s counter grants. See `LAB_PAIRS` for why each group is not a table row.
    // 106 -> 119 with Plan 18a T2's thirteen: the four new roles' kernel `orders.*` and the
    // receptionist's counter set, plus this phase's own strings held by `doctor` and
    // `billing_manager`, which are not columns in the radiology table. See `RADIOLOGY_PAIRS`.
    expect(NON_TABLE_PAIRS).toHaveLength(132); // 17c owner ruling: +1 (lab_reception/approvals.requests.create); 16c T1: +10, PHARMACY_PAIRS
    expect(nonTable.filter((p) => p.includes("/materials."))).toEqual([]);
    // AMENDED BY PLAN 17 T2 — the guard was written as "no pair whose ROLE is an OT role", and that
    // stopped being the right claim the moment `surgeon` and `ot_incharge` gained lab strings for
    // the pre-op panel. What it is actually for is OT-TABLE drift: an `ot.*` grant to a role with a
    // column in that table must be table-derived, or the README and the model have parted company.
    // Narrowing it to the PERMISSION keeps exactly that check and stops it failing on a grant from
    // another module — which is the difference between a guard and a tripwire nobody may cross.
    const otTableRoles = new Set(otTable.roles);
    expect(nonTable.filter((p) => {
      const [role, permission] = p.split("/");
      return permission?.startsWith("ot.") === true && otTableRoles.has(role ?? "");
    })).toEqual([]);
    // Plan 15 / DD14's own source sentence, held to exactly the standard of the nine below.
    expect(readme).toContain(OT_README_PROSE);
    expect(readme).toContain(PHARMACY_README_PROSE);
    // Plan 07c / DD14's own source sentence, held to exactly the standard of the nine below.
    expect(readme).toContain(STAFF_REPORT_README_PROSE);
    // Plan 07d / DD6's own source sentence, held to exactly the standard of the ten below.
    expect(readme).toContain(DOCTOR_TARIFF_README_PROSE);
    // The two 2026-08-29 owner rulings, held to exactly the standard of the eleven below.
    expect(readme).toContain(STAFF_AUDITOR_README_PROSE);
    expect(readme).toContain(COUNTER_COVER_README_PROSE);
    // Plan 13 / DD14's own source sentence, held to exactly the standard of the eight below.
    expect(readme).toContain(RESOURCES_README_PROSE);
    // Plan 16a / DD10's own source sentence, held to exactly the standard of the seven below.
    expect(readme).toContain(FORMULARY_README_PROSE);
    // Group B's own source sentence, held to the same standard as the six below.
    expect(readme).toContain(GROUP_B_README_PROSE);
    // The merge lane's own source sentence, held to the same standard as the five below.
    expect(readme).toContain(MERGE_LANE_README_PROSE);
    // The Group A ruling's own source sentence, held to the same standard as the four below.
    expect(readme).toContain(GROUP_A_README_PROSE);
    // The Group C ruling's own source sentence, held to the same standard as the three below.
    expect(readme).toContain(GROUP_C_README_PROSE);
    // The workflow ruling's own source sentence, held to the same standard as ruling 7's below.
    expect(readme).toContain(WORKFLOW_RULING_README_PROSE);
    // The reason those eight exist, located in the shipped README rather than paraphrased. The
    // ruling transcribes a stated intent; if the sentence goes, the transcription is unsourced.
    expect(readme).toContain(RULING_7_README_PROSE);
    // PLAN 09 / DD18, held to exactly the same standard as the two above: the grants are
    // authorised by a sentence in the shipped README, quoted here rather than paraphrased.
    expect(readme).toContain(PLAN_09_README_PROSE);
    // RC-2 T4's enrol/apply split, its OWN sentence rather than an edit to Plan 09's — that one
    // counts Plan 09's strings and is still true.
    expect(readme).toContain(RC2_ENROL_README_PROSE);
    // The 2026-09-02 owner ruling's own sentence (Plan 17c §7), held to the same standard.
    expect(readme).toContain(LAB_RELEASE_REQUEST_README_PROSE);
    // `vitals_desk` deliberately does NOT get `patients.register`: registration is the desk's
    // work and vitals record against a patient who already exists.
    expect(nonTable).not.toContain("vitals_desk/patients.register");
    // …and it does NOT get the membership three either, for the mirror-image reason: recognition
    // happens where the invoice is issued. DD18 mints as little authority as it can, and this is
    // the assertion that says so rather than leaving it to the reader to notice an absence.
    expect(nonTable.filter((p) => p.startsWith("vitals_desk/"))).toEqual([
      "vitals_desk/patients.read",
      "vitals_desk/patients.update",
    ]);
    // The ONE role that may approve a grace-honor is the one that approves every other billing
    // exception, and no role that can REQUEST one can also approve it.
    expect(nonTable.filter((p) => p.endsWith("/membership.grace_honor.approve"))).toEqual([
      "billing_manager/membership.grace_honor.approve",
    ]);
    expect(nonTable).not.toContain("billing_manager/membership.grace_honor.request");
  });
});

describe("seed:roles — executed against a database (V5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterAll(async () => {
    await teardown();
  });

  it("V5: is idempotent — the second run creates nothing, grants nothing, and still reports the census", async () => {
    const first = await seedRoles(db);
    // PLAN 17 T2 / DD16 — 25 -> 29 with the lab's four.
    // PLAN 18a T2 — 29 -> 33 with radiology's three and the PCPNDT in-charge.
    expect(first.roles.map((r) => r.created)).toEqual(Array(37).fill(true)); // 18b T1: 34; 16c T1: 35; 18c T1: 36; 17-E T2: 37 (lab_bridge)
    // The last two are the governance roles the 2026-08-23 ruling added: `owner` 3, `medical_
    // superintendent` 2. `opd_admin` went 4 -> 6 with the two definition-drafting strings. Plan
    // 09 / DD18 then moved four: front_office 9 -> 12, its supervisor 10 -> 13, cashier 8 -> 11,
    // billing_manager 9 -> 10.
    // Group C then moved two more: `medical_superintendent` 2 -> 4 (the two review desks) and a
    // new twelfth entry, `duty_manager`, holding exactly one.
    // Plan 16a / DD10 moved two: `doctor` 9 -> 10 (formulary.read) and `pharmacy` 2 -> 5 (the whole
    // formulary — the module is curated at the dispensing counter and nowhere else).
    // Plan 13 / DD14 moved ONE: `opd_admin` 6 -> 7 (resources.read). It is the fifth entry, and it
    // is the only number in this array a registry phase can move — the registry declares one
    // permission and grants it to the one role that already administers the same rooms.
    // PLAN 14 T2 — eighteen entries now. `pharmacy` (position 7) moved 5 → 8 and the two stores
    // roles append 11 and 6; the array is `ROLE_MODEL` order, so a role inserted rather than
    // appended would fail here rather than silently shifting the comparison.
    // PLAN 15 T2 / DD14 — TWENTY-FOUR entries. `billing_manager` (position 9) moved 10 → 11 with
    // `ot.bill.compose` and `medical_superintendent` (position 11) 7 → 9 with the two definition
    // strings; the six OT roles append 11, 4, 4, 4, 3, 6. The two in-place moves are the ones worth
    // reading: DD14 named a `billing_counter` role that does not exist, so position 9 moving is the
    // visible half of that correction (finding T2-d).
    // PLAN 07c T9 — the SECOND and ELEVENTH entries move (front_office_supervisor 13 → 14,
    // medical_superintendent 9 → 10), both by `staff.reports.read`.
    // OWNER RULINGS 2026-08-29 — two entries move and one is INSERTED, in ROLE_MODEL order:
    // `billing_manager` 11 -> 18 (the counter cover, 07b O-1) and a new `staff_auditor` at 2,
    // registered directly after `duty_manager`.
    // PLAN 17 T2 / DD16 — the list is in ROLE_MODEL order: `doctor` 11 -> 17 (position 4),
    // `billing_manager` 18 -> 19 (position 9), `ot_incharge` 11 -> 15 and `surgeon` 4 -> 9
    // (positions 20 and 21), and the lab's four APPENDED at 16 / 8 / 4 / 16.
    // PLAN 18a T2 — in ROLE_MODEL order: `doctor` 17 -> 19 (position 4) and `billing_manager`
    // 19 -> 20 (position 9), and radiology's four APPENDED at 14 / 8 / 13 / 4. The two in-place
    // moves are the visible half of this phase granting existing roles new authority rather than
    // inventing a role for every new string.
    // RC-1 T2 — the SECOND and FIFTH entries move (front_office_supervisor 14 -> 15, opd_admin
    // 7 -> 8), both by the flow lock. No role is inserted or appended.
    // VD-1 T4 — the THIRD and FOURTH (vitals_desk 5 -> 6, doctor 19 -> 20) by `opd.vitals.history.read`.
    // RC-2 T4 — the SECOND again (15 -> 16) and the FIFTEENTH (membership_admin 2 -> 3) by the
    // enrol split. INDEX 14, not 12: `staff_auditor` also holds two grants, and the first `2` in
    // this array is not the one that moves. A bare-integer census gives you no name to check.
    expect(first.roles.map((r) => r.granted.length)).toEqual([12, 16, 6, 20, 8, 1, 19, 11, 20, 10, 10, 1, 2, 3, 3, 5, 1, 11, 6, 15, 9, 4, 4, 3, 6, 17, 8, 4, 17, 15, 10, 13, 4, 3, 1, 2, 5]); // 17c owner ruling: lab_reception 16 -> 17; 18b T1: radiographer 9, modality_bridge 1; 16c T1: pharmacy 8 -> 19, pharmacy_assistant 5; 18c T1: radiologist 14 -> 15, radiographer 9 -> 10, and radiation_safety_officer's 3 inserted after pcpndt_incharge; 17-E T1: INDEX 25, pathologist 16 -> 17 (lab.instruments.manage) — located by the diff's surrounding context, since the other 16 in this array is lab_reception's and a bare-integer census gives no name to check
    expect(first.roles.every((r) => r.already.length === 0)).toBe(true);
    expect(first.declared).toBe(160); // RC-1 T2's flow lock, VD-1 T4's history read, RC-2 T4's enrol, 18b T1's mwl read, 16c T1's four pharmacy.* strings, 18c T1's three aerb.* strings, 17-E T1's lab.instruments.manage, 17-E T2's lab.instruments.read
    // MEASURED from role_permissions, not derived from the model. On this database only seed:roles
    // has run, so what is held is exactly what the model granted — 57, not the 63 the model CLAIMS
    // once seed:admin and seed:ops have also run. That SEVEN-permission gap IS MAJOR 1 (it was ten
    // until Group C moved three `auth.*` strings into the model), and before the 2026-08-23 fix
    // this line read the model's claim against a database holding the grants.
    // 84 -> 85: `staff.reports.drill` is the one string these rulings add to the MODEL.
    // 87 -> 105: the lab's fifteen plus the kernel's three `orders.*`, all granted in the commit
    // that declares them.
    expect(first.held).toBe(140); // 17c owner ruling: 133 -> 134 (approvals.requests.create); RC-1 T2 — 125 -> 126, flow lock; VD-1 T4 -> 127; RC-2 T4 -> 128; 18b T1 -> 129; 16c T1 -> 133; 17-E T1 -> 138; T2 -> 139
    expect(first.held).toBe(modelPermissions().length);
    expect(heldPermissions()).toHaveLength(146); // 17c owner ruling; RC-1 T2, VD-1 T4, RC-2 T4's enrol, 18b T1's mwl read, 16c T1's four pharmacy.* strings, then 18c T1's three aerb.* strings
    // PLAN 17 PHASE 0 T5 — 16 -> 20. All four `orders.*` strings, unheld on purpose (§8.11).
    // PLAN 17 T2 — 18 -> 15: three of those four are granted here and `orders.read.restricted`
    // stays, which is the one that needed an owner rather than a plan.
    expect(first.notYetModelled).toBe(14); // 17c owner ruling: approvals.requests.create is held now
    expect(first.expectedElsewhereAbsent).toBe(6);
    // And the census RECONCILES against the catalog, which is the property that makes it evidence:
    // 83 held + 14 unmodelled + 6 expected-elsewhere = 103 declared (Plan 15 T2 moved the first by
    // fourteen and the other two by nothing at all — every string it declares, it grants). Before
    // it: 69 + 14 + 6 = 89 (Plan 14 T2 moved the first
    // and the last by eleven and zero). Plan 13 moved the first and the
    // last of those three by one each and left the middle two alone, which is what a phase whose
    // one new permission is granted in the same commit looks like from here.
    expect(first.held + first.notYetModelled + first.expectedElsewhereAbsent).toBe(first.declared);

    // `createRole` is a BARE INSERT and is not idempotent; the guard around it is what makes this
    // run exit rather than die on a duplicate key.
    const second = await seedRoles(db);
    // PLAN 17 T2 / DD16 — 25 -> 29 with the lab's four.
    expect(second.roles.map((r) => r.created)).toEqual(Array(37).fill(false));
    expect(second.roles.every((r) => r.granted.length === 0)).toBe(true);
    // PLAN 07c T9 — the same two entries as the first run's `granted` census above.
    // The FIRST run's `granted` census, read back — see the note there for Plan 17 T2's changes.
    // RC-1 T2 — the second run's `already` mirrors the first run's `granted`: 15 and 8.
    expect(second.roles.map((r) => r.already.length)).toEqual([12, 16, 6, 20, 8, 1, 19, 11, 20, 10, 10, 1, 2, 3, 3, 5, 1, 11, 6, 15, 9, 4, 4, 3, 6, 17, 8, 4, 17, 15, 10, 13, 4, 3, 1, 2, 5]); // 17c owner ruling: lab_reception 16 -> 17; 18b T1: radiographer 9, modality_bridge 1; 16c T1: pharmacy 19, pharmacy_assistant 5; 17-E T1: INDEX 25, pathologist 16 -> 17
    // The SAME bare-integer array as the granted-length pin above, duplicated for the idempotence
    // leg — so every permission moves it TWICE. Nothing names it and no grep finds it.

    // And the database holds the model exactly once.
    const written = await db
      .select({ roleKey: rolePermissions.roleKey, permission: rolePermissions.permission })
      .from(rolePermissions);
    expect(written.map((r) => `${r.roleKey}/${r.permission}`).sort()).toEqual(modelPairs());
  });

  it("MAJOR 1: the census is READ BACK OUT OF THE DATABASE, so granting a permission moves it", async () => {
    const first = await seedRoles(db);

    // The model CLAIMS seven permissions it does not itself grant — FOUR of seed:admin's seven
    // `auth.*` and seed:ops's three `ops.*`. It was ten until Group C (2026-08-26) put
    // `auth.break_glass.review`, `auth.elevation.review` and `auth.temp_role.grant` into the model
    // itself; the four that remain are the account-and-authority strings no model role may hold,
    // plus `auth.break_glass.use`, which is ungranted for a WIRING reason `seed-roles.ts` states.
    // Neither script has run here, so none of the seven is held.
    const claimedElsewhere = heldPermissions().filter((p) => !modelPermissions().includes(p));
    expect(claimedElsewhere).toHaveLength(6);
    const measured = await heldInDatabase(db);
    expect(claimedElsewhere.filter((p) => measured.includes(p))).toEqual([]);
    expect(first.expectedElsewhereAbsent).toBe(6);

    // NOT READY, and the problem NAMES THE REPAIR rather than merely counting.
    //
    // PLAN 11e CLOSE (M4) — THIS ASSERTION MOVED, AND WHY IT HAD TO. It used to pin the substring
    // "RETURNS EARLY", because the guidance told the operator that re-running `seed:admin` could
    // NOT help. 11e T5 deleted that early return and made re-running it the repair, so the old
    // wording became emitted text steering a person away from the fix — caught by the phase's
    // independent reviewer. What is pinned now is the same property one layer up: the message must
    // name the script AND tell the operator what to do about it, because a census that reports a
    // gap without naming its repair is the defect this whole check exists to close.
    expect(first.ready).toBe(false);
    const problem = first.problems.find((t) => t.includes("EXPECTS another seed"));
    expect(problem).toBeDefined();
    expect(problem).toContain("seed:admin");
    expect(problem).toContain("RE-RUNNING seed:admin IS the repair");
    // …and it must NOT resurrect the claim T5 falsified.
    expect(problem).not.toContain("RETURNS EARLY");
    for (const permission of claimedElsewhere) expect(problem).toContain(permission);

    // NOW GRANT ONE OF THEM, the way the missing seed would have. Nothing about the constants at
    // the top of seed-roles.ts changes — only the database does.
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    const [moved] = claimedElsewhere;
    // `admin` is seed:admin's role and does not exist here — creating it is exactly what the
    // missing seed would have done before granting.
    await createRole(db, "admin", "Administrator");
    await grantPermissionToRole(db, registry, "admin", moved!);

    const second = await seedRoles(db);
    // The census MOVED. Under the old model-derived computation both runs returned 46 and this
    // assertion could not have distinguished them — which is precisely why the defect survived.
    expect(second.held).toBe(first.held + 1);
    expect(second.expectedElsewhereAbsent).toBe(5);
    expect(await heldInDatabase(db)).toContain(moved);
    expect(second.held + second.notYetModelled + second.expectedElsewhereAbsent).toBe(second.declared);
  });

  it("reports zero holders per role, because seed:roles mints authority and assigns nobody", async () => {
    const report = await seedRoles(db);
    expect(report.roles.every((r) => r.holders === 0)).toBe(true);
    // A role with no holder is REPORTED rather than silently absent — grants without holders are
    // still 403 for every user on the deployment, and the verdict line has to say so.
    expect(report.ready).toBe(false);
    expect(report.problems.join(" ")).toContain("NO USER HOLDS ANY OF THE 37 ROLES"); // 17-E T2: lab_bridge
  });

  /**
   * PLAN 11f T2 / D2 — THE CENSUS SEES THE TAKEOVER RULE'S MITIGATION UNMET.
   *
   * ROUTINE tier: tests required, mutants NOT required and fail-first NOT owed. The count is
   * `fullAdministrators`' — the takeover rule's own helper — and these legs assert the two
   * transitions an operator lives through: nobody, then the bootstrap admin alone, then two.
   */
  it("11f D2 — the census names the full-administrator shortfall and goes quiet at two", async () => {
    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);

    const none = await seedRoles(db);
    expect(none.fullAdministrators).toEqual([]);
    expect(none.warnings.join(" ")).toContain("0 user(s) hold the FULL auth.* set");
    expect(none.warnings.join(" ")).toContain("takeover rule");
    expect(formatReport(none).join("\n")).toContain("full administrators");
    // IT IS A WARNING AND NOT A PROBLEM (reviewer M1). The shortfall must never reach `problems`,
    // because `problems` feeds `ready` and `ready` feeds the exit code — and D2 marked CODE
    // ENFORCEMENT of the two-admin rule dead. The warning still prints, as loudly.
    expect(none.problems.join(" ")).not.toContain("auth.* set");
    expect(formatReport(none).join("\n")).toContain("ACT ON THIS");

    // One — the bootstrap state, and the state production is in. Named, so the operator knows
    // WHICH account has no repair.
    await createRole(db, "full_admin", "Full administrator");
    for (const permission of authManifest.permissions) {
      await grantPermissionToRole(db, registry, "full_admin", permission);
    }
    const { id: firstId } = await createUser(db, {
      username: "admin", fullName: "The Administrator", password: "bootstrap-secret",
    });
    await assignRole(db, { userId: firstId, roleKey: "full_admin", scopeType: "hospital" });

    const one = await seedRoles(db);
    expect(one.fullAdministrators).toEqual(["admin"]);
    expect(one.warnings.join(" ")).toContain("1 user(s) hold the FULL auth.* set at hospital scope: admin");

    // Two — runbook O1 performed. The line goes quiet, which is what "the detector goes quiet"
    // means and is the half that stops this row passing by warning about everything.
    const { id: secondId } = await createUser(db, {
      username: "second_admin", fullName: "The Second", password: "bootstrap-secret",
    });
    await assignRole(db, { userId: secondId, roleKey: "full_admin", scopeType: "hospital" });

    const two = await seedRoles(db);
    expect(two.fullAdministrators).toEqual(["admin", "second_admin"]);
    expect(two.warnings).toEqual([]);
    expect(formatReport(two).join("\n")).toContain("full administrators (whole auth.* set, hospital scope, active): 2");
    expect(formatReport(two).join("\n")).not.toContain("ACT ON THIS");
  });

  it("11f M1 — the two-admin shortfall never moves the READY verdict, at one admin or none", async () => {
    // The property the reviewer's M1 is about, asserted directly rather than inferred from where
    // the string lands: `seed:roles` exits on `ready`, and a deployment with one administrator is
    // a state D2 calls expected. Whatever `ready` is, it must be the SAME with and without the
    // shortfall — so it is compared against a verdict computed from `problems` alone.
    const none = await seedRoles(db);
    expect(none.warnings).toHaveLength(1);
    expect(none.ready).toBe(none.problems.length === 0);

    const registry = new ModuleRegistry();
    for (const manifest of ALL_MANIFESTS) registry.install(manifest);
    await createRole(db, "full_admin", "Full administrator");
    for (const permission of authManifest.permissions) {
      await grantPermissionToRole(db, registry, "full_admin", permission);
    }
    const { id } = await createUser(db, { username: "admin", fullName: "A", password: "bootstrap-secret" });
    await assignRole(db, { userId: id, roleKey: "full_admin", scopeType: "hospital" });

    const one = await seedRoles(db);
    expect(one.warnings).toHaveLength(1);
    expect(one.ready).toBe(one.problems.length === 0);
  });
});
