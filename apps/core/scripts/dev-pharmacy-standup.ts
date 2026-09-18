import { and, desc, eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { approveRequest } from "../src/kernel/approvals/decisions";
import {
  events, opdDepartments, opdDoctors, opdEncounters, patients, roleAssignments, users,
} from "../src/kernel/db/schema";
import { activateDefinition, approveDefinition, createDraft, getActiveDefinition } from "../src/kernel/workflow/definitions";
import { addMedicine, medicineIdsByBrandNames, saltIdsByNames } from "../src/modules/formulary";
import {
  availableQty, captureGrn, findStoreByCode, listGrns, listItems, listVendors, postGrn, registerItem, runGateQc,
  sellableBatchesByItem,
} from "../src/modules/materials";
import { addAllergy, registerPatient } from "../src/modules/patients";
import {
  claimDispense, currentRegistration, getSaleItem, handlePrescriptionIssued, listQueue, prefillQtyBase, registerSaleItem,
} from "../src/modules/pharmacy";
import { activateVersion, createDraftVersion, listServices, resolveActiveTariffVersion, setTariffItem, submitVersion } from "../src/modules/tariff";
/**
 * The OPD day's write paths are not on `opd/index.ts` — no other MODULE calls them, the counter's
 * controllers do. A script is not a module, so it reaches in exactly as `test/helpers/pharmacy.ts`
 * and `seed-lab-demo.ts:10` do; the boundary lint scopes itself to `src/modules/**` for this reason.
 */
import { completeConsultation, startConsultation } from "../src/modules/opd/consultation";
import { openVisit } from "../src/modules/opd/encounters";
import { prescriptionIssued } from "../src/modules/opd/events";
import { createDoctor } from "../src/modules/opd/masters";
import { issuePrescription } from "../src/modules/opd/prescriptions";
import { recordVitals } from "../src/modules/opd/vitals";
import { OPD_VISIT_DEFINITION_JSON, OPD_VISIT_DEF_KEY } from "../src/modules/opd/workflow-def";
import { assertSyntheticDataAllowed } from "./synthetic-door";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../src/kernel/config";
import type { Db, Tx } from "../src/kernel/db/client";
import type { RxLine } from "../src/modules/opd/prescriptions";

/**
 * ═══ THE PHARMACY'S DAY, AS AN EXECUTABLE — FOR A DEV DATABASE AND NOTHING ELSE (phase PD, PD-0) ═══
 *
 * `seed:pharmacy-demo` builds the SHELF and ends by saying so: *"The SHELF is ready; the QUEUE is
 * not."* This is the QUEUE — synthetic patients, seen by a doctor, carrying prescriptions that sit
 * at the counter as tickets. Nothing in phase PD can be seen, demonstrated or browser-walked
 * without it.
 *
 * It is a `dev-*-standup` and not a `seed:*`, because a pharmacy's day needs two ceremonies that on
 * every real environment belong to humans: the `opd_visit` workflow definition (Class A, three
 * people) and an ACTIVATED tariff version (the owner's prices). `dev-radiology-standup.ts` performs
 * both the same way and is the model; this one prices only `OPD-CONSULT*`, because a dispensed line
 * is priced at batch grain (`pricing.ts` — `batchUnitPaise` needs no tariff item) and a contracted
 * price on a drug would be a money decision this script has no business making.
 *
 * ═══ EVERY ROW GOES THROUGH THE OWNING MODULE'S REAL WRITE PATH ═══
 *
 * `registerPatient` → `openVisit` → `recordVitals` → `startConsultation` → `issuePrescription` →
 * `completeConsultation`, and then the pharmacy's own consumer. **`rxIssuedConsumer` is registered
 * only in the worker** (`worker.module.ts`), and a `tsx` process boots no worker, so without the
 * last step every prescription here would be issued and no ticket would ever reach the counter.
 * `handlePrescriptionIssued` IS the consumer: it takes the claim row, so the worker, when it next
 * runs, finds the event handled. `enqueueDispense` directly would skip that row and leave every
 * event for the worker to handle a second time — caught today only by `enqueueDispense`'s own
 * one-live-row rule, which is the second of two guards and should not be made the only one.
 *
 * ═══ TEN TICKETS, EACH TEACHING ONE THING ═══
 *
 * Nine from the handoff and a tenth it named as a trap: Schedule X refuses the whole CLAIM
 * (`claim.ts`), so that ticket is deliberately unworkable and the refusal is the demonstration.
 * The allergy ticket's allergy is recorded AFTER the prescription — `issuePrescription` runs the
 * same checks and would refuse it at issue, so a pre-existing allergy never reaches the counter.
 *
 * ═══ WHAT IT DOES NOT DO ═══
 *
 *  · It creates no user and no credential — `seed:staff` owns that, on stdin. It finds every actor
 *    by ROLE and refuses with an instruction when a role has no holder.
 *  · It files no pharmacist's council registration. That is a legal instrument (Pharmacy Act 1948
 *    §42) and is entered at `/pharmacy/pharmacists` by the pharmacist in charge; until it is, EVERY
 *    ticket stops at verify (`requireRegisteredPharmacist`, `verify.ts`), not only the H1 one. The
 *    report names who holds one.
 *  · It pays no consultation fee. No billing gate is registered in a script, so these visits reach
 *    the doctor unpaid — the counter does not read the fee, and a desk walk that does will say so.
 *
 * USAGE (from `apps/core`, after seed:staff and seed:pharmacy-demo):
 *
 *     ALLOW_DEMO_DATA=yes HMIS_SYNTHETIC_DATA_OK=1 \
 *       DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_pharmacy_desk_dev \
 *       pnpm tsx scripts/dev-pharmacy-standup.ts
 */

/**
 * EVERY DOOR, AND NONE REPLACES ANOTHER (`synthetic-door.ts`). This writes synthetic PATIENTS, which
 * a live register can never delete once a prescription references them, so it takes the strongest
 * door in the tree — `seed-lab-demo.ts`'s — plus the `:5434` refusal that no key opens. Pure, and
 * exported, so it is exercised by `synthetic-door.test.ts` and not by hand once.
 *
 * The `NODE_ENV` line is SHADOWED by the door above it — no environment reaches it that the door
 * has not already refused — and is kept, as `seed-lab-demo.ts` keeps it, so that removing the door
 * one day does not also remove the refusal it was added beside.
 */
export function assertPharmacyDayAllowed(
  env: { NODE_ENV?: string | undefined; ALLOW_DEMO_DATA?: string | undefined; HMIS_SYNTHETIC_DATA_OK?: string | undefined },
  url: string,
): void {
  /* `:5434` is `hmis-prod-db-1`. Checked FIRST and conditioned on nothing, so a UAT box pointed at
     production's port by mistake is refused whatever its environment says. */
  if (url.includes(":5434")) {
    throw new Error("dev-pharmacy-standup: REFUSED — port 5434 is production's database.");
  }
  assertSyntheticDataAllowed("dev-pharmacy-standup", env);
  if (env.NODE_ENV === "production" && env.HMIS_SYNTHETIC_DATA_OK !== "1") {
    throw new Error("dev-pharmacy-standup refuses to run with NODE_ENV=production — it creates synthetic patients");
  }
  if (env.ALLOW_DEMO_DATA !== "yes") {
    throw new Error(
      "dev-pharmacy-standup would write SYNTHETIC PATIENTS, visits and prescriptions.\n" +
        "  They are indistinguishable from real ones once a dispense references them.\n" +
        "  If that is a demo or test database, re-run with ALLOW_DEMO_DATA=yes.",
    );
  }
}

/** The eight brands `seed:pharmacy-demo` puts on the shelf. The day refuses to run without them. */
const SHELF_BRANDS = [
  "Crocin 500", "Calpol 500", "Mox 500", "Azee 500", "Alprax 0.5", "Cetzine 10", "Pan 40", "Glycomet 500",
] as const;
const STORE_CODE = "PHARM-OPD";
const VENDOR_CODE = "DEMO-PHARMA-DIST";

/**
 * OUT OF STOCK, HONESTLY: a medicine the hospital stocks and has run out of. On the book, on the item
 * master, sold at the counter — and no GRN has ever brought it. Its salt is already in
 * `seed:pharmacy-demo`'s book with no brand on it.
 */
const OUT_OF_STOCK = {
  brand: "Amlong 5", salt: "amlodipine", strength: "5 mg", form: "tablet", schedule: "H" as const, code: "AMLG005",
};

/**
 * NEAR EXPIRY, HONESTLY: QC rule 5 refuses a short-dated delivery at the bay, so a batch that dies in
 * twelve days can only be on a shelf the way the aged challan's is — accepted long ago, in date then.
 * Its MRP is last year's, a rupee under the fresh batch's, which is the "why is this more than last
 * time" question PD-D19 exists to answer. Re-posted only when no Pan 40 batch is inside the window,
 * keyed by the day, so a re-run the same day finds its own challan.
 */
const NEAR_EXPIRY = { code: "PAN040", strips: 2, mrpPaisePerStrip: 10400, unitCostPaise: 620, receivedMonthsAgo: 12, daysLeft: 12 };
const NEAR_EXPIRY_WINDOW_DAYS = 30;

type Line = { brand: string | null; drug: string; dose: string; frequency: string; durationDays: number; instructions: string | null };
const med = (brand: string, dose: string, frequency: string, durationDays: number, instructions: string | null = null): Line =>
  ({ brand, drug: brand, dose, frequency, durationDays, instructions });
/** A line typed as text that the catalogue cannot match — PD-D4's amber row. */
const typed = (drug: string, dose: string, frequency: string, durationDays: number): Line =>
  ({ brand: null, drug, dose, frequency, durationDays, instructions: null });

type Ticket = {
  teaches: string;
  person: { name: string; sex: "male" | "female"; ageYears: number; phone: string };
  lines: readonly Line[];
  /** Recorded AFTER the prescription — see the header. */
  allergyAfterIssue?: string;
  /** Claimed by a pharmacist who is not the first `pharmacy` holder, so the desk can say who has it. */
  claimedByAnother?: true;
};

/**
 * Phones `9000000101`–`106` are `seed:lab-demo`'s; this file owns `9000000201`–`210`. Idempotent by
 * phone, and by "already seen today" per ticket — so tomorrow the same ten people are a fresh day.
 */
export const TICKETS: readonly Ticket[] = [
  { teaches: "happy path", person: { name: "Ramesh Paswan", sex: "male", ageYears: 38, phone: "9000000201" },
    lines: [med("Mox 500", "1 cap", "1-0-1", 5), med("Cetzine 10", "1 tab", "0-0-1", 5)] },
  { teaches: "substitution available", person: { name: "Priya Kumari", sex: "female", ageYears: 29, phone: "9000000202" },
    lines: [med("Crocin 500", "1 tab", "1-1-1", 5, "after food")] },
  { teaches: "out of stock", person: { name: "Shanti Devi", sex: "female", ageYears: 64, phone: "9000000203" },
    lines: [med(OUT_OF_STOCK.brand, "1 tab", "1-0-0", 30), med("Cetzine 10", "1 tab", "0-0-1", 5)] },
  { teaches: "Schedule H1", person: { name: "Mohammed Salim", sex: "male", ageYears: 47, phone: "9000000204" },
    lines: [med("Azee 500", "1 tab", "1-0-0", 3, "one hour before food"), med("Calpol 500", "1 tab", "1-0-1", 3)] },
  { teaches: "unresolved free-text line", person: { name: "Rekha Singh", sex: "female", ageYears: 33, phone: "9000000205" },
    lines: [typed("Ascoril LS syrup", "10 ml", "1-1-1", 5), med("Cetzine 10", "1 tab", "0-0-1", 5)] },
  { teaches: "allergy collision", person: { name: "Vijay Mahto", sex: "male", ageYears: 52, phone: "9000000206" },
    lines: [med("Mox 500", "1 cap", "1-1-1", 5), med("Calpol 500", "1 tab", "1-0-1", 3)], allergyAfterIssue: "Amoxicillin" },
  { teaches: "partial stock", person: { name: "Geeta Devi", sex: "female", ageYears: 58, phone: "9000000207" },
    lines: [med("Glycomet 500", "1 tab", "1-1-1", 90, "after food")] },
  { teaches: "near-expiry batch", person: { name: "Arun Kumar Jha", sex: "male", ageYears: 45, phone: "9000000208" },
    lines: [med("Pan 40", "1 tab", "1-0-0", 30, "before breakfast")] },
  { teaches: "claimed by a second pharmacist", person: { name: "Neha Prasad", sex: "female", ageYears: 26, phone: "9000000209" },
    lines: [med("Cetzine 10", "1 tab", "0-0-1", 7), med("Crocin 500", "1 tab", "1-0-1", 3)], claimedByAnother: true },
  { teaches: "Schedule X — refused at the claim", person: { name: "Dinesh Ram", sex: "male", ageYears: 41, phone: "9000000210" },
    lines: [med("Alprax 0.5", "1 tab", "0-0-1", 7), med("Calpol 500", "1 tab", "1-0-1", 3)] },
];

const ADULT_VITALS = { heightCm: 165, weightKg: 62, sbp: 124, dbp: 80, pulse: 76, spo2: 98, tempC: 36.9 };

export type TicketReport = {
  teaches: string; name: string; uhid: string; made: boolean;
  dispenseId: string | null; status: string | null;
  /** The holder's full name, as the queue row names it (PD-1). */
  claimedBy: string | null;
  /** What makes this ticket teach what it says, read from the shelf the counter reads. */
  shelf: ShelfFact[];
};
/** One prescribed line against the shelf. `sellable: null` — the catalogue cannot place the line on an item. */
export type ShelfFact = {
  drug: string; wanted: number | null; sellable: number | null;
  fefo: { batchNo: string; expiryDate: string | null } | null;
};
export type PharmacyDayReport = {
  ceremonies: string[];
  shelf: string[];
  tickets: TicketReport[];
  /** Preconditions the day could not meet and did not invent. */
  absent: string[];
  /** Rows on `listQueue` for today, read as the first `pharmacy` holder. */
  queueRows: number;
  queueReader: string | null;
  registeredPharmacists: string[];
};

/** IST, never UTC — `ist-clock-parity.test.ts` exists to catch a hand-rolled offset. */
function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
function shiftMonths(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
const minutes = (n: number): number => n * 60_000;

async function holdersOf(db: Db, roleKey: string): Promise<{ id: string; username: string }[]> {
  return db.select({ id: users.id, username: users.username })
    .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(eq(roleAssignments.roleKey, roleKey))
    .orderBy(users.username);
}

async function holderOf(db: Db, roleKey: string): Promise<Actor & { id: string }> {
  const row = (await holdersOf(db, roleKey))[0];
  if (row === undefined) {
    throw new Error(
      `dev-pharmacy-standup: no user holds "${roleKey}". seed:roles mints authority and assigns nobody —\n` +
        "  provision the roster first (cat roster.json | pnpm seed:staff). This script creates no credentials.",
    );
  }
  return { type: "user", id: row.id };
}

/** The two ceremonies, idempotent, in `dev-radiology-standup.ts`'s shape: three distinct humans. */
export async function standUpCeremonies(db: Db, now: Date = new Date()): Promise<string[]> {
  const log: string[] = [];
  if (await withTx(db, (tx) => getActiveDefinition(tx, OPD_VISIT_DEF_KEY)).catch(() => null)) {
    log.push(`${OPD_VISIT_DEF_KEY}: already active`);
  } else {
    const owner = await holderOf(db, "owner");
    const ms = await holderOf(db, "medical_superintendent");
    /* `workflow_drafter_activator` refuses an activation by the drafter, and `duplicate_approval`
       refuses one PERSON twice — so a drafter who is neither approver. */
    const drafter = await holderOf(db, "opd_admin");
    const { definitionId } = await createDraft(db, drafter, OPD_VISIT_DEFINITION_JSON);
    await approveDefinition(db, owner, { definitionId, roleKey: "owner", note: "dev stand-up — synthetic environment" });
    await approveDefinition(db, ms, { definitionId, roleKey: "medical_superintendent", note: "dev stand-up — synthetic environment" });
    await activateDefinition(db, owner, definitionId);
    log.push(`${OPD_VISIT_DEF_KEY}: drafted, approved by two people, ACTIVATED`);
  }

  if (await resolveActiveTariffVersion(db, now)) {
    log.push("tariff: a version is already active, left alone");
    return log;
  }
  const owner = await holderOf(db, "owner");
  const drafter = await holderOf(db, "opd_admin");
  const consults = (await listServices(db)).filter((s) => s.code.startsWith("OPD-CONSULT"));
  const { versionId, versionNo } = await withTx(db, (tx) => createDraftVersion(tx, drafter, {
    notes: "dev stand-up — consultation fees only, DEV PLACEHOLDER prices; medicines price at batch grain",
  }));
  for (const s of consults) await withTx(db, (tx) => setTariffItem(tx, drafter, versionId, s.id, 50_000));
  const { approvalId } = await withTx(db, (tx) => submitVersion(tx, drafter, versionId, "dev stand-up"));
  await approveRequest(db, owner, { approvalId, note: "dev stand-up — synthetic environment" });
  /* BACKDATED: `resolveActiveTariffVersion` wants `effectiveFrom <= the moment priced`. */
  await activateVersion(db, owner, versionId, new Date("2026-01-01T00:00:00.000Z"));
  log.push(`tariff: version ${String(versionNo)} ACTIVATED, ${String(consults.length)} consultation fees (DEV PLACEHOLDER)`);
  return log;
}

/** The out-of-stock medicine and the near-expiry batch — the two shelf facts the demo shelf lacks. */
async function topUpShelf(db: Db, now: Date, report: PharmacyDayReport): Promise<void> {
  const pharmacist = await holderOf(db, "pharmacy");
  const materialsHead = await holderOf(db, "materials_head");
  const store = await findStoreByCode(db, STORE_CODE);
  if (store === undefined) throw new Error(`dev-pharmacy-standup: no "${STORE_CODE}" store — run seed:pharmacy first`);

  let medicineId = (await medicineIdsByBrandNames(db, [OUT_OF_STOCK.brand])).get(OUT_OF_STOCK.brand.toLowerCase());
  if (medicineId === undefined) {
    const saltId = (await saltIdsByNames(db, [OUT_OF_STOCK.salt])).get(OUT_OF_STOCK.salt);
    if (saltId === undefined) throw new Error(`dev-pharmacy-standup: no "${OUT_OF_STOCK.salt}" salt — run seed:pharmacy-demo first`);
    ({ medicineId } = await withTx(db, (tx: Tx) => addMedicine(tx, pharmacist, {
      brandName: OUT_OF_STOCK.brand, form: OUT_OF_STOCK.form, routeClass: "systemic", strengthLabel: OUT_OF_STOCK.strength,
      scheduleFlag: OUT_OF_STOCK.schedule, salts: [{ saltId, strength: OUT_OF_STOCK.strength }],
    })));
  }
  const itemId = (await listItems(db, { class: "drug" })).find((i) => i.code === OUT_OF_STOCK.code)?.id ??
    (await withTx(db, (tx: Tx) => registerItem(tx, materialsHead, {
      code: OUT_OF_STOCK.code, name: `${OUT_OF_STOCK.brand} ${OUT_OF_STOCK.form}`, class: "drug", baseUom: "tablet",
      batchTracked: true, formularyMedicineId: medicineId, hsnCode: "3004",
      /* NULL, as every demo item is — `seed-pharmacy-demo.ts` says why at length. */
      gstRateBps: null, shelfLifeDays: 1095,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }))).itemId;
  if ((await getSaleItem(db, itemId)) === undefined) await withTx(db, (tx: Tx) => registerSaleItem(tx, pharmacist, itemId));
  report.shelf.push(`${OUT_OF_STOCK.brand}: on the book and the item master, ${String(await availableQty(db, store.id, itemId, now))} sellable — out of stock`);

  const pan = (await listItems(db, { class: "drug" })).find((i) => i.code === NEAR_EXPIRY.code);
  if (pan === undefined) throw new Error(`dev-pharmacy-standup: no ${NEAR_EXPIRY.code} item — run seed:pharmacy-demo first`);
  const horizon = istDay(new Date(now.getTime() + NEAR_EXPIRY_WINDOW_DAYS * 86_400_000));
  const inWindow = ((await sellableBatchesByItem(db, store.id, [pan.id], now)).get(pan.id) ?? [])
    .filter((b) => b.expiryDate !== null && b.expiryDate <= horizon);
  if (inWindow.length === 0) {
    const vendor = (await listVendors(db, { search: VENDOR_CODE })).find((v) => v.code === VENDOR_CODE);
    if (vendor === undefined) throw new Error(`dev-pharmacy-standup: no ${VENDOR_CODE} vendor — run seed:pharmacy-demo first`);
    const challanNo = `DEMO/NEAR/${istDay(now).replace(/-/g, "")}`;
    const already = (await listGrns(db, { vendorId: vendor.id, storeResourceId: store.id })).some((g) => g.challanNo === challanNo);
    if (!already) {
      const challanAt = shiftMonths(now, -NEAR_EXPIRY.receivedMonthsAgo);
      const expiryDate = istDay(new Date(now.getTime() + NEAR_EXPIRY.daysLeft * 86_400_000));
      await withTx(db, async (tx: Tx) => {
        const { grnId } = await captureGrn(tx, materialsHead, {
          vendorId: vendor.id, source: "challan", storeResourceId: store.id, challanNo, challanDate: istDay(challanAt),
          lines: [{
            itemId: pan.id, uom: "strip", qtyInUom: NEAR_EXPIRY.strips, batchNo: `${NEAR_EXPIRY.code}-${challanNo.replace(/[^0-9]/g, "")}`,
            expiryDate, mrpPaise: NEAR_EXPIRY.mrpPaisePerStrip, mrpUom: "strip", unitCostPaise: NEAR_EXPIRY.unitCostPaise,
          }],
          now: challanAt, serviceDate: istDay(challanAt),
        });
        const qc = await runGateQc(tx, materialsHead, grnId);
        const failed = qc.verdicts.filter((v) => v.verdict !== "pass");
        if (failed.length > 0) throw new Error(`near-expiry GRN ${challanNo}: QC ${failed.map((v) => v.rule ?? v.verdict).join(", ")} — nothing posted`);
        await postGrn(tx, materialsHead, grnId, challanAt);
      });
    }
  }
  const panBatches = (await sellableBatchesByItem(db, store.id, [pan.id], now)).get(pan.id) ?? [];
  report.shelf.push(`Pan 40: ${panBatches.map((b) => `${b.batchNo} ×${String(b.available)} exp ${b.expiryDate ?? "—"}`).join(" · ")}`);
}

/** A doctor who can prescribe: an existing profile (General Medicine first), or one made for a `doctor` holder. */
async function prescriber(db: Db, log: string[]): Promise<{ doctorId: string; departmentId: string; actor: Actor }> {
  const rows = await db.select({ doctorId: opdDoctors.id, userId: opdDoctors.userId, departmentId: opdDoctors.departmentId, dept: opdDepartments.code })
    .from(opdDoctors).innerJoin(opdDepartments, eq(opdDepartments.id, opdDoctors.departmentId))
    .innerJoin(roleAssignments, and(eq(roleAssignments.userId, opdDoctors.userId), eq(roleAssignments.roleKey, "doctor")))
    .where(and(eq(opdDoctors.active, true), eq(opdDepartments.active, true)));
  const found = rows.find((r) => r.dept === "MED") ?? rows[0];
  if (found !== undefined) {
    log.push(`doctor of record: an existing ${found.dept} profile`);
    return { doctorId: found.doctorId, departmentId: found.departmentId, actor: { type: "user", id: found.userId } };
  }

  const [med] = await db.select().from(opdDepartments).where(eq(opdDepartments.code, "MED"));
  if (med === undefined) throw new Error("dev-pharmacy-standup: no MED department — run seed:opd first");
  const holder = (await holdersOf(db, "doctor"))[0];
  if (holder === undefined) throw new Error("dev-pharmacy-standup: no user holds \"doctor\" — provision the roster first");
  const admin = await holderOf(db, "opd_admin");
  const { doctorId } = await withTx(db, (tx) => createDoctor(tx, admin, {
    username: holder.username, displayName: `Dr ${holder.username}`, departmentId: med.id, specialty: "General Medicine",
  }));
  log.push(`doctor of record: MED profile CREATED for ${holder.username} (opd_admin, createDoctor)`);
  return { doctorId, departmentId: med.id, actor: { type: "user", id: holder.id } };
}

export async function standUpPharmacyDay(db: Db, cfg: AppConfig, now: Date = new Date()): Promise<PharmacyDayReport> {
  const report: PharmacyDayReport = {
    ceremonies: [], shelf: [], tickets: [], absent: [], queueRows: 0, queueReader: null, registeredPharmacists: [],
  };
  const today = istDay(now);

  const brands = await medicineIdsByBrandNames(db, [...SHELF_BRANDS]);
  const missing = SHELF_BRANDS.filter((b) => !brands.has(b.toLowerCase()));
  if (missing.length > 0) throw new Error(`dev-pharmacy-standup: the shelf is not there (${missing.join(", ")}) — run seed:pharmacy-demo first`);

  report.ceremonies = await standUpCeremonies(db, now);
  await topUpShelf(db, now, report);
  const medicineIds = await medicineIdsByBrandNames(db, [...SHELF_BRANDS, OUT_OF_STOCK.brand]);
  const store = (await findStoreByCode(db, STORE_CODE))!;
  const drugItems = await listItems(db, { class: "drug", active: true });
  const itemByMedicine = new Map(drugItems.filter((i) => i.formularyMedicineId !== null).map((i) => [i.formularyMedicineId as string, i]));

  const frontDesk = await holderOf(db, "front_office");
  const doctor = await prescriber(db, report.ceremonies);
  const pharmacists = await holdersOf(db, "pharmacy");
  const second = pharmacists[1];
  if (second === undefined) {
    report.absent.push("a SECOND `pharmacy` holder — the claimed-by-another ticket is left queued, and nobody \"has\" it");
  }

  /* Three minutes apart and finished five minutes ago, so the queue reads as a morning rather than
     one instant — unless that would cross IST midnight, when the day is all `now`. */
  const spread = istDay(new Date(now.getTime() - minutes(TICKETS.length * 3 + 2))) === today;
  for (const [i, ticket] of TICKETS.entries()) {
    const at = spread ? new Date(now.getTime() - minutes((TICKETS.length - i) * 3 + 2)) : now;
    const step = (n: number): Date => new Date(at.getTime() + n * 30_000);

    let patient = (await db.select({ id: patients.id, uhid: patients.uhid }).from(patients).where(eq(patients.phone, ticket.person.phone)))[0];
    patient ??= (await withTx(db, (tx: Tx) => registerPatient(tx, frontDesk, {
      ...ticket.person, district: "Vaishali", stateName: "Bihar",
    }))).patient;
    const row: TicketReport = {
      teaches: ticket.teaches, name: ticket.person.name, uhid: patient.uhid, made: false,
      dispenseId: null, status: null, claimedBy: null, shelf: [],
    };
    report.tickets.push(row);

    const seenToday = await db.select({ id: opdEncounters.id }).from(opdEncounters)
      .where(and(eq(opdEncounters.patientId, patient.id), eq(opdEncounters.serviceDate, today)));
    if (seenToday.length > 0) continue;

    const lines: RxLine[] = ticket.lines.map((l) => ({
      drug: l.drug, medicineId: l.brand === null ? null : (medicineIds.get(l.brand.toLowerCase()) ?? null),
      dose: l.dose, route: "oral", frequency: l.frequency, durationDays: l.durationDays, instructions: l.instructions,
      noSubstitution: false,
    }));
    const opened = await openVisit(db, frontDesk, { patientId: patient.id, departmentId: doctor.departmentId, doctorId: doctor.doctorId }, at);
    const encounterId = opened.encounter.id;
    await recordVitals(db, doctor.actor, encounterId, ADULT_VITALS, step(1));
    await startConsultation(db, doctor.actor, encounterId, step(2));
    const issued = await issuePrescription(db, doctor.actor, cfg, encounterId, { lines }, step(3));
    await completeConsultation(db, doctor.actor, encounterId, { testsOrderedReturnToday: false }, step(4));
    if (ticket.allergyAfterIssue !== undefined) {
      await withTx(db, (tx: Tx) => addAllergy(tx, doctor.actor, patient.id, {
        substance: ticket.allergyAfterIssue!, reaction: "urticarial rash", severity: "moderate", source: "consult",
      }));
    }

    /* THE CONSUMER, called as the worker would call it — see the header. */
    const [event] = await db.select({ eventId: events.eventId, payload: events.payload }).from(events)
      .where(and(eq(events.name, prescriptionIssued.name), eq(events.encounterId, encounterId)))
      .orderBy(desc(events.seq)).limit(1);
    if (event === undefined || (event.payload as { prescriptionId?: string }).prescriptionId !== issued.prescriptionId) {
      throw new Error(`dev-pharmacy-standup: no prescription.issued event for ${issued.prescriptionId}`);
    }
    const { dispenseId } = await withTx(db, (tx: Tx) => handlePrescriptionIssued(tx, event.eventId, event.payload, step(4)));
    if (dispenseId === null) throw new Error(`dev-pharmacy-standup: the consumer queued nothing for ${issued.prescriptionId}`);
    row.made = true;
    row.dispenseId = dispenseId;

    if (ticket.claimedByAnother === true && second !== undefined) {
      await claimDispense(db, { type: "user", id: second.id }, { dispenseId, door: "token" }, step(5));
    }
  }

  /* THE REPORT READS WHAT THE COUNTER WILL READ — `listQueue` as the first pharmacist, and the shelf
     through `availableQty`/`sellableBatchesByItem`, the predicates `fefoPick` picks from. */
  const reader = pharmacists[0];
  const queue = reader === undefined ? [] : await listQueue(db, { type: "user", id: reader.id }, { serviceDate: today });
  report.queueRows = queue.length;
  report.queueReader = reader?.username ?? null;
  const statusByPatient = new Map(queue.map((q) => [q.patient.uhid, q]));
  for (const [i, ticket] of TICKETS.entries()) {
    const row = report.tickets[i]!;
    const q = statusByPatient.get(row.uhid);
    row.status = q?.status ?? null;
    row.dispenseId ??= q?.dispenseId ?? null;
    row.claimedBy = q?.claimedByName ?? null;
    for (const l of ticket.lines) {
      const want = prefillQtyBase({ dose: l.dose, frequency: l.frequency, durationDays: l.durationDays });
      const medicineId = l.brand === null ? undefined : medicineIds.get(l.brand.toLowerCase());
      const item = medicineId === undefined ? undefined : itemByMedicine.get(medicineId);
      if (item === undefined) { row.shelf.push({ drug: l.drug, wanted: want, sellable: null, fefo: null }); continue; }
      const batches = (await sellableBatchesByItem(db, store.id, [item.id], now)).get(item.id) ?? [];
      const first = batches[0];
      row.shelf.push({
        drug: l.drug, wanted: want, sellable: batches.reduce((n, b) => n + b.available, 0),
        fefo: first === undefined ? null : { batchNo: first.batchNo, expiryDate: first.expiryDate },
      });
    }
  }

  /* Every verify needs a current council registration, which this script never files. */
  const registered: string[] = [];
  for (const p of pharmacists) if ((await currentRegistration(db, p.id, today)) !== null) registered.push(p.username);
  report.registeredPharmacists = registered;
  if (registered.length === 0) {
    report.absent.push(
      "no `pharmacy` holder has a current council registration — every ticket stops at verify until the " +
        "pharmacist in charge records one at /pharmacy/pharmacists (a legal instrument; not filed here)",
    );
  }
  return report;
}

async function main(): Promise<void> {
  const url = requireEnv("DATABASE_URL");
  assertPharmacyDayAllowed(process.env, url);
  const dbName = new URL(url).pathname.replace(/^\//, "");
  process.stdout.write(`dev-pharmacy-standup -> a synthetic pharmacy day on "${dbName}"\n`);
  const { db, pool } = createDb(url);
  try {
    const report = await standUpPharmacyDay(db, loadConfig());
    for (const line of [...report.ceremonies, ...report.shelf]) process.stdout.write(`  ${line}\n`);
    process.stdout.write(`\n  today's queue, as ${report.queueReader ?? "nobody"} reads it: ${String(report.queueRows)} rows\n`);
    for (const t of report.tickets) {
      process.stdout.write(
        `  ${t.made ? "made   " : "already"} ${t.uhid.padEnd(14)} ${t.name.padEnd(16)} ${(t.status ?? "absent").padEnd(9)} ` +
          `${t.teaches}${t.claimedBy === null ? "" : ` — ${t.claimedBy} has it`}\n`,
      );
      for (const f of t.shelf) {
        const shelf = f.sellable === null ? "no item — the catalogue cannot place it"
          : `${String(f.wanted ?? "?")} wanted, ${String(f.sellable)} sellable` +
            (f.fefo === null ? "" : `, FEFO ${f.fefo.batchNo} exp ${f.fefo.expiryDate ?? "—"}`);
        process.stdout.write(`            ${f.drug}: ${shelf}\n`);
      }
    }
    for (const a of report.absent) process.stdout.write(`\n  ABSENT, NOT INVENTED: ${a}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
