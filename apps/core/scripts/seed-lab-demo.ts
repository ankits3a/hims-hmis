import { eq } from "drizzle-orm";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { collectOrderKinds } from "../src/kernel/orders/kinds";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { patients, resources, roleAssignments, users } from "../src/kernel/db/schema";
import { registerPatient } from "../src/modules/patients";
import { registerOpdEncounterResolver } from "../src/modules/opd/opd.module";
import { OpdError } from "../src/modules/opd";
import { analytesFor, collect, deskWalkinOrder, printLabels, receive } from "../src/modules/lab";
/**
 * The instrument register is not on the lab module's `index.ts` seam — 17-E T1 kept it internal,
 * and a seed is not a module, so it imports the file directly exactly as `seed-lab-catalogue.ts`
 * does with `catalogue.ts`. The boundary lint rule scopes itself to `src/modules/**` for this
 * reason: widening a module's public seam to serve an operator script would be the tail wagging.
 */
import { mapInstrumentCode, registerInstrument } from "../src/modules/lab/instruments";
import { serviceIdForLabCode } from "./seed-lab-catalogue";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../src/kernel/db/client";
import type { OrderKindDecl } from "../src/kernel/orders/kinds";

/**
 * `pnpm --filter @hmis/core seed:lab-demo` — SYNTHETIC clinical data so the five lab seats open onto
 * something. **Plan 17-E, after T5.**
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * 17a–17-E shipped five working seats, a report centre and the analyser interface, and every one of
 * them opens onto an empty list on a fresh box. The bench's scan needs a COLLECTED, RECEIVED
 * specimen; that needs a patient, a placed order and a completed collection; and nothing in this
 * repository produced any of them. `seed:lab-catalogue` seeds the BOOK — what the lab can test — and
 * deliberately stops there. This seeds a DAY.
 *
 * ═══ IT IS NOT IN `deploy.sh`, AND THAT IS THE POINT ═══
 *
 * Every other `seed:*` step is idempotent infrastructure that every environment needs. This one
 * invents PATIENTS. A seed that runs on every deploy and creates people would put synthetic humans
 * into a live hospital's register, where they are indistinguishable from the real ones and cannot be
 * deleted (a patient is referenced by orders, invoices and results). So it is an operator command,
 * it is absent from `SEED_STEP_SCRIPTS`, and it refuses to run without being asked twice.
 *
 * ═══ IT MINTS NO CREDENTIALS, AND FINDS ITS ACTORS BY ROLE ═══
 *
 * `seed-staff.ts` rejected env vars AND a file on the box for credentials, choosing stdin so the
 * owner keeps the only copy — *"a credential roster left on a box is an artefact nobody remembers to
 * delete"*. A demo seed that created its own users would be that artefact, in git, for ever.
 *
 * So it creates no user and takes no password. It LOOKS UP whoever already holds `lab_reception`,
 * `lab_technician` and `pathologist`, and refuses with an instruction if the hospital has not made
 * them yet. The administrator creates them at `/admin/users`, which is a screen that ships.
 *
 * ═══ EVERYTHING GOES THROUGH THE REAL WRITE PATHS ═══
 *
 * `registerPatient`, `deskWalkinOrder`, `printLabels`, `collect`, `receive` — the same functions the
 * counter and the bench call. Not one row is hand-inserted. A seed that wrote `lab_specimens`
 * directly would produce tubes with no `lab_specimen_items` link, which look right on a list and
 * fail the moment anybody scans one — demo data that lies about the system is worse than none.
 */

/** Synthetic people. Ordinary north-Indian names, because the owner is judging a SCREEN. */
const DEMO_PEOPLE = [
  { name: "Sunita Devi", sex: "female", ageYears: 34, phone: "9000000101" },
  { name: "Rakesh Prasad", sex: "male", ageYears: 51, phone: "9000000102" },
  { name: "Anjali Gupta", sex: "female", ageYears: 27, phone: "9000000103" },
  { name: "Mohammed Irfan", sex: "male", ageYears: 45, phone: "9000000104" },
  { name: "Kavita Sharma", sex: "female", ageYears: 62, phone: "9000000105" },
  { name: "Deepak Yadav", sex: "male", ageYears: 19, phone: "9000000106" },
] as const;

/**
 * ═══ THE FIVE SEATS EACH NEED A DIFFERENT STAGE ═══
 *
 * A seed that received every tube would leave the collection chair as empty as it found it. Each
 * person is deliberately left at a different point in the chain, so every seat has work waiting and
 * the owner can walk the whole path without first creating anything by hand.
 */
