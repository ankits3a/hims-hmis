import type { Actor } from "@hmis/contracts";
import { eq } from "drizzle-orm";
import { patients, registrationConfig, roles } from "../../src/kernel/db/schema";
import { createUser } from "../../src/kernel/auth/identity";
import { assignRole } from "../../src/kernel/auth/permissions";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { approveDefinition, createDraft, activateDefinition } from "../../src/kernel/workflow/definitions";
import { withTx } from "../../src/kernel/db/client";
import {
  activateVersion, createDraftVersion, createService, setTariffItem, submitVersion, upsertGstCategory,
} from "../../src/modules/tariff";
import { registerPatient } from "../../src/modules/patients";
import { buildQrPayload } from "../../src/modules/patients/qr";
import { registerOtApprovalTypes } from "../../src/modules/ot/approval-types";
import { registerOtEncounterResolver } from "../../src/modules/ot/ot.module";
import { registerOpdEncounterResolver } from "../../src/modules/opd/opd.module";
import { registerItem } from "../../src/modules/materials";
import {
  OT_WORKFLOW_DEFINITIONS, draftDefinition, publishDefinition, requestDefinitionPublish,
} from "../../src/modules/ot";
import { ensureOtUnit } from "../../scripts/seed-ot";
import { seedBillingBase, testCfg } from "./billing";
import type { Db } from "../../src/kernel/db/client";

/**
 * PLAN 15 — the fixture every OT suite starts from.
 *
 * **THIS FILE IS NOT IN T3's FILES LIST** and it is created rather than inlined for the reason
 * `test/helpers/billing.ts` and `test/helpers/opd.ts` exist: five suites in this phase need one
 * theatre, two bays, an activated tariff carrying a day-care package, two ACTIVE workflow
 * definitions and four PUBLISHED OT definitions, and five private copies of that graph is §2.54's
 * mechanism in a test directory. Recorded as finding T3-a rather than smuggled.
 *
 * Every row is built through the OWNING module's public API — `createService`, `ensureOtUnit`,
 * `publishDefinition` — never a hand-rolled insert into another module's table (spec §4, and
 * `seedBillingBase`'s own rule). That matters more here than usual: a fixture that inserted an
 * `ot_definitions` row with `status: 'active'` directly would bypass the approvals engine, which is
 * precisely the property half these tests are about.
 */

const PACKAGE_PRICE_PAISE = 6_000_000; // ₹60,000 — a day-care package
const IMPLANT_TARIFF_PAISE = 5_000_000; // ₹50,000 — A24's tariff leg

/** The two package services and the implant service every OT suite prices against. */
export const OT_PACKAGE_CODES = {
  gynaeDnc: "DC-GYN-DNC",
  orthoImplantRemoval: "DC-ORT-IMPREM",
  orthoDistalRadius: "DC-ORT-RADIUS",
} as const;
export const OT_IMPLANT_SERVICE_CODE = "IMPL-PLATE-SET";

export type OtBaseFixture = {
  implantItemId: string;
  theatreId: string;
  bayIds: string[];
  consignmentStoreId: string;
  tariffVersionId: string;
  packageServiceIds: Record<keyof typeof OT_PACKAGE_CODES, string>;
  implantServiceId: string;
  owner: Actor;
  ms: Actor;
  drafter: Actor;
  activator: Actor;
  incharge: Actor;
  coordinator: Actor;
  surgeon: Actor;
  anaesthetist: Actor;
  otNurse: Actor;
  recoveryNurse: Actor;
};

async function ensureRole(db: Db, key: string): Promise<void> {
  await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
}

export async function mkOtUser(db: Db, username: string, roleKeys: string[]): Promise<Actor> {
  const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
  for (const key of roleKeys) {
    await ensureRole(db, key);
    await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
  }
  return { type: "user", id };
}

/** §3A's defaults, as `seed-ot` will draft them. */
export const DEPOSIT_POLICY_BODY = {
  rules: {
    self_pay: { kind: "percent_of_quote", percentBps: 10000, includeImplantEstimate: true },
    insured_tpa: { kind: "quote_minus_sanctioned", coPayFloorBps: 2000 },
    govt_scheme: { kind: "zero" },
    fp_scheme: { kind: "zero" },
    corporate_credit: { kind: "excess_over_credit" },
    membership_prepaid: { kind: "quote_minus_entitlement" },
    staff_dependant: { kind: "percent_of_quote", percentBps: 5000, includeImplantEstimate: false },
    charity: { kind: "zero" },
  },
};

