import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { roleAssignments, users } from "../src/kernel/db/schema";
import { addMedicine, addSalt, listMedicines, listSalts } from "../src/modules/formulary";
import {
  activateVendor, addVendorDocument, availableQty, balances, captureGrn, findStoreByCode, listGrns,
  listItems, listVendors, postGrn, registerItem, registerVendor, runGateQc,
} from "../src/modules/materials";
import { getSaleItem, registerSaleItem } from "../src/modules/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core seed:pharmacy-demo` — SYNTHETIC CATALOGUE AND STOCK, so the OPD dispense
 * counter opens onto a shelf instead of an empty one. **Plan 16c, after the 2026-09-06 stand-up.**
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The pharmacy module is DEPLOYED and INERT. `seed:pharmacy` establishes the `PHARM-OPD` store and
 * the `pharmacy_dispense` definition, and stops — correctly, because everything after that is
 * hospital-specific master data. So `standup:check pharmacy` reads:
 *
 *     pharmacy_store_present      ok
 *     pharmacy_definition_active  ok
 *     pharmacy_role_held          ok
 *     pharmacy_item_present       RED      <- this seed
 *     pharmacy_batch_in_stock     RED      <- this seed
 *
 * Registering a real catalogue is a chief pharmacist's week. This is a DEMO shelf: eight medicines
 * an Indian OPD actually dispenses, their items, their sale registrations, one drug-licensed vendor
 * and two GRNs. It is what a rehearsal needs and it is not what a hospital opens on.
 *
 * ═══ IT IS NOT IN `deploy.sh`, AND THAT IS THE POINT ═══
 *
 * Every `seed:*` step in the deploy is idempotent infrastructure every environment needs. This one
 * invents a VENDOR with a drug licence number — `seed-materials.ts` refuses to do that in as many
 * words, because placeholder commercial data in a live item master is indistinguishable from the
 * real thing and has a legal instrument attached to it. So it is an operator command, it is absent
 * from `SEED_STEP_SCRIPTS`, and it refuses to run without being asked twice.
 *
 * ═══ IT MINTS NO CREDENTIALS ═══
 *
 * It creates no user and takes no password. It LOOKS UP whoever already holds `pharmacy` (the
 * formulary and the sale registrations) and `materials_head` (the items, the vendor and the GRN),
 * and refuses with an instruction if the hospital has not made them. `/admin/users` is a screen that
 * ships. Two roles, because §2 of the go-live runbook is TWO PEOPLE and a seed that pretended
 * otherwise would teach the wrong thing.
 *
 * ═══ EVERY ROW GOES THROUGH THE OWNING MODULE'S REAL WRITE PATH ═══
 *
 * `addSalt` → `addMedicine` → `registerItem` → `registerSaleItem`, and stock ONLY through
 * `registerVendor` → `addVendorDocument` → `activateVendor` → `captureGrn` → `runGateQc` → `postGrn`.
 *
 * **`test/helpers/pharmacy.ts`'s `stockIn` is NOT the model.** It hand-INSERTs a `stock_batches` row
 * and posts one movement — two statements, correct for a unit test, and it produces a batch with no
 * vendor, no GRN line and no QC verdict. A demo box seeded that way would show stock that no
 * document explains, and the first person to ask "where did this come from?" would find nothing.
 * Its FIXTURE VALUES are worth borrowing (tablet base, strip × 10, ₹120 a strip); its shape is not.
 *
 * ═══ THE GST SLAB IS DELIBERATELY LEFT NULL ═══
 *
 * `gstRateBps: null` on every item, which `gstCategoryFor` maps to `pharmacy_exempt`, which
 * `seed-tariff` seeds `exempt: true` — so the counter bills exactly the printed MRP. That is the
 * correct amount to the patient and it is what `pharmacy-go-live.md` §2.2 now instructs a human to
 * do, pending the owner's ruling: `pricing.ts:103` computes `net = base + cgst + sgst`, GST ADDED ON
 * TOP, while the base for a pharmacy line is the printed MRP — which is tax-inclusive by statute. A
 * seed that set a real slab would bake a demo that charges above MRP, and teach it to everyone who
 * rehearsed on it. **When the ruling lands, this is one line.**
 *
 * ═══ WHAT IT DOES NOT DO — the day, as opposed to the shelf ═══
 *
 * It seeds NO patient, encounter or prescription, so the counter's QUEUE is still empty after it
 * runs. That half needs two things this lane does not own and no production seed provides: the
 * `opd_visit` workflow definition is Class A and is activated only by a TEST helper, and billing
 * needs an ACTIVATED tariff version, which `seed-tariff` deliberately never creates and whose
 * approval needs a real `owner` role-holder. Both are commissioning gaps in other modules; putting
 * a private copy of either in here would be inventing a production path in a demo script. Run the
 * runbook's §3 drill by hand against this shelf, and see `docs/runbooks/pharmacy-go-live.md` §1.7.
 */

