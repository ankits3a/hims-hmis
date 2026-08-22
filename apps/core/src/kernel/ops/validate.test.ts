import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { asc, gt, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import { AppModule } from "../../app.module";
import { withTx } from "../db/client";
import { configValidationReports, events, roles } from "../db/schema";
import { loadConfig, requireEnv } from "../config";
import { createUser } from "../auth/identity";
import { createSession } from "../auth/sessions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { updateService, upsertAdjustmentRule, upsertGstSettings } from "../../modules/tariff";
import { ModeError, changeOperatingMode, getOperatingMode } from "./mode";
import { configValidated } from "./events";
import { OPS_DOWNTIME_GENERATE, OPS_INTERFACE_MANAGE, OPS_MODE_SET, opsManifest } from "./manifest";
import { CA_SIGNATURE_MISSING, getLatestValidationReport, runConfigValidation } from "./validate";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import type { ScopeResult } from "./validate";

/**
 * PLAN 11c T2 — `runConfigValidation`, the D-17 aggregate (D5), and the ops HTTP surface.
 *
 * Book rows proved here: **V7** (the aggregate is red when ANY scope is red, and the PERSISTED row
 * records which) and **V8**'s writer half (a newer red report supersedes an older green one, and
 * the commissioning exit reads the LATEST row). Flag **⑦** — §3.42's two-actor permission sweep —
 * is the HTTP describe at the bottom.
 *
 * EVERY INSTANT IN THE SERVICE SUITE DERIVES FROM `NOW` (GC8/§3.31); the HTTP suite cannot inject
 * one, because `POST /ops/mode` deliberately refuses to accept an instant from a caller who could
 * then choose one at which a stale report is still fresh — see the route's own comment.
 */
const NOW = new Date("2026-08-23T09:00:00.000Z");
const DUTY: Actor = { type: "user", id: "01HDUTYMANAGER000000000002" };

/**
 * THE ALL-GREEN FIXTURE, AND WHY IT IS NOT JUST `seedBillingBase`.
 *
 * Verified by execution: NO SHIPPED FIXTURE MAKES THIS AGGREGATE GREEN. `seedBillingBase` seeds a
 * complete billing + tariff context but only ONE of the four `DISCOUNT_CATEGORIES` manual caps
 * (`CAP-CHARITY`), so `validateTariffConfig` returns three `manual_caps_missing` errors; and it
 * calls `upsertGstSettings(..., { caSigned: false })`, which D5's tariff leg (`ok && caSigned`)
 * reads as red even once the caps are complete. Tariff's own suite has a `seedFullValidConfig` that
 * closes both gaps — it is file-local and not exported, so this rebuilds those two steps here.
 *
 * Both steps go through the OWNING module's public API (`upsertAdjustmentRule`, `upsertGstSettings`)
 * — never a hand-rolled insert into tariff's tables (spec §4 module isolation, the `seedBillingBase`
 * convention).
 */
async function seedGreenConfig(db: Db): Promise<{ consultNewServiceId: string; actor: Actor }> {
  const base = await seedBillingBase(db);
  await withTx(db, async (tx) => {
    for (const discountCategory of ["scheme", "negotiated_corporate", "employee"] as const) {
      await upsertAdjustmentRule(tx, base.drafter, {
        ruleKey: `CAP-${discountCategory.toUpperCase()}`,
        sourceKey: "manual",
        title: `${discountCategory} discount cap`,
        params: { discountCategory, maxBps: 5000, approvalAboveBps: 3000 },
      });
    }
    // The CA sign-off. Without it the tariff leg is red however complete the configuration is —
    // which is V7's whole point, and why the green control has to set it explicitly.
    await upsertGstSettings(tx, base.drafter, { caSigned: true });
  });
  return { consultNewServiceId: base.consultNewServiceId, actor: base.drafter };
}

const scopeOf = (scopes: ScopeResult[], scope: "tariff" | "billing"): ScopeResult => {
  const found = scopes.find((s) => s.scope === scope);
  if (found === undefined) throw new Error(`the report carries no "${scope}" scope at all`);
  return found;
};

const codesOf = (s: ScopeResult): string[] => s.errors.map((e) => e.code);

describe("kernel ops — runConfigValidation, the D-17 aggregate (11c D5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  /** The high-water mark of the event log, so a run's OWN appends can be isolated from the fixture's. */
  const eventHighWater = async (): Promise<number> => {
    const rows = await db.select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events);
    return Number(rows[0]?.seq ?? 0);
  };
  const eventNamesSince = async (seq: number): Promise<string[]> => {
    const rows = await db
      .select({ name: events.name })
      .from(events)
      .where(gt(events.seq, seq))
      .orderBy(asc(events.seq));
    return rows.map((r) => r.name);
  };

  const persistedReports = async (): Promise<{ id: string; ok: boolean; scopes: ScopeResult[] }[]> => {
    const rows = await db
      .select({ id: configValidationReports.id, ok: configValidationReports.ok, scopes: configValidationReports.scopes })
      .from(configValidationReports)
      .orderBy(asc(configValidationReports.seq));
    return rows.map((r) => ({ id: r.id, ok: r.ok, scopes: r.scopes as ScopeResult[] }));
  };

  // ───────────────── the green control — flag ①'s positive direction, in-process ─────────────────

  it("green control: every scope ok, the verdict persisted, and ops.config_validated appended", async () => {
    await seedGreenConfig(db);

    const report = await runConfigValidation(db, NOW);

    expect(report.ok).toBe(true);
    expect(scopeOf(report.scopes, "tariff")).toEqual({ scope: "tariff", ok: true, caSigned: true, errors: [] });
    expect(scopeOf(report.scopes, "billing")).toEqual({ scope: "billing", ok: true, caSigned: null, errors: [] });

    // The ROW is the record the go-live gate reads — not the return value.
    const rows = await persistedReports();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(report.reportId);
    expect(rows[0]!.ok).toBe(true);
    expect(scopeOf(rows[0]!.scopes, "tariff").ok).toBe(true);
    expect(scopeOf(rows[0]!.scopes, "billing").ok).toBe(true);
    expect(await getLatestValidationReport(db)).toMatchObject({ id: report.reportId, ok: true, at: NOW });
  });

  it("the aggregate appends ops.config_validated ONLY — never tariff's config.validated, and nothing for billing", async () => {
    await seedGreenConfig(db);
    const before = await eventHighWater();

    const report = await runConfigValidation(db, NOW);

    // The exhaustive statement, not a `not.toContain`: exactly one event, and it is ours. Tariff's
    // `config.validated` carries `scope: z.literal("tariff")` and widening a shipped module's
    // catalog for an aggregate would be scope creep; billing's catalog is closed and emits nothing.
    expect(await eventNamesSince(before)).toEqual(["ops.config_validated"]);
    expect(configValidated.name).toBe("ops.config_validated");
    expect(configValidated.module).toBe("ops");

    const rows = await db.select().from(events).where(gt(events.seq, before));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("ops");
    expect(rows[0]!.eventId).toBe(report.eventId);
    expect(rows[0]!.patientId).toBeNull(); // GC6 — a configuration verdict is a hospital-wide fact
    expect(rows[0]!.payload).toEqual({
      reportId: report.reportId,
      ok: true,
      scopes: [
        { scope: "tariff", ok: true, errorCount: 0 },
        { scope: "billing", ok: true, errorCount: 0 },
      ],
    });
  });

  // ───────────────────────────────────────── V7 ─────────────────────────────────────────

  /**
   * V7. The discriminating input the Book names: **billing configuration valid, tariff
   * `caSigned=false`** — so `validateTariffConfig`'s OWN `ok` is `true` and only D5's conjunction
   * makes the aggregate red. An implementation that hardcodes the tariff leg ok, or that reads
   * `tariff.ok` and forgets `caSigned`, passes every other fixture in this file and fails this one.
   */
  it("V7: tariff ok but UNSIGNED makes the aggregate red, and the persisted row records WHICH scope", async () => {
    await seedGreenConfig(db);
    // Back to unsigned — the only difference from the green control above.
    await withTx(db, (tx) => upsertGstSettings(tx, DUTY, { caSigned: false }));

    const report = await runConfigValidation(db, NOW);

    expect(report.ok).toBe(false);
    const tariff = scopeOf(report.scopes, "tariff");
    expect(tariff.ok).toBe(false);
    expect(tariff.caSigned).toBe(false);
    expect(codesOf(tariff)).toEqual([CA_SIGNATURE_MISSING]);
    // …and the OTHER scope stays green, which is what makes this a per-scope report rather than a
    // single boolean with a label on it.
    expect(scopeOf(report.scopes, "billing").ok).toBe(true);

    // THE PERSISTED ROW, not the return value: this is what the gate and the incident review read.
    const rows = await persistedReports();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
    expect(scopeOf(rows[0]!.scopes, "tariff").ok).toBe(false);
    expect(codesOf(scopeOf(rows[0]!.scopes, "tariff"))).toEqual([CA_SIGNATURE_MISSING]);
    expect(scopeOf(rows[0]!.scopes, "billing").ok).toBe(true);
  });

  it("V7, the other direction: a red BILLING scope alone is enough, with tariff still green", async () => {
    const { consultNewServiceId, actor } = await seedGreenConfig(db);
    // Deactivating the charge-rule service is red for BILLING (`charge_rule_service_inactive`) and
    // invisible to TARIFF, which only validates ACTIVE services. One change, one red scope.
    await withTx(db, (tx) => updateService(tx, actor, consultNewServiceId, { active: false }));

    const report = await runConfigValidation(db, NOW);

    expect(report.ok).toBe(false);
    expect(scopeOf(report.scopes, "tariff").ok).toBe(true);
    const billing = scopeOf(report.scopes, "billing");
    expect(billing.ok).toBe(false);
    expect(codesOf(billing)).toContain("charge_rule_service_inactive");
    expect(billing.caSigned).toBeNull(); // billing HAS a ca_signed column; its validator does not gate on it

    const rows = await persistedReports();
    expect(rows[0]!.ok).toBe(false);
    expect(scopeOf(rows[0]!.scopes, "billing").ok).toBe(false);
  });

  it("an unconfigured deployment is red in BOTH scopes, and the aggregate still returns rather than throwing", async () => {
    // No fixture at all. `validateBillingConfig` reports the missing 'main' row as an error rather
    // than throwing (it catches `loadBillingConfig`'s BillingError and returns early), so the
    // aggregate is a verdict here and not an exception — which is what lets `validate:config`
    // print a worklist on a virgin database instead of a stack trace.
    const report = await runConfigValidation(db, NOW);

    expect(report.ok).toBe(false);
    expect(codesOf(scopeOf(report.scopes, "billing"))).toContain("billing_not_configured");
    expect(codesOf(scopeOf(report.scopes, "tariff"))).toContain("version_not_active");
    expect(codesOf(scopeOf(report.scopes, "tariff"))).toContain(CA_SIGNATURE_MISSING);
    expect((await persistedReports())[0]!.ok).toBe(false);
  });

  // ───────────────────────────────────────── V8 ─────────────────────────────────────────

  /**
   * V8 (Assertion Book **P**), the WRITER half — T1's `mode.test.ts` proves the guard against
   * hand-seeded rows; this proves it against rows THIS FILE'S function actually wrote.
   *
   * The discriminating input: an OLDER ok=true report, then a NEWER ok=false one. A guard that
   * holds a value in memory, or that asks "does any ok report exist?", finds the first row and
   * lets the hospital go live on a configuration that has since been superseded by a red verdict.
   * The shipped guard reads the LATEST row by `seq` and refuses.
   */
  it("V8: a newer RED report supersedes an older green one and the commissioning exit is refused", async () => {
    const { consultNewServiceId, actor } = await seedGreenConfig(db);

    const green = await runConfigValidation(db, NOW);
    expect(green.ok).toBe(true);

    await withTx(db, (tx) => updateService(tx, actor, consultNewServiceId, { active: false }));
    const red = await runConfigValidation(db, new Date(NOW.getTime() + 60_000));
    expect(red.ok).toBe(false);

    // Both rows are present — the green one was NOT deleted, superseded, or updated in place. That
    // is the fixture proof: "any ok row" is still findable, and the guard must still refuse.
    const rows = await persistedReports();
    expect(rows.map((r) => r.ok)).toEqual([true, false]);

    expect(await getOperatingMode(db)).toBe("commissioning");
    let refusal: { code: string; detail: string | undefined } | { resolvedTo: string };
    try {
      const result = await withTx(db, (tx) => changeOperatingMode(tx, DUTY, { to: "normal" }, NOW));
      refusal = { resolvedTo: result.to };
    } catch (e) {
      if (!(e instanceof ModeError)) throw e;
      refusal = { code: e.code, detail: e.detail };
    }
    expect(refusal).toEqual({ code: "golive_gate_unsatisfied", detail: "report_not_ok" });
    expect(await getOperatingMode(db)).toBe("commissioning");

    // THE CONTROL, without which the assertion above would also pass against a gate that refuses
    // everything: fix the configuration, run the aggregate again, and the exit opens.
    await withTx(db, (tx) => updateService(tx, actor, consultNewServiceId, { active: true }));
    const greenAgain = await runConfigValidation(db, new Date(NOW.getTime() + 120_000));
    expect(greenAgain.ok).toBe(true);
    const result = await withTx(db, (tx) => changeOperatingMode(tx, DUTY, { to: "normal" }, NOW));
    expect(result).toMatchObject({ from: "commissioning", to: "normal", reportId: greenAgain.reportId });
    expect(await getOperatingMode(db)).toBe("normal");
  });
});