/**
 * THE WHITELIST FIXTURE, and its shape is chosen against §2.102's coinciding-field rule.
 *
 * Three classes, deliberately DIFFERENT from each other in the fields the assertions turn on:
 *   · `gynae_dnc` — NOT lateral, NOT trauma, NPO required, escort required. A4's discriminating
 *     case: it must get NEITHER `site_marking` NOR `mlc`.
 *   · `ortho_distal_radius_fixation` — LATERAL and TRAUMA, so it gets both; and `implantExpected`.
 *   · `ortho_ganglion_excision` — LATERAL, `npoRequired: FALSE` (H9/N1/F25: a local-anaesthesia-only
 *     class gets no NPO gate at all rather than a waived one).
 *
 * A fixture whose three classes all required the same gates would make A4 pass against a mutant
 * that created every kind for every case.
 */
export const CRITERIA_BODY = {
  entries: [
    {
      procedureClass: "gynae_dnc", department: "gynaecology", packageServiceCode: OT_PACKAGE_CODES.gynaeDnc,
      lateral: false, traumaClass: false, implantExpected: false, cArm: false,
      npoRequired: true, escortRequired: true,
      requiredGates: ["anaesthesia_review", "consent_procedure", "consent_anaesthesia", "npo", "deposit", "escort", "privilege"],
      waivableGates: [],
      asaMax: 2, ageMin: 12, ageMax: 70, bmiMax: 35, lateCutoff: "20:00",
    },
    {
      procedureClass: "ortho_distal_radius_fixation", department: "orthopaedics",
      packageServiceCode: OT_PACKAGE_CODES.orthoDistalRadius,
      lateral: true, traumaClass: true, implantExpected: true, cArm: true,
      npoRequired: true, escortRequired: true,
      requiredGates: [
        "anaesthesia_review", "consent_procedure", "consent_anaesthesia", "site_marking", "npo",
        "deposit", "escort", "privilege", "mlc",
      ],
      waivableGates: [],
      asaMax: 3, ageMin: 5, ageMax: 75, bmiMax: 40, lateCutoff: "20:00",
    },
    {
      procedureClass: "ortho_ganglion_excision", department: "orthopaedics",
      packageServiceCode: OT_PACKAGE_CODES.orthoImplantRemoval,
      lateral: true, traumaClass: false, implantExpected: false, cArm: false,
      npoRequired: false, escortRequired: true,
      requiredGates: ["consent_procedure", "site_marking", "deposit", "escort", "privilege"],
      // `site_marking` is waivable here and NOT on the radius class — DD5's example, and the leg
      // that stops `waivableGates` being read as "waivable everywhere".
      waivableGates: ["site_marking"],
      asaMax: 3, ageMin: 12, ageMax: 80, bmiMax: 40, lateCutoff: "20:00",
    },
  ],
};

/** F24b — one scale per technique. GA's PADSS and spinal's longer set differ in `threshold`. */
export const PACU_BODY = {
  scales: [
    {
      anaesthesiaType: "general", scale: "padss",
      items: [
        { key: "vitals", max: 2 }, { key: "ambulation", max: 2 }, { key: "nausea", max: 2 },
        { key: "pain", max: 2 }, { key: "bleeding", max: 2 },
      ],
      threshold: 9, minScores: 2, minGapMinutes: 30,
    },
    {
      anaesthesiaType: "spinal", scale: "padss_spinal",
      items: [
        { key: "vitals", max: 2 }, { key: "ambulation", max: 2 }, { key: "nausea", max: 2 },
        { key: "pain", max: 2 }, { key: "bleeding", max: 2 }, { key: "voiding", max: 2 },
        { key: "motor_block", max: 2 },
      ],
      threshold: 12, minScores: 2, minGapMinutes: 30,
    },
    {
      anaesthesiaType: "local_sedation", scale: "padss_light",
      items: [{ key: "vitals", max: 2 }, { key: "nausea", max: 2 }, { key: "pain", max: 2 }],
      threshold: 5, minScores: 2, minGapMinutes: 30,
    },
    {
      anaesthesiaType: "regional", scale: "padss",
      items: [
        { key: "vitals", max: 2 }, { key: "ambulation", max: 2 }, { key: "nausea", max: 2 },
        { key: "pain", max: 2 }, { key: "bleeding", max: 2 },
      ],
      threshold: 9, minScores: 2, minGapMinutes: 30,
    },
  ],
};

/**
 * Publishes one OT definition through the REAL flow — draft, request, approve as the MS, publish.
 * Exported so a test that needs a SECOND version (A2's draft-vs-active leg) can drive the same path.
 */
