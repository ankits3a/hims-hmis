import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import * as contracts from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { seedActiveStudyTypes, studyTypeRow } from "../../../../test/helpers/radiology";
import { imagingStudies, orderItems, orders, patients, services } from "../../../kernel/db/schema";
import { CONFIG, DB, MODULE_REGISTRY } from "../../../kernel/tokens";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import * as radiology from "../index";
import { radiologyMetrics } from "../metrics";
import { northStar } from "../north-star";
import { RadiologyAcquisitionController } from "../radiology-acquisition.controller";
import { RadiologyReleaseController } from "../radiology-release.controller";
import { RadiologyReportsController } from "../radiology-reports.controller";
import { RadiologyScheduleController } from "../radiology-schedule.controller";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1077, spec docs/specs/1077-imaging-one-rule-each.md (owner APPROVED 2026-11-14):
 * one rule for where a study came from, one treating-doctor join, `reports.ts` split, the act bodies in
 * `@hmis/contracts`.
 *
 * D1 and D2 run the code. D3 and D5 are STRUCTURAL checks — they read the module's source tree and its
 * export list, the census style `billing-purity.test.ts` and `roles-catalog.e2e.test.ts` already use —
 * because "appears in exactly one file" and "no file of that name exists" are facts about the source,
 * not about any one call. D4 sends each body over HTTP to the real controllers, mounted behind a stub
 * guard that lets everybody in: what is under test is the body check, and the permission and
 * second-factor guards it would otherwise meet first are not.
 *
 * D2's day is written by hand and passed explicitly; nothing here reads the clock.
 */

const MODULE_DIR = join(__dirname, "..");

/* ─────────────────────────────── D1 ─────────────────────────────── */

describe("spec #1077 — one rule for where a study came from", () => {
  const FIXTURES = [
    { study: { encounterNo: "V2603100003", bedsideLocation: null }, order: { authority: "external_prescription" }, source: "walk_in" },
    { study: { encounterNo: "D2603100001", bedsideLocation: null }, order: { authority: "clinician" }, source: "daycare" },
    { study: { encounterNo: "V2603100005", bedsideLocation: "Ward 3 · bed 12" }, order: { authority: "clinician" }, source: "ipd" },
    { study: { encounterNo: "V2603100001", bedsideLocation: null }, order: { authority: "clinician" }, source: "opd" },
  ] as const;

  it("spec #1077 D1: studySource answers walk_in, daycare, ipd and opd for the four fixture studies", () => {
    const studySource = (radiology as Record<string, unknown>)["studySource"] as
      ((study: { encounterNo: string; bedsideLocation: string | null }, order: { authority: string }) => string) | undefined;
    expect(typeof studySource).toBe("function");
    expect(FIXTURES.map((f) => studySource!(f.study, f.order))).toEqual(["walk_in", "daycare", "ipd", "opd"]);
  });
});

/* ─────────────────────────────── D2 ─────────────────────────────── */