/** The demo book. Eight medicines an Indian OPD dispenses, and every one earns its place. */
const SALTS = [
  { name: "paracetamol", drugClass: "analgesic" },
  { name: "amoxicillin", drugClass: "penicillin" },
  { name: "azithromycin", drugClass: "macrolide" },
  { name: "alprazolam", drugClass: "benzodiazepine" },
  { name: "cetirizine", drugClass: "antihistamine" },
  { name: "pantoprazole", drugClass: "ppi" },
  { name: "metformin", drugClass: "biguanide" },
  { name: "amlodipine", drugClass: "calcium_channel_blocker" },
] as const;

type DemoMedicine = {
  brand: string; salt: string; strength: string; form: string;
  schedule: "OTC" | "H" | "H1" | "X";
  /** The item's code; its sale service becomes `RX-<code>`. */
  code: string;
  /** Paise per STRIP. Must divide by the strip multiplier — see `uom.ts:145`. */
  mrpPaisePerStrip: number;
  /** Paise per BASE UNIT (per tablet). QC rule 6 rejects an MRP below this. */
  unitCostPaise: number;
};

/**
 * TWO PARACETAMOL BRANDS ON ONE SALT IS NOT PADDING — it is the only way the drill's generic
 * substitution step has anything to substitute. `alternativesFor` matches on salts + strength +
 * form + route, so a book with one brand per molecule offers the pharmacist an empty dropdown.
 *
 * ALPRAX IS STOCKED AND MUST NOT BE DISPENSABLE. Schedule X is refused at all three counter gates
 * (16c R-3), and a demo that omits X would let a rehearsal conclude the guard does not exist. It is
 * on the shelf so the refusal can be SEEN.
 */
const MEDICINES: readonly DemoMedicine[] = [
  { brand: "Crocin 500", salt: "paracetamol", strength: "500 mg", form: "tablet", schedule: "OTC", code: "CROC500", mrpPaisePerStrip: 12000, unitCostPaise: 700 },
  { brand: "Calpol 500", salt: "paracetamol", strength: "500 mg", form: "tablet", schedule: "OTC", code: "CALP500", mrpPaisePerStrip: 9000, unitCostPaise: 550 },
  { brand: "Mox 500", salt: "amoxicillin", strength: "500 mg", form: "capsule", schedule: "H", code: "MOX500", mrpPaisePerStrip: 8500, unitCostPaise: 500 },
  { brand: "Azee 500", salt: "azithromycin", strength: "500 mg", form: "tablet", schedule: "H1", code: "AZEE500", mrpPaisePerStrip: 15000, unitCostPaise: 900 },
  { brand: "Alprax 0.5", salt: "alprazolam", strength: "0.5 mg", form: "tablet", schedule: "X", code: "ALPX050", mrpPaisePerStrip: 4500, unitCostPaise: 250 },
  { brand: "Cetzine 10", salt: "cetirizine", strength: "10 mg", form: "tablet", schedule: "OTC", code: "CETZ010", mrpPaisePerStrip: 3500, unitCostPaise: 180 },
  { brand: "Pan 40", salt: "pantoprazole", strength: "40 mg", form: "tablet", schedule: "H", code: "PAN040", mrpPaisePerStrip: 11000, unitCostPaise: 620 },
  { brand: "Glycomet 500", salt: "metformin", strength: "500 mg", form: "tablet", schedule: "H", code: "GLYC500", mrpPaisePerStrip: 6000, unitCostPaise: 340 },
] as const;