const DEMO_ORDERS: readonly { person: string; codes: readonly string[]; stopAt: Stage }[] = [
  { person: "Sunita Devi", codes: ["CBC", "LFT"], stopAt: "ordered" },
  { person: "Rakesh Prasad", codes: ["RFT", "LIPID"], stopAt: "ordered" },
  { person: "Anjali Gupta", codes: ["CBC"], stopAt: "collected" },
  { person: "Mohammed Irfan", codes: ["TSH", "GLUF"], stopAt: "collected" },
  { person: "Kavita Sharma", codes: ["CBC", "HBSAG"], stopAt: "received" },
  { person: "Deepak Yadav", codes: ["LFT", "HCV"], stopAt: "received" },
];
type Stage = "ordered" | "collected" | "received";

/**
 * The three machines from the design board, one per naming mode that has a writer. Registering them
 * is what makes T3, T4 and T5 demoable at all: without an instrument row there is nothing for a
 * bridge to post to, no run sheet to open and no plate to lay out.
 */
const DEMO_INSTRUMENTS = [
  { code: "CHEM-1", name: "Chemistry analyser (barcode)", mode: "barcode",
    codes: [["GLUF", "GLU"], ["LFT", "SGPT"]] },
  { code: "EL-120", name: "Electrolyte analyser (sequence)", mode: "run_sheet",
    codes: [["RFT", "NA"]] },
  { code: "ELISA-1", name: "ELISA microplate reader (96 wells)", mode: "plate_map",
    codes: [["HBSAG", "HBSAG_OD"], ["HCV", "HCV_OD"]] },
] as const;

/** A user holding this role, as an actor. Refuses with an instruction rather than inventing one. */
async function actorHolding(db: Db, roleKey: string): Promise<Actor & { id: string }> {
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    /** `role_assignments` keys on the role KEY, not on a role id — it FKs `roles.key` directly. */
    .where(eq(roleAssignments.roleKey, roleKey))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      `no user holds the "${roleKey}" role.\n` +
        "  This seed creates no accounts and mints no credentials by design (see the header).\n" +
        `  Sign in as an administrator, open /admin/users, create a user and grant it "${roleKey}",\n` +
        "  then run this again.",
    );
  }
  return { type: "user", id: row.id };
}

/** The analyte behind an orderable, for the instrument code map. One code, one analyte (D8). */
async function firstAnalyteOf(db: Db, labCode: string): Promise<string | null> {
  const analytes = await analytesFor(db, serviceIdForLabCode(labCode));
  return analytes.find((a) => a.resultType !== "formula")?.id ?? null;
}

export type SeedLabDemoReport = {
  patientsCreated: number;
  patientsExisting: number;
  ordersPlaced: number;
  /** Skipped because the person already has an open lab visit today — see the re-run note below. */
  ordersSkipped: number;
  specimensPrinted: number;
  specimensCollected: number;
  specimensReceived: number;
  instrumentsRegistered: number;
};

/**
 * TODAY, IN IST. The lab's day is an Indian calendar day, so a seed run at 02:00 UTC must land on
 * the date the bench would call today and not on yesterday's worklist — `en-CA` because it is the
 * locale that formats as `YYYY-MM-DD`, which is what `service_date` holds.
 */
function todayIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export async function seedLabDemo(db: Db): Promise<SeedLabDemoReport> {
  const serviceDate = todayIst();
  /**
   * ═══ THE SEED IS NOT A SERVER, SO IT MUST REGISTER WHAT THE SERVER REGISTERS ═══
   *
   * A lab order is placed against an ENCOUNTER, and `placeOrder` resolves the visit number through
   * the keyed resolver registry rather than reaching into `opd_encounters` itself — OPD hands
   * billing a reader for its own letter and billing knows no module. `OpdModule.onModuleInit` does
   * that registration in the API and the worker; a `tsx scripts/…` process boots neither, so
   * without this line every walk-in here dies on `no registered prefix resolves encounter "V…"`.
   *
   * `registerOpdEncounterResolver` is exported for exactly this — its own comment says a caller
   * should not have to stand up a module graph to resolve a `V` number, and that a private copy in
   * a fixture would be a second answer to a question that must have one. A seed is that caller.
   * The registry is keyed, so this REPLACES rather than double-registers.
   */
  registerOpdEncounterResolver();
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);
  const decls: readonly OrderKindDecl[] = collectOrderKinds(registry);

  const desk = await actorHolding(db, "lab_reception");
  const bench = await actorHolding(db, "lab_technician");
  const pathologist = await actorHolding(db, "pathologist");

  const report: SeedLabDemoReport = {
    patientsCreated: 0, patientsExisting: 0, ordersPlaced: 0, ordersSkipped: 0, specimensPrinted: 0,
    specimensCollected: 0, specimensReceived: 0, instrumentsRegistered: 0,
  };

  /**
   * IDEMPOTENT BY PHONE. The demo numbers are reserved and unique to this file, so a second run
   * finds the same six people and adds no seventh. A seed an operator is afraid to run twice is a
   * seed they run once and then work around.
   */
  const byName = new Map<string, { id: string; uhid: string }>();
  for (const person of DEMO_PEOPLE) {
    const existing = await db
      .select({ id: patients.id, uhid: patients.uhid })
      .from(patients).where(eq(patients.phone, person.phone));
    if (existing[0]) {
      byName.set(person.name, existing[0]);
      report.patientsExisting += 1;
      continue;
    }
    const made = await withTx(db, (tx: Tx) => registerPatient(tx, desk, {
      name: person.name, sex: person.sex, ageYears: person.ageYears, phone: person.phone,
      district: "Katihar", stateName: "Bihar",
    }));
    byName.set(person.name, { id: made.patient.id, uhid: made.patient.uhid });
    report.patientsCreated += 1;
  }

  for (const spec of DEMO_ORDERS) {
    const patient = byName.get(spec.person);
    if (!patient) continue;
    /**
     * A walk-in, which is how a lab order reaches this counter without an OPD consultation.
     *
     * ═══ RE-RUNNING IS SAFE BECAUSE THE HOSPITAL'S OWN GUARD SAYS SO ═══
     *
     * `openLabWalkinInTx` refuses a SECOND open lab visit for one patient on one day — *"add the
     * tests to that order rather than opening a second visit for one draw"* — which is correct
     * counter behaviour and not something a seed may argue with. So the re-run key for the ORDERS
     * is that refusal itself, caught by code. Skipping on "the patient already existed" would have
     * been the tempting shortcut and would have been wrong the NEXT day, when the same six people
     * legitimately need a fresh day's work and the guard would have allowed it.
     */
    let placed;
    try {
      placed = await withTx(db, (tx: Tx) => deskWalkinOrder(tx, desk, decls, {
        patientId: patient.id,
        serviceDate,
        items: spec.codes.map((c) => ({ serviceId: serviceIdForLabCode(c) })),
        walkIn: { intendedPayer: "self", referrerName: "Self" },
        chargeReason: "lab_walkin",
        credit: { reason: "demo data" },
      }));
    } catch (e) {
      if (e instanceof OpdError && e.code === "lab_walkin_already_open") {
        report.ordersSkipped += 1;
        continue;
      }
      throw e;
    }
    report.ordersPlaced += 1;

    const { specimens } = await printLabels(db, bench, {
      orderGroupId: placed.orderGroupId, scannedUhid: patient.uhid,
    });
    report.specimensPrinted += specimens.length;
    if (spec.stopAt === "ordered") continue;

    for (const s of specimens) {
      await withTx(db, (tx: Tx) => collect(tx, bench, { specimenId: s.specimenId, wristbandScanned: true }));
      report.specimensCollected += 1;
    }
    if (spec.stopAt === "collected") continue;

    for (const s of specimens) {
      await withTx(db, (tx: Tx) => receive(tx, bench, decls, { specimenNo: s.specimenNo }));
      report.specimensReceived += 1;
    }
  }

  for (const machine of DEMO_INSTRUMENTS) {
    const already = await db
      .select({ id: resources.id }).from(resources).where(eq(resources.code, machine.code));
    if (already[0]) continue;
    const { instrumentId } = await registerInstrument(db, pathologist, {
      code: machine.code, name: machine.name, sampleIdMode: machine.mode,
    });
    for (const [labCode, instrumentCode] of machine.codes) {
      const analyteId = await firstAnalyteOf(db, labCode);
      if (analyteId === null) continue;
      await mapInstrumentCode(db, pathologist, { instrumentId, instrumentCode, analyteId });
    }
    report.instrumentsRegistered += 1;
  }

  return report;
}

async function main(): Promise<void> {
  const url = requireEnv("DATABASE_URL");
  /**
   * ═══ ASKED TWICE, ON PURPOSE ═══
   *
   * This is the only seed in the tree that invents PEOPLE. A patient cannot be deleted once orders,
   * invoices and results reference them, so a synthetic one written to a live register is permanent.
   * The banner names the database before anything is written, and the opt-in is a word the operator
   * has to type rather than a flag they can inherit from a shell history.
   */
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed:lab-demo refuses to run with NODE_ENV=production — it creates synthetic patients");
  }
  if (process.env.ALLOW_DEMO_DATA !== "yes") {
    throw new Error(
      `seed:lab-demo would write SYNTHETIC PATIENTS to the database "${dbName}".\n` +
        "  They are indistinguishable from real ones once orders and results reference them.\n" +
        "  If that is a demo or test database, re-run with ALLOW_DEMO_DATA=yes.",
    );
  }
  process.stdout.write(`seed:lab-demo -> writing synthetic clinical data to "${dbName}"\n`);

  const { db, pool } = createDb(url);
  try {
    const report = await seedLabDemo(db);
    for (const [k, v] of Object.entries(report)) process.stdout.write(`  ${k}: ${v}\n`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("seed-lab-demo.ts")) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