export async function publishOtDefinition(
  db: Db,
  args: { kind: "criteria" | "privileges" | "deposit_policy" | "pacu_thresholds"; body: unknown; drafter: Actor; ms: Actor },
): Promise<{ definitionId: string; version: number }> {
  const drafted = await withTx(db, async (tx) => {
    const d = await draftDefinition(tx, args.drafter, { kind: args.kind, body: args.body });
    const { approvalId } = await requestDefinitionPublish(tx, args.drafter, d.definitionId);
    return { ...d, approvalId };
  });
  await approveRequest(db, args.ms, { approvalId: drafted.approvalId, note: `publish ${args.kind}` });
  await publishDefinition(db, args.ms, { definitionId: drafted.definitionId, approvalId: drafted.approvalId });
  return { definitionId: drafted.definitionId, version: drafted.version };
}

/**
 * The whole day-care unit, ready to book against: billing's base, the OT unit's four registry rows,
 * both workflow definitions ACTIVE, the four OT definitions PUBLISHED, and one user per role.
 */
export async function seedOtBase(db: Db, opts: { privilegedClasses?: string[] } = {}): Promise<OtBaseFixture> {
  // `registerPatient` allocates a UHID and refuses without this row — `seedOpdBase`'s line, and it
  // belongs here because an OT suite registers patients without going near OPD.
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  const base = await seedBillingBase(db);

  const ms = await mkOtUser(db, "ot_ms", ["medical_superintendent"]);
  const incharge = await mkOtUser(db, "ot_incharge_1", ["ot_incharge"]);
  const coordinator = await mkOtUser(db, "ot_coord_1", ["daycare_coordinator"]);
  const surgeon = await mkOtUser(db, "ot_surgeon_1", ["surgeon"]);
  const anaesthetist = await mkOtUser(db, "ot_anaes_1", ["anaesthetist"]);
  const otNurse = await mkOtUser(db, "ot_nurse_1", ["ot_nurse"]);
  const recoveryNurse = await mkOtUser(db, "ot_recovery_1", ["recovery_nurse"]);

  await registerOtApprovalTypes(db, base.activator);

  /**
   * Both Class-A workflow definitions, activated exactly the way the go-live runbook does it —
   * and the sequence is the point rather than the setup.
   *
   * `CHANGE_CLASS_POLICY.A` requires an approval from `owner` AND one from
   * `medical_superintendent`, from two DISTINCT approver ids (`approveDefinition` refuses a repeat),
   * and then an activator who is not the drafter (`assertNotSodPair("workflow_drafter_activator")`).
   * Four roles across three people, and Spike Q3 measured that production has the two governance
   * humans this needs. A fixture that activated these by inserting a row would prove nothing about
   * whether the runbook is performable.
   */
  for (const def of OT_WORKFLOW_DEFINITIONS) {
    const draft = await createDraft(db, base.drafter, def);
    await approveDefinition(db, base.owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
    await approveDefinition(db, ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
    await activateDefinition(db, base.activator, draft.definitionId);
  }

  const unit = await ensureOtUnit(db, base.activator);

  // The tariff services this phase prices against, on a NEW version copied from the base's.
  const packageServiceIds = {} as Record<keyof typeof OT_PACKAGE_CODES, string>;
  for (const [key, code] of Object.entries(OT_PACKAGE_CODES) as [keyof typeof OT_PACKAGE_CODES, string][]) {
    const svc = await withTx(db, (tx) =>
      createService(tx, base.drafter, { code, name: `Day-care package ${code}`, category: "daycare_package" }));
    packageServiceIds[key] = svc.serviceId;
  }
  const implant = await withTx(db, (tx) =>
    createService(tx, base.drafter, { code: OT_IMPLANT_SERVICE_CODE, name: "Implant — plate/screw set", category: "daycare_implant" }));

  await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
    category: "daycare_package", sacCode: "999312", exempt: true, rateBps: 1800, specialRule: null, thresholdPaise: null,
  }));
  await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
    category: "daycare_implant", sacCode: "9021", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
  }));

  const draft = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
    for (const id of Object.values(packageServiceIds)) await setTariffItem(tx, base.drafter, d.versionId, id, PACKAGE_PRICE_PAISE);
    await setTariffItem(tx, base.drafter, d.versionId, implant.serviceId, IMPLANT_TARIFF_PAISE);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, draft.versionId));
  await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "ot fixture tariff" });
  await activateVersion(db, base.activator, draft.versionId, new Date("2026-01-02T00:00:00Z"));

  await publishOtDefinition(db, { kind: "criteria", body: CRITERIA_BODY, drafter: base.drafter, ms });
  await publishOtDefinition(db, {
    kind: "privileges",
    body: {
      surgeons: [{
        surgeonId: surgeon.id,
        procedureClasses: opts.privilegedClasses ?? CRITERIA_BODY.entries.map((e) => e.procedureClass),
      }],
    },
    drafter: base.drafter, ms,
  });
  await publishOtDefinition(db, { kind: "deposit_policy", body: DEPOSIT_POLICY_BODY, drafter: base.drafter, ms });
  await publishOtDefinition(db, { kind: "pacu_thresholds", body: PACU_BODY, drafter: base.drafter, ms });

  /**
   * PLAN 15 T7 — BOTH encounter resolvers, registered without booting Nest.
   *
   * `issueInvoice` dispatches on the episode-number letter; in production `OpdModule` and `OtModule`
   * register their own on init. A unit suite that needs billing to resolve a `D` number would
   * otherwise have to stand up a module graph, so each module exports its registration and this
   * calls both. The registry is KEYED, so calling it once per test is a replace rather than a leak.
   */
  registerOpdEncounterResolver();
  registerOtEncounterResolver();

  /**
   * The implant ITEM, through materials' own API. `stock_batches.item_id` is a real FK, so a bill
   * suite that invents an item id gets a constraint error rather than a fixture. `implant` class,
   * so DD3's exactly-iff CHECK wants no formulary medicine.
   */
  const implantItem = await withTx(db, (tx) => registerItem(tx, base.drafter, {
    code: "IMPL-PLATE-SET-ITEM", name: "Implant — plate/screw set", class: "implant",
    baseUom: "each", batchTracked: true, serialTracked: true,
    /**
     * A `box` of TWO, beyond the base unit — §2.102's rule applied to the fixture, and it is the
     * seventh coinciding field Plan 14's close named. An implant whose `mrpUom` IS its base unit
     * makes every per-base conversion a no-op, which is exactly what hid a factor-of-five error
     * there. A25 needs this row to exist or `mrpPerBaseUnit` cannot convert at all.
     */
    uoms: [{ uom: "box", toBaseMultiplier: 2, isPurchaseUom: true }],
  }));

  return {
    implantItemId: implantItem.itemId,
    theatreId: unit.theatreId, bayIds: unit.bayIds, consignmentStoreId: unit.consignmentStoreId,
    tariffVersionId: draft.versionId, packageServiceIds, implantServiceId: implant.serviceId,
    owner: base.owner, ms, drafter: base.drafter, activator: base.activator,
    incharge, coordinator, surgeon, anaesthetist, otNurse, recoveryNurse,
  };
}