const STRIP_MULTIPLIER = 10;
const SHELF_LIFE_DAYS = 1095;
const VENDOR_CODE = "DEMO-PHARMA-DIST";
const STORE_CODE = "PHARM-OPD";

/**
 * THE TWO GRNs, AND WHY THERE ARE TWO.
 *
 * QC rule 5 REJECTS a near-expiry line: `nearExpiryMinDays = min(183, floor(shelfLife * 0.75))`, so
 * with a three-year shelf life the expiry must be ≥183 days after the CHALLAN date. That is correct
 * — a hospital does not accept short-dated goods at the bay — and it means **expired stock cannot be
 * received today.** The only honest way to have expired stock on a demo shelf is the way a real
 * pharmacy gets it: a delivery accepted long ago that has since gone out of date.
 *
 * So the second GRN is BACKDATED. Its lines were comfortably in date when they arrived and are not
 * now, which is exactly the shelf the runbook's §3.5 expiry proof needs, and exactly what
 * `sellableBatchRows` must refuse to offer.
 */
const FRESH_CHALLAN = { no: "DEMO/2026/001", monthsAgo: 1, expiryMonthsAhead: 24 };
const AGED_CHALLAN = { no: "DEMO/2024/007", monthsAgo: 20, expiryMonthsAhead: -2 };

export type PharmacyDemoReport = {
  saltsCreated: number; saltsExisting: number;
  medicinesCreated: number; medicinesExisting: number;
  itemsCreated: number; itemsExisting: number;
  saleItemsRegistered: number; saleItemsExisting: number;
  vendorCreated: boolean; grnsPosted: number; grnsSkipped: number;
  batchesOnShelf: number; sellableUnits: number; expiredUnitsOnShelf: number;
};

/** IST, never UTC — `ist-clock-parity.test.ts` pins the census of offset sites and a hand-rolled
 * `5.5 * 60 * 60 * 1000` is what it exists to catch. `en-CA` because it formats as YYYY-MM-DD. */
function istDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

function shiftMonths(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * The `seed-lab-demo.ts:104` pattern, and the refusal is the useful half. `seed:roles` mints
 * permissions and assigns NOBODY, by design, so on a fresh box this is what tells the operator which
 * screen to open — rather than a foreign-key error three hundred lines later.
 */
async function actorHolding(db: Db, roleKey: string): Promise<Actor & { id: string }> {
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .where(eq(roleAssignments.roleKey, roleKey))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `no user holds the "${roleKey}" role.\n` +
        `  seed:roles mints the permissions and assigns nobody — that separation is deliberate.\n` +
        `  Sign in as an administrator, open /admin/users, create a user and grant it "${roleKey}",\n` +
        "  then run this again. See docs/runbooks/pharmacy-go-live.md §1.",
    );
  }
  return { type: "user", id: row.id };
}

export function assertDemoDataAllowed(
  env: { NODE_ENV?: string | undefined; ALLOW_DEMO_DATA?: string | undefined; HMIS_SYNTHETIC_DATA_OK?: string | undefined },
  dbName: string,
): void {
  if (env.NODE_ENV === "production") {
    throw new Error("seed:pharmacy-demo refuses to run with NODE_ENV=production.");
  }
  if (env.ALLOW_DEMO_DATA !== "yes") {
    throw new Error(
      `seed:pharmacy-demo would write a SYNTHETIC VENDOR carrying a drug-licence number, and\n` +
        `  synthetic stock, to the database "${dbName}".\n` +
        "  A placeholder vendor in a live item master is indistinguishable from a real supplier and\n" +
        "  has a legal instrument attached to it.\n" +
        "  If that is a demo or test database, re-run with ALLOW_DEMO_DATA=yes.",
    );
  }
}

async function ensureSalts(db: Db, actor: Actor, report: PharmacyDemoReport): Promise<Map<string, string>> {
  const byName = new Map((await listSalts(db)).map((s) => [s.name.toLowerCase(), s.id]));
  for (const salt of SALTS) {
    if (byName.has(salt.name)) { report.saltsExisting += 1; continue; }
    const { saltId } = await withTx(db, (tx: Tx) => addSalt(tx, actor, { name: salt.name, drugClass: salt.drugClass }));
    byName.set(salt.name, saltId);
    report.saltsCreated += 1;
  }
  return byName;
}

