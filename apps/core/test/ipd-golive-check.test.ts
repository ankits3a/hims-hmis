import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkGoLiveReadyWorld } from "./helpers/ipd-golive";
import { resources, services } from "../src/kernel/db/schema";
import { emergencyAdmit } from "../src/modules/ipd";
import { IPD_GOLIVE_ITEMS, anyFail, formatGoLiveCheck, runIpdGoLiveCheck } from "../scripts/ipd-golive-check";
import type { CheckResult } from "../scripts/ipd-golive-check";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * E3.4 (#732) — the IPD go-live readiness check. One READY state (every FAIL-able item PASS) and the FAIL states the
 * owner will meet on the day: a fresh database, a bed in an impossible state, a rehearsal patient left admitted, an
 * IPD service left off. And it never writes.
 */
const verdicts = (rs: CheckResult[]): Record<string, string> => Object.fromEntries(rs.map((r) => [r.code, r.verdict]));
const FULL_ENV = { COPILOT_BASE_URL: "https://model.example/v1", COPILOT_API_KEY: "k", IPD_FAMILY_OTP_DLT_TEMPLATE_ID: "1107" };

async function rowCounts(db: Db): Promise<string> {
  const r = await db.execute(sql`select
    (select count(*) from events) as e, (select count(*) from resources) as r, (select count(*) from ipd_admissions) as a,
    (select count(*) from services where active) as s, (select count(*) from approval_types) as t`);
  return JSON.stringify(r.rows[0]);
}

describe("ipd-golive-check", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  it("FAIL on a fresh database: every FAIL-able item fails, the warnings warn, and the exit verdict is NOT READY", async () => {
    const rs = await runIpdGoLiveCheck(db, {});
    const failable = IPD_GOLIVE_ITEMS.filter((i) => i.warnOnly !== true).map((i) => i.code);
    // `no_test_patient_admitted` is the one item an empty hospital satisfies; an unloaded bed list is a FAIL, never a vacuous PASS.
    expect(rs.filter((r) => r.verdict === "PASS").map((r) => r.code)).toEqual(["no_test_patient_admitted"]);
    expect(rs.filter((r) => r.verdict === "FAIL").map((r) => r.code).sort())
      .toEqual(failable.filter((c) => c !== "no_test_patient_admitted").sort());
    expect(verdicts(rs)).toMatchObject({ copilot_model: "WARN", notify_templates: "WARN" });
    expect(anyFail(rs)).toBe(true);
    const text = formatGoLiveCheck(rs);
    expect(text.at(-1)).toMatch(/NOT READY$/);
    // every FAIL carries its fix on the next line
    expect(text.find((l) => l.startsWith("FAIL  beds_loaded"))).toBeDefined();
    expect(text[text.findIndex((l) => l.startsWith("FAIL  beds_loaded")) + 1]).toMatch(/^ {6}fix: .*load-bed-layout/);
  });

  it("PASS when the hospital is ready: workflow, approvals, rate card, beds, people, PHARM-OPD — and it wrote nothing", async () => {
    await mkGoLiveReadyWorld(db);
    const before = await rowCounts(db);
    const rs = await runIpdGoLiveCheck(db, FULL_ENV);
    expect(rs.filter((r) => r.verdict === "FAIL")).toEqual([]);
    expect(anyFail(rs)).toBe(false);
    expect(verdicts(rs)).toMatchObject({
      admission_workflow_active: "PASS", approval_types_registered: "PASS", approvers_held: "PASS", rate_card_complete: "PASS",
      ipd_services_on: "PASS", beds_loaded: "PASS", beds_consistent: "PASS", pharm_opd_store: "PASS", no_test_patient_admitted: "PASS",
      "role_held:ward_nurse": "PASS", "role_held:medical_superintendent": "PASS", copilot_model: "PASS",
    });
    // ipd.daily_totals is held until #761: a warning, never a failure
    expect(verdicts(rs).notify_templates).toBe("WARN");
    expect(formatGoLiveCheck(rs).at(-1)).toMatch(/— READY$/);
    expect(await rowCounts(db)).toBe(before);
  });

  it("FAIL on the day's traps: an impossible bed, a test patient admitted, an IPD service left off", async () => {
    const w = await mkGoLiveReadyWorld(db);
    // a bed marked occupied with nobody on it
    const ghost = await w.bed("GL-GHOST");
    await db.update(resources).set({ status: "occupied" }).where(eq(resources.id, ghost));
    // a rehearsal patient left admitted
    const patientId = await w.patient("female", 30, "Test Patient Rehearsal");
    await emergencyAdmit(db, w.admitDesk, {
      idempotencyKey: randomUUID(), patientId, bedId: await w.bed("GL-REH"), consultantId: w.doctor.id, isolation: "none", mlc: false,
    }, { now: new Date() });
    // a priced IPD service switched off
    await db.update(services).set({ active: false }).where(eq(services.code, "IPD_NURSING_SUITE"));

    const rs = await runIpdGoLiveCheck(db, FULL_ENV);
    const by = new Map(rs.map((r) => [r.code, r]));
    expect(by.get("beds_consistent")).toMatchObject({ verdict: "FAIL", detail: "GL-GHOST: marked occupied with nobody on it" });
    expect(by.get("no_test_patient_admitted")?.verdict).toBe("FAIL");
    expect(by.get("no_test_patient_admitted")?.detail).toContain("Test Patient Rehearsal");
    expect(by.get("ipd_services_on")).toMatchObject({ verdict: "FAIL", detail: "off: IPD_NURSING_SUITE" });
    expect(anyFail(rs)).toBe(true);
  });

  it("never writes: an item that tries to is refused by Postgres (the run is READ ONLY) and reads as FAIL", async () => {
    await mkGoLiveReadyWorld(db);
    const before = await rowCounts(db);
    const writer = {
      code: "writer", fix: "none",
      run: async (tx: Tx) => { await tx.update(services).set({ active: false }); return { ok: true, detail: "wrote" }; },
    };
    const rs = await runIpdGoLiveCheck(db, FULL_ENV, [writer, ...IPD_GOLIVE_ITEMS]);
    expect(rs[0]).toMatchObject({ code: "writer", verdict: "FAIL" });
    expect(rs[0]!.detail).toMatch(/read-only transaction/);
    // the savepoint kept the rest of the run alive
    expect(rs.filter((r) => r.verdict === "FAIL").map((r) => r.code)).toEqual(["writer"]);
    expect(await rowCounts(db)).toBe(before);
  });
});