describe("spec #1077 — the metrics read and the north star count one day alike", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  jest.setTimeout(120_000);

  const DAY = "2026-03-10";
  const PREV = "2026-03-09";
  const at = (hhmm: string, day = DAY): Date => new Date(`${day}T${hhmm}:00+05:30`);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const svc: Record<string, string> = {};
    for (const code of ["USG-ABDO", "XR-CHEST"]) {
      svc[code] = contracts.newId();
      await db.insert(services).values({ id: svc[code]!, code: `RAD-${code}`, name: `Imaging ${code}`, category: "investigation", createdBy: "t", updatedBy: "t" });
    }
    await seedActiveStudyTypes(db, [
      studyTypeRow({ code: "USG-ABDO", service_id: svc["USG-ABDO"]!, modality: "usg" }),
      studyTypeRow({ code: "XR-CHEST", service_id: svc["XR-CHEST"]!, modality: "xray" }),
    ], at("00:00", PREV));
    const patientId = contracts.newId();
    await db.insert(patients).values({
      id: patientId, uhid: "HMS-00001077-1", name: "Test Patient", sex: "male", administrativeGender: "male",
      createdBy: "t", updatedBy: "t",
    });

    let seq = 0;
    /** One order, its one item and its one study, placed (and acquired half an hour later) on the day. */
    const place = async (
      encounterNo: string, code: "USG-ABDO" | "XR-CHEST", placed: Date,
      opts: { walkIn?: boolean; stat?: boolean; bedside?: string } = {},
    ): Promise<void> => {
      seq += 1;
      const orderId = contracts.newId();
      const priority = opts.stat === true ? "stat" : "routine";
      await db.insert(orders).values({
        id: orderId, orderNo: `R26031077${String(seq).padStart(2, "0")}`, orderGroupId: orderId, kind: "imaging", patientId, encounterNo,
        serviceDate: DAY, priority, authority: opts.walkIn === true ? "external_prescription" : "clinician",
        externalReferrerId: opts.walkIn === true ? "referrer-1" : null, orderedByType: "user", orderedById: "t",
        status: "open", placedAt: placed, createdAt: placed,
      });
      const itemId = contracts.newId();
      await db.insert(orderItems).values({ id: itemId, orderId, serviceId: svc[code]!, createdAt: placed, status: "placed" });
      const studyId = contracts.newId();
      await db.insert(imagingStudies).values({
        id: studyId, orderItemId: itemId, orderId, patientId, encounterNo, studyTypeCode: code, serviceId: svc[code]!,
        accessionNo: `X1077${String(seq)}${studyId.slice(-6)}`, priority, status: "acquired",
        workflowInstanceId: contracts.newId(), acquiredAt: new Date(placed.getTime() + 30 * 60_000), imageSource: "no_pacs_images",
        bedsideLocation: opts.bedside ?? null, createdAt: placed,
      });
    };

    await place("V2603100001", "USG-ABDO", at("09:00"));
    /** The STAT OPD order: STAT is a priority, not a place. */
    await place("V2603100002", "XR-CHEST", at("09:30"), { stat: true });
    await place("V2603100003", "USG-ABDO", at("10:00"), { walkIn: true });
    await place("D2603100001", "USG-ABDO", at("10:30"));
    await place("V2603100005", "XR-CHEST", at("11:00"), { bedside: "Ward 3 · bed 12" });
  });

  it("spec #1077 D2: for one fixture day holding a STAT OPD order, the metrics read and the north-star read report the same count per source", async () => {
    const m = await radiologyMetrics(db, { from: DAY, to: DAY });
    const ns = await northStar(db, { from: DAY, to: DAY, now: at("23:00") });

    const metricsBySource: Record<string, number> = {};
    for (const r of m.bySource) if (r.orders > 0) metricsBySource[r.source] = r.orders;
    const northStarBySource: Record<string, number> = {};
    for (const r of ns.rows) northStarBySource[r.source] = (northStarBySource[r.source] ?? 0) + r.ordered;

    expect(northStarBySource).toEqual(metricsBySource);
    expect(metricsBySource).toEqual({ opd: 2, walk_in: 1, daycare: 1, ipd: 1 });
  });
});

/* ─────────────────────────────── D3 ─────────────────────────────── */

/** Every non-test source file under the module, recursively, relative to it. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(relative(MODULE_DIR, full));
  }
  return out.sort();
}

/**
 * The treating-doctor rule's visit half is a join of an OPD visit to the study it ordered: an OPD visit
 * number equated with a study's encounter number — the drizzle spelling (`eq(...)` or a `sql` fragment)
 * or raw SQL.
 */
const VISIT_TO_STUDY_JOIN = [
  /opdEncounters\.visitNo\W+imagingStudies\.encounterNo/,
  /imagingStudies\.encounterNo\W+opdEncounters\.visitNo/,
  /visit_no\s*=\s*[\w."]*encounter_no/,
  /encounter_no\s*=\s*[\w."]*visit_no/,
];

describe("spec #1077 — one treating-doctor join", () => {
  it("spec #1077 D3: the OPD-doctor join for the treating-doctor rule appears in exactly one radiology source file", () => {
    const joining = sourceFiles(MODULE_DIR).filter((f) => {
      const text = readFileSync(join(MODULE_DIR, f), "utf8");
      return VISIT_TO_STUDY_JOIN.some((re) => re.test(text));
    });
    expect(joining).toEqual(["closed-loop.ts"]);
  });
});

/* ─────────────────────────────── D4 ─────────────────────────────── */

/** Everybody is a signed-in user with a fresh second factor; the body is the only thing a route can refuse. */
class EveryoneIn implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
    req["hmisActor"] = { type: "user", id: "acceptance-user" };
    req["hmisSession"] = { secondFactorAt: new Date() };
    return true;
  }
}

/**
 * A database that fails the request if anybody queries it: a 400 must come before any read. Only the
 * query surface throws — Nest itself looks for lifecycle hooks on every provider value.
 */
const DB_SURFACE = new Set(["select", "selectDistinct", "insert", "update", "delete", "execute", "transaction", "query"]);
const UNTOUCHABLE_DB = new Proxy({}, {
  get: (_target, prop) => (typeof prop === "string" && DB_SURFACE.has(prop)
    ? () => { throw new Error("the database was queried before the body was checked"); }
    : undefined),
});