async function ensureMedicines(
  db: Db, actor: Actor, salts: Map<string, string>, report: PharmacyDemoReport,
): Promise<Map<string, string>> {
  const existing = new Map((await listMedicines(db)).map((m) => [m.brandName.toLowerCase(), m.id]));
  const byBrand = new Map<string, string>();
  for (const med of MEDICINES) {
    const found = existing.get(med.brand.toLowerCase());
    if (found !== undefined) { byBrand.set(med.brand, found); report.medicinesExisting += 1; continue; }
    const saltId = salts.get(med.salt);
    if (saltId === undefined) throw new Error(`internal: no salt id for "${med.salt}"`);
    const { medicineId } = await withTx(db, (tx: Tx) => addMedicine(tx, actor, {
      brandName: med.brand, form: med.form, routeClass: "systemic",
      strengthLabel: med.strength, scheduleFlag: med.schedule,
      salts: [{ saltId, strength: med.strength }],
    }));
    byBrand.set(med.brand, medicineId);
    report.medicinesCreated += 1;
  }
  return byBrand;
}

async function ensureItems(
  db: Db, actor: Actor, medicines: Map<string, string>, report: PharmacyDemoReport,
): Promise<Map<string, string>> {
  const existing = new Map((await listItems(db, { class: "drug" })).map((i) => [i.code.toLowerCase(), i.id]));
  const byCode = new Map<string, string>();
  for (const med of MEDICINES) {
    const found = existing.get(med.code.toLowerCase());
    if (found !== undefined) { byCode.set(med.code, found); report.itemsExisting += 1; continue; }
    const { itemId } = await withTx(db, (tx: Tx) => registerItem(tx, actor, {
      code: med.code, name: `${med.brand} ${med.form}`, class: "drug",
      baseUom: med.form === "capsule" ? "capsule" : "tablet",
      batchTracked: true,
      formularyMedicineId: medicines.get(med.brand) ?? null,
      hsnCode: "3004",
      /* LEFT NULL ON PURPOSE — see the header. It maps to `pharmacy_exempt`, which bills exactly
         the printed MRP. Setting a real slab before the owner's ruling makes the counter charge
         ABOVE MRP, because GST is added on top of a base that IS the tax-inclusive MRP. */
      gstRateBps: null,
      shelfLifeDays: SHELF_LIFE_DAYS,
      uoms: [{ uom: "strip", toBaseMultiplier: STRIP_MULTIPLIER, isPurchaseUom: true, isIssueUom: true }],
    }));
    byCode.set(med.code, itemId);
    report.itemsCreated += 1;
  }
  return byCode;
}

async function ensureSaleItems(db: Db, actor: Actor, items: Map<string, string>, report: PharmacyDemoReport): Promise<void> {
  for (const med of MEDICINES) {
    const itemId = items.get(med.code);
    if (itemId === undefined) throw new Error(`internal: no item id for "${med.code}"`);
    if ((await getSaleItem(db, itemId)) !== undefined) { report.saleItemsExisting += 1; continue; }
    await withTx(db, (tx: Tx) => registerSaleItem(tx, actor, itemId));
    report.saleItemsRegistered += 1;
  }
}

/**
 * `search` on `listVendors` is a fuzzy LIKE over name OR code, so the exact `.code` comparison is
 * required rather than optional — a substring hit on some other vendor would make this seed adopt it.
 */