// ═══════════════════════════════ the ops HTTP surface (flag ⑦) ═══════════════════════════════

describe("kernel ops — the HTTP surface and its permission binding (11c T2, flag ⑦)", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  /** Holds `ops.mode.set`. */
  let dutyToken: string;
  /** Holds a role, and a DECLARED ops permission — just not `ops.mode.set`. §3.42's second actor. */
  let bystanderToken: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await teardown();
  });

  const mkUser = async (username: string, roleKey: string): Promise<string> => {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    return token;
  };

  beforeEach(async () => {
    await truncateAll(db);

    // `truncateAll` empties `permissions` and `roles`, so the registry is re-mirrored per test —
    // the `grantCreditExtend` precedent in test/helpers/billing.ts. `grantPermissionToRole` REFUSES
    // any string the registry does not declare, so this also proves the three ops permissions are
    // declared rather than merely referenced by a decorator.
    const registry = new ModuleRegistry();
    registry.install(opsManifest);
    await syncPermissions(db, registry);

    dutyToken = await mkUser("ops_duty_manager", "duty_manager");
    bystanderToken = await mkUser("ops_bystander", "ops_observer");
    await grantPermissionToRole(db, registry, "duty_manager", OPS_MODE_SET);
    // THE SECOND ACTOR IS NOT ROLE-LESS AND NOT PERMISSION-LESS (§3.42). It holds a real, declared
    // ops permission — just not this one. A route decorated with any existing-but-wrong permission
    // string would answer 403 to a role-less user and pass a sweep driven by one; it cannot pass
    // this pair.
    await grantPermissionToRole(db, registry, "ops_observer", OPS_INTERFACE_MANAGE);
  });

  const server = (): ReturnType<INestApplication["getHttpServer"]> => app.getHttpServer();

  // ───────────────────────── ⑦ — the SPECIFIC permission admits, and its absence refuses ─────────

  it("⑦: an actor GRANTED ops.mode.set runs the aggregate and changes the mode", async () => {
    await seedGreenConfig(db);

    const validation = await request(server())
      .post("/ops/config-validation")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({});
    expect(validation.status).toBe(201);
    expect(validation.body.ok).toBe(true);

    const changed = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal" });
    expect(changed.status).toBe(201);
    expect(changed.body).toMatchObject({ from: "commissioning", to: "normal", reportId: validation.body.reportId });

    const view = await request(server()).get("/ops/mode").set("Authorization", `Bearer ${dutyToken}`);
    expect(view.status).toBe(200);
    expect(view.body.mode).toBe("normal");
    expect(typeof view.body.since).toBe("string");
  });

  it("⑦: the SAME KIND of actor WITHOUT ops.mode.set is refused, and the guard names the permission", async () => {
    for (const path of ["/ops/mode", "/ops/config-validation"]) {
      const res = await request(server())
        .post(path)
        .set("Authorization", `Bearer ${bystanderToken}`)
        .send({ to: "normal" });
      // THE MESSAGE, not just the status. A 403 alone would be produced by ANY permission string on
      // the decorator, including a wrong one — which is exactly what §3.42 says a role-less sweep
      // cannot distinguish.
      expect([path, res.status, res.body.message]).toEqual([path, 403, `missing permission ${OPS_MODE_SET}`]);
    }
  });

  it("⑦'s complement: the two READS are authenticated-only — the bystander may read, an anonymous caller may not", async () => {
    const mode = await request(server()).get("/ops/mode").set("Authorization", `Bearer ${bystanderToken}`);
    expect(mode.status).toBe(200);
    expect(mode.body).toEqual({ mode: "commissioning", since: null, note: null, reportId: null });

    const latest = await request(server())
      .get("/ops/config-validation/latest")
      .set("Authorization", `Bearer ${bystanderToken}`);
    expect(latest.status).toBe(200);
    expect(latest.body).toEqual({ report: null });

    expect((await request(server()).get("/ops/mode")).status).toBe(401);
    expect((await request(server()).get("/ops/config-validation/latest")).status).toBe(401);
  });

  it("GET /ops/config-validation/latest returns the newest persisted verdict, per-scope", async () => {
    const report = await runConfigValidation(db, NOW); // unconfigured → red in both scopes
    const res = await request(server())
      .get("/ops/config-validation/latest")
      .set("Authorization", `Bearer ${bystanderToken}`);
    expect(res.status).toBe(200);
    expect(res.body.report.id).toBe(report.reportId);
    expect(res.body.report.ok).toBe(false);
    expect(res.body.report.scopes.map((s: ScopeResult) => s.scope)).toEqual(["tariff", "billing"]);
  });

  // ───────────────────────── the refusals T5's mode desk has to render ─────────────────────────

  it("the mode route surfaces the refusal CODE and its detail, not just a status", async () => {
    const gated = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal" });
    expect(gated.status).toBe(409);
    expect(gated.body).toMatchObject({ code: "golive_gate_unsatisfied", detail: "no_report" });

    const noNote = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "downtime" });
    expect(noNote.status).toBe(400);
    expect(noNote.body).toMatchObject({ code: "mode_note_required", detail: null });

    const initialOnly = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "commissioning" });
    expect(initialOnly.status).toBe(400);
    expect(initialOnly.body).toMatchObject({ code: "mode_commissioning_is_initial_only" });

    const nonsense = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "sideways" });
    expect(nonsense.status).toBe(400);
  });

  // ─────────────────────────────────── the §4 manifest ───────────────────────────────────

  it("opsManifest declares all three permissions now — including the two whose routes ship in later waves", () => {
    expect(opsManifest.permissions).toEqual([OPS_MODE_SET, OPS_DOWNTIME_GENERATE, OPS_INTERFACE_MANAGE]);
    expect(opsManifest.subscriptions).toEqual([]); // ops.mode_changed's subscription belongs to alertsManifest
    expect(opsManifest.menu.map((m) => [m.path, m.permission])).toEqual([
      ["/ops/mode", OPS_MODE_SET],
      ["/ops/downtime-kit", OPS_DOWNTIME_GENERATE],
    ]);
  });
});