const ACT_BODIES: { schema: string; path: string; bodies: unknown[] }[] = [
  { schema: "imagingSignBody", path: "/radiology/studies/S1/reports/sign", bodies: [{}, { reportId: "R1", criticalCategory: "purple" }] },
  { schema: "imagingAmendBody", path: "/radiology/studies/S1/reports/amend", bodies: [{ body: {} }, { body: {}, reason: "typo", laterality: "up" }] },
  { schema: "imagingAcquiredBody", path: "/radiology/studies/S1/acquisition/acquired", bodies: [{}, { imageSource: "film" }] },
  {
    schema: "imagingContrastBody", path: "/radiology/studies/S1/contrast",
    bodies: [
      { agent: "Iohexol 350", volumeMl: 0, route: "intravenous", givenBy: "U1", givenAt: "2026-03-10T04:00:00.000Z" },
      { agent: "Iohexol 350", volumeMl: 80, route: "by mouth", givenBy: "U1", givenAt: "2026-03-10T04:00:00.000Z" },
    ],
  },
  { schema: "imagingHandoverBody", path: "/radiology/reports/R1/handover", bodies: [{ collectorKind: "neighbour" }, { collectorKind: "patient", tip: 50 }] },
  { schema: "imagingScheduleBody", path: "/radiology/studies/S1/schedule", bodies: [{ scheduledAt: "2026-03-10T04:00:00.000Z" }, { deviceResourceId: "D1", scheduledAt: "tomorrow" }] },
  { schema: "imagingRescheduleBody", path: "/radiology/studies/S1/reschedule", bodies: [{ deviceResourceId: "D1" }, { deviceResourceId: "D1", scheduledAt: "2026-03-10T04:00:00.000Z", reason: 7 }] },
];

describe("spec #1077 — the act bodies are the contracts' schemas", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RadiologyReportsController, RadiologyAcquisitionController, RadiologyReleaseController, RadiologyScheduleController],
      providers: [
        { provide: DB, useValue: UNTOUCHABLE_DB },
        { provide: MODULE_REGISTRY, useValue: new ModuleRegistry() },
        { provide: CONFIG, useValue: { secondFactorWindowMinutes: 15 } },
        { provide: APP_GUARD, useClass: EveryoneIn },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it("spec #1077 D4: @hmis/contracts exports the sign, amend, acquired, contrast, hand-over and schedule body schemas, and each route answers 400 for a body its contracts schema rejects", async () => {
    const exported = contracts as unknown as Record<string, { safeParse?: (b: unknown) => { success: boolean } } | undefined>;
    expect(ACT_BODIES.filter((a) => typeof exported[a.schema]?.safeParse !== "function").map((a) => a.schema)).toEqual([]);

    const server = app.getHttpServer() as Parameters<typeof request>[0];
    for (const act of ACT_BODIES) {
      for (const body of act.bodies) {
        expect({ schema: act.schema, body, accepted: exported[act.schema]!.safeParse!(body).success })
          .toEqual({ schema: act.schema, body, accepted: false });
        const res = await request(server).post(act.path).send(body as object);
        expect({ path: act.path, body, status: res.status }).toEqual({ path: act.path, body, status: 400 });
      }
    }
  });
});

/* ─────────────────────────────── D5 ─────────────────────────────── */

/** Every name `reports.ts` exported before the split (main at #1076), values and types. */
const REPORTS_VALUES = [
  "SECOND_FACTOR_WINDOW_MINUTES", "latestSigned", "draftReport", "proposeDraft", "savePrelim", "signReport",
  "RESIDENT_ROLE", "CONSULTANT_ROLE", "signsAsResident", "cosignReport", "dryRunPreSign", "amendReport",
  "publishReport", "enqueueReportReady", "flagCritical", "acknowledgeCritical", "overReadNightPrelim",
];
const REPORTS_TYPES = ["ReportRow", "ReportContent", "SignChecksRecord"];

describe("spec #1077 — reports.ts is split and its names survive", () => {
  it("spec #1077 D5: no reports.ts exists in the module, and every name it exported is still exported from index.ts", () => {
    expect(existsSync(join(MODULE_DIR, "reports.ts"))).toBe(false);

    const values = radiology as Record<string, unknown>;
    expect(REPORTS_VALUES.filter((n) => values[n] === undefined)).toEqual([]);

    const index = readFileSync(join(MODULE_DIR, "index.ts"), "utf8");
    const typeNames = new Set([...index.matchAll(/export\s+type\s*\{([^}]*)\}/g)]
      .flatMap((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter((s) => s !== "")));
    expect(REPORTS_TYPES.filter((n) => !typeNames.has(n))).toEqual([]);
  });
});