async function ensureVendor(db: Db, actor: Actor, now: Date, report: PharmacyDemoReport): Promise<string> {
  const found = (await listVendors(db, { search: VENDOR_CODE }))
    .find((v) => v.code.toLowerCase() === VENDOR_CODE.toLowerCase());
  if (found !== undefined) return found.id;

  const vendorId = await withTx(db, async (tx: Tx) => {
    const { vendorId: id } = await registerVendor(tx, actor, {
      code: VENDOR_CODE, legalName: "Demo Pharma Distributors Private Limited",
      tradeName: "Demo Pharma", gstin: "10AABCD1234E1ZQ", pan: "AABCD1234E",
      paymentTermsDays: 30, classFlags: { drugLicensed: true },
    });
    /* `activateVendor` requires gst_certificate + pan for every vendor, and BOTH halves of the
       wholesale licence (20B and 21B) for a `drugLicensed` one. `validFrom: null` on purpose: the
       activation compares in UTC while the GRN's challan date is an IST calendar day, so between
       00:00 and 05:30 IST a "today" validFrom disagrees with itself by a day. */
    for (const doc of [
      { type: "gst_certificate", number: "10AABCD1234E1ZQ" },
      { type: "pan", number: "AABCD1234E" },
      { type: "drug_licence_20b", number: "BR/KTH/20B/DEMO/001" },
      { type: "drug_licence_21b", number: "BR/KTH/21B/DEMO/001" },
    ]) {
      await addVendorDocument(tx, actor, id, { type: doc.type, number: doc.number, validFrom: null, validTo: null });
    }
    await activateVendor(tx, actor, id, now);
    return id;
  });
  report.vendorCreated = true;
  return vendorId;
}

/**
 * One GRN per challan, and the challan number is the idempotency key this module does NOT enforce:
 * `grns` is unique on the generated `grn_no` only, so a second run would post a SECOND delivery of
 * the same paperwork and double the shelf. We look it up ourselves.
 */
async function ensureGrn(
  db: Db, actor: Actor, vendorId: string, storeId: string, items: Map<string, string>,
  challan: { no: string; monthsAgo: number; expiryMonthsAhead: number }, now: Date,
  report: PharmacyDemoReport,
): Promise<void> {
  const already = (await listGrns(db, { vendorId, storeResourceId: storeId }))
    .some((g) => g.challanNo === challan.no);
  if (already) { report.grnsSkipped += 1; return; }

  const challanAt = shiftMonths(now, -challan.monthsAgo);
  const expiryAt = shiftMonths(challanAt, challan.expiryMonthsAhead + challan.monthsAgo);
  const challanDate = istDay(challanAt);
  const expiryDate = istDay(expiryAt);
  const tag = challan.no.replace(/[^0-9]/g, "").slice(-6);

  const lines = MEDICINES.map((med) => {
    const itemId = items.get(med.code);
    if (itemId === undefined) throw new Error(`internal: no item id for "${med.code}"`);
    return {
      itemId, uom: "strip", qtyInUom: 20,
      batchNo: `${med.code}-${tag}`, expiryDate,
      mrpPaise: med.mrpPaisePerStrip, mrpUom: "strip",
      /* PER BASE UNIT (DD7). QC rule 6 rejects an MRP below cost, and MRP here is per STRIP while
         cost is per tablet — 12000/strip is 1200/tablet, so 700 clears it with room. */
      unitCostPaise: med.unitCostPaise,
    };
  });

  const posted = await withTx(db, async (tx: Tx) => {
    const { grnId } = await captureGrn(tx, actor, {
      vendorId, source: "challan", storeResourceId: storeId,
      challanNo: challan.no, challanDate, lines, now: challanAt, serviceDate: challanDate,
    });
    const qc = await runGateQc(tx, actor, grnId);
    /* THE VERDICT VOCABULARY IS `pass | near_expiry | reject` — there is no "accept" (qc.ts:55).
       `near_expiry` is counted as a failure here even though it is not a rejection: it needs a
       `materials_near_expiry_acceptance` approval before its stock posts, and a demo seed that
       quietly produced lines awaiting an approval nobody will file would leave a shelf that looks
       received and holds nothing. Neither challan should reach it — rule 5's bound is 183 days from
       the CHALLAN date and both are well clear — so if it fires, the fixture drifted. */
    const rejected = qc.verdicts.filter((v) => v.verdict !== "pass");
    if (rejected.length > 0) {
      /* A FULLY-REJECTED GRN POSTS SUCCESSFULLY WITH ZERO STOCK — `postGrn` emits the rejections,
         marks it posted and returns no ledger entries. So `postGrn` completing is NOT evidence the
         shelf has anything, and a silent partial is worse than a refusal in a demo people trust. */
      throw new Error(
        `GRN ${challan.no}: QC rejected ${String(rejected.length)} of ${String(qc.verdicts.length)} lines ` +
          `(${rejected.map((v) => v.rule ?? "?").join(", ")}). The fixture dates or prices need correcting; ` +
          "nothing was posted.",
      );
    }
    return postGrn(tx, actor, grnId, challanAt);
  });
  if (posted.ledgerEntryIds.length === 0) throw new Error(`GRN ${challan.no} posted no stock`);
  report.grnsPosted += 1;
}