/** A patient, through the registration module's own API. */
let phoneSeq = 900000000;
export async function mkOtPatient(
  db: Db, actor: Actor, name: string,
  opts: { dob?: Date; sex?: "male" | "female" | "other" | "unknown"; phone?: string; isConfidential?: boolean; alias?: string; guardian?: Parameters<typeof registerPatient>[2]["guardian"] } = {},
): Promise<string> {
  phoneSeq += 1;
  const { patient } = await withTx(db, (tx) => registerPatient(tx, actor, {
    name, sex: opts.sex ?? "female",
    dob: opts.dob ?? new Date(Date.UTC(1990, 0, 1)),
    // A DETERMINISTIC phone, never a random one: A21's escort leg turns on `escort.phone ===
    // patient.phone`, and a fixture that collided by chance once in ten thousand runs is §2.99's
    // flake wearing a phone number.
    phone: opts.phone ?? `9${String(phoneSeq)}`,
    isConfidential: opts.isConfidential,
    alias: opts.alias,
    guardian: opts.guardian,
  }));
  return patient.id;
}

/** The `AppConfig` the QR verifier needs. `testCfg`'s shape, re-exported so an OT suite need not
 *  reach into `helpers/billing` for a config it uses for a different reason. */
export function testOtConfig(): typeof testCfg {
  return testCfg;
}

/** A patient's QR card payload — the string a wristband scanner produces (A1's fixture). */
export async function otPatientCard(db: Db, patientId: string): Promise<string> {
  const rows = await db.select({ id: patients.id, uhid: patients.uhid, qrVersion: patients.qrVersion })
    .from(patients).where(eq(patients.id, patientId));
  return buildQrPayload(testCfg, rows[0]!);
}