export async function seedPharmacyDemo(db: Db, now: Date = new Date()): Promise<PharmacyDemoReport> {
  const report: PharmacyDemoReport = {
    saltsCreated: 0, saltsExisting: 0, medicinesCreated: 0, medicinesExisting: 0,
    itemsCreated: 0, itemsExisting: 0, saleItemsRegistered: 0, saleItemsExisting: 0,
    vendorCreated: false, grnsPosted: 0, grnsSkipped: 0,
    batchesOnShelf: 0, sellableUnits: 0, expiredUnitsOnShelf: 0,
  };

  /* Both actors are resolved BEFORE anything is written. A seed that half-populates a catalogue and
     then dies on a missing role is the worst available outcome — the operator has to work out what
     landed. §2 of the runbook is two people and this refuses as two people. */
  const pharmacist = await actorHolding(db, "pharmacy");
  const materialsHead = await actorHolding(db, "materials_head");

  const store = await findStoreByCode(db, STORE_CODE);
  if (store === undefined) {
    throw new Error(
      `the "${STORE_CODE}" store does not exist — run \`pnpm --filter @hmis/core seed:pharmacy\` first.\n` +
        "  Without it every claim at the counter refuses with store_missing.",
    );
  }

  const salts = await ensureSalts(db, pharmacist, report);
  const medicines = await ensureMedicines(db, pharmacist, salts, report);
  const items = await ensureItems(db, materialsHead, medicines, report);
  await ensureSaleItems(db, pharmacist, items, report);

  const vendorId = await ensureVendor(db, materialsHead, now, report);
  await ensureGrn(db, materialsHead, vendorId, store.id, items, FRESH_CHALLAN, now, report);
  await ensureGrn(db, materialsHead, vendorId, store.id, items, AGED_CHALLAN, now, report);

  /* THE REPORT ASSERTS THE DIFFERENCE THE COUNTER WILL SEE, not the rows written. `availableQty`
     applies the same predicate `fefoPick` picks from — in date, not recalled, less what is reserved
     — so `sellableUnits` is what the pharmacist can actually dispense, while the aged challan's
     stock sits on the shelf and is deliberately NOT in it. An operator who sees those two numbers
     differ has understood the shelf; one who sees only a row count has not. */
  const onShelf = await balances(db, { resourceId: store.id });
  report.batchesOnShelf = onShelf.length;
  let sellable = 0;
  for (const med of MEDICINES) {
    const itemId = items.get(med.code);
    if (itemId !== undefined) sellable += await availableQty(db, store.id, itemId, now);
  }
  report.sellableUnits = sellable;
  report.expiredUnitsOnShelf = onShelf.reduce((n, b) => n + b.qtyOnHand, 0) - sellable;
  return report;
}

async function main(): Promise<void> {
  const url = requireEnv("DATABASE_URL");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  assertDemoDataAllowed(process.env, dbName);
  process.stdout.write(`seed:pharmacy-demo -> writing a synthetic catalogue and shelf to "${dbName}"\n`);

  const { db, pool } = createDb(url);
  try {
    const report = await seedPharmacyDemo(db);
    for (const [k, v] of Object.entries(report)) process.stdout.write(`  ${k}: ${String(v)}\n`);
    process.stdout.write(
      "\n  The SHELF is ready; the QUEUE is not. This seed writes no patient and no prescription —\n" +
        "  see the header, and docs/runbooks/pharmacy-go-live.md §3 for the drill to run by hand.\n",
    );
  } finally {
    await pool.end();
  }
}

/* `require.main === module`, as eighteen of the nineteen seeds do. `seed-lab-demo.ts`'s
   `process.argv[1]?.endsWith(".ts")` is a defect: compiled and run as `node dist/scripts/X.js` —
   which is how every deploy runs a seed — it never matches, and the script exits 0 having written
   nothing at all. */
if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
