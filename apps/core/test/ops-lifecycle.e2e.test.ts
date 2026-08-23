import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { asc, eq, gt, sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedBillingBase } from "./helpers/billing";
import { withTx } from "../src/kernel/db/client";
import { events, interfaces, roles } from "../src/kernel/db/schema";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { upsertAdjustmentRule, upsertGstSettings } from "../src/modules/tariff";
import { alertsConsumer } from "../src/kernel/alerts/consumer";
import { sweepInterfaceHeartbeats } from "../src/kernel/ops/interfaces";
import {
  OPS_DOWNTIME_GENERATE, OPS_INTERFACE_MANAGE, OPS_MODE_SET, opsManifest,
} from "../src/kernel/ops/manifest";
import { KIT_QR_PREFIX, verifyKitSerial } from "../src/kernel/ops/downtime-kit";
import type { Db } from "../src/kernel/db/client";
import type { DispatchedEvent } from "../src/kernel/events/subscriptions";
import type { DowntimeKitRange, DowntimeKitView, KitPrintPayload } from "../src/kernel/ops/downtime-kit";

/**
 * PLAN 11c T4 — THE WHOLE PLAN OVER HTTP, IN ONE STORY (Task 4's own e2e).
 *
 * Nine legs, in the order a hospital actually lives them: a freshly-migrated deployment that
 * refuses to open, the go-live gate satisfied, the doors opened, the power failing, the paper kit
 * issued, a printer going quiet and coming back, and the hospital recovering. Every leg is driven
 * through the HTTP surface T2, T3 and T4 shipped; the two things that are NOT HTTP surfaces — the
 * alerts consumer and the interface staleness sweep — are invoked exactly the way production
 * invokes them (the dispatcher's projected event; the worker's job function), because inventing an
 * HTTP route for either would be testing something the product does not have.
 *
 * ═══ THERE IS NO `beforeEach`/`truncateAll` BETWEEN THE LEGS, AND THAT IS THE POINT ═══
 *
 * The state each leg leaves is the state the next one starts from — the `billing-lifecycle`
 * precedent. A suite that reset between legs would be nine unit tests wearing an e2e's name, and
 * the serial-continuity leg in particular (kit B starts where kit A ended) has no meaning without
 * the accumulated history.
 *
 * ═══ `now` IS INJECTED WHERE IT CAN BE, AND THERE IS NO SLEEP ANYWHERE ═══
 *
 * `POST /ops/mode`, `POST /ops/downtime-kits` and `POST /ops/interfaces/:id/heartbeat` all REFUSE
 * an instant from the caller, deliberately and for stated reasons (a caller who chose the instant
 * could choose one at which a stale validation report is still fresh, or report a heartbeat from
 * the future and never be swept again). So the staleness leg does not fake time and does not
 * sleep: it reads back the heartbeat instant the SERVER recorded and hands
 * `sweepInterfaceHeartbeats` a `now` derived from THAT — the row's own `last_seen_at` plus its own
 * `stale_after_ms` — which is the sweep's injected-clock seam (GC8) used as designed. Nothing in
 * this file derives a fixture from the wall clock (§3.31).
 *
 * ═══ FLAG ③ ═══
 *
 * The kit payload this file asserts — serials and QR strings — is exactly what T5's `.print-doc`
 * screen renders next wave. THAT REAL PAPER COMES OUT OF A REAL PRINTER IS OWNER UAT and no test
 * in this repository can discharge it; what is discharged here is that the payload exists, that
 * every serial in it is unique, and that every QR verifies under the kernel key.
 */

/** The signing key the API itself uses — the same `CONFIG.secretKey` the kit route signs with. */
const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

const DOWNTIME_NOTE = "Grid down and the UPS did not hold — both desks are on paper";
const RECOVERY_NOTE = "Power restored, backfill in progress";

type ModeView = { mode: string; since: string | null; note: string | null; reportId: string | null };
type KitResult = DowntimeKitView & { eventId: string };

describe("ops lifecycle e2e (HTTP) — commissioning to downtime to recovery", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;

  /** Holds all three ops permissions — the duty manager of map 1's protocol. */
  let dutyToken: string;
  /** Holds a REAL, DECLARED ops permission — just not `ops.downtime.generate` (§3.42). */
  let bystanderToken: string;
  /** An owner-role holder with a live session, so D4's alert can be read the way a human reads it. */
  let ownerToken: string;

  /** Carried between legs. */
  let greenReportId: string;
  let kitA: KitResult;
  let kitB: KitResult;
  let printerId: string;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    await truncateAll(db);

    // `truncateAll` empties `permissions` and `roles`, so the registry is re-mirrored here — the
    // `grantCreditExtend` precedent. `grantPermissionToRole` REFUSES any string the registry does
    // not declare, so these grants also prove the three ops permissions are DECLARED and not
    // merely referenced by a decorator.
    const registry = new ModuleRegistry();
    registry.install(opsManifest);
    await syncPermissions(db, registry);

    dutyToken = await mkUser("ops_lifecycle_duty", "duty_manager");
    bystanderToken = await mkUser("ops_lifecycle_bystander", "ops_observer");
    ownerToken = await mkUser("ops_lifecycle_owner", "owner");

    for (const permission of [OPS_MODE_SET, OPS_DOWNTIME_GENERATE, OPS_INTERFACE_MANAGE]) {
      await grantPermissionToRole(db, registry, "duty_manager", permission);
    }
    // The second actor is neither role-less nor permission-less: it holds a real ops permission,
    // just not the one the kit routes require. A decorator carrying ANY existing-but-wrong
    // permission string would pass a role-less sweep; it cannot pass this pair.
    await grantPermissionToRole(db, registry, "ops_observer", OPS_INTERFACE_MANAGE);
  });

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  const server = (): ReturnType<INestApplication["getHttpServer"]> => app.getHttpServer();

  async function mkUser(username: string, roleKey: string): Promise<string> {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    await db.insert(roles).values({ key: roleKey, title: roleKey }).onConflictDoNothing();
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    return token;
  }

  const eventHighWater = async (): Promise<number> => {
    const rows = await db.select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` }).from(events);
    return Number(rows[0]?.seq ?? 0);
  };
  const eventNamesSince = async (seq: number): Promise<string[]> => {
    const rows = await db.select({ name: events.name }).from(events).where(gt(events.seq, seq)).orderBy(asc(events.seq));
    return rows.map((r) => r.name);
  };

  /**
   * Reads a stored event row back into a `DispatchedEvent` exactly as `dispatcher.ts` projects one
   * — `occurredAt` included. The consumer is then handed the same object shape production hands
   * it, and nothing here invents a field the dispatcher does not project (the `consumer.test.ts`
   * helper, kept local because it is a test-shape concern rather than a shared fixture).
   */
  const readDispatched = async (eventName: string, sinceSeq: number): Promise<DispatchedEvent> => {
    const rows = await db
      .select({
        seq: events.seq,
        eventId: events.eventId,
        name: events.name,
        payload: events.payload,
        patientId: events.patientId,
        correlationId: events.correlationId,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(gt(events.seq, sinceSeq))
      .orderBy(asc(events.seq));
    const row = rows.find((r) => r.name === eventName);
    if (row === undefined) throw new Error(`no ${eventName} event was appended after seq ${sinceSeq}`);
    return {
      seq: Number(row.seq),
      eventId: row.eventId,
      name: row.name,
      payload: row.payload,
      patientId: row.patientId,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
    };
  };

  // ══════════════════ leg 1 — a freshly-migrated deployment refuses to open ══════════════════

  it("leg 1 — commissioning is what zero rows read as, and the exit is REFUSED with no report at all", async () => {
    const view = await request(server()).get("/ops/mode").set("Authorization", `Bearer ${dutyToken}`);
    expect(view.status).toBe(200);
    expect(view.body as ModeView).toEqual({ mode: "commissioning", since: null, note: null, reportId: null });

    const refused = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal" });
    // THE CODE AND THE DETAIL, not merely the status (§3.14b): `no_report` is a different sentence
    // on T5's mode desk from `stale_report` and `report_not_ok`, and a bare 409 proves neither.
    expect([refused.status, refused.body.code, refused.body.detail]).toEqual([
      409, "golive_gate_unsatisfied", "no_report",
    ]);

    // …and the refusal really did leave the hospital where it was.
    const still = await request(server()).get("/ops/mode").set("Authorization", `Bearer ${dutyToken}`);
    expect(still.body.mode).toBe("commissioning");
  });

  it("leg 1b — the aggregate RUNS on an unconfigured deployment and answers 201 with ok:false, never a 5xx", async () => {
    const res = await request(server())
      .post("/ops/config-validation")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({});
    // The run succeeded; the CONFIGURATION did not. A missing `billing_config` row arrives as a
    // CODE inside a returned report — `validateBillingConfig` accumulates and never throws — which
    // is the distinction a 4xx here would destroy.
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(false);
    const codes: string[] = res.body.scopes.flatMap((s: { errors: { code: string }[] }) => s.errors.map((e) => e.code));
    expect(codes).toContain("billing_not_configured");

    // A red report is not a way through the gate either — V8's shape, over HTTP.
    const refused = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal" });
    expect([refused.status, refused.body.code, refused.body.detail]).toEqual([
      409, "golive_gate_unsatisfied", "report_not_ok",
    ]);
  });

  // ══════════════════════ leg 2 — the configuration is made valid, and it ════════════════════
  //                                 takes THREE steps, not one

  it("leg 2 — a valid configuration is seeded and POST /ops/config-validation turns green", async () => {
    // THE FIXTURE IS `seedBillingBase` PLUS TWO STEPS, and without them this whole chain is
    // unreachable (verified at compile time, recorded in the plan's findings inbox):
    //   1. `seedBillingBase` seeds ONE of the four DISCOUNT_CATEGORIES manual caps (`CAP-CHARITY`),
    //      so `validateTariffConfig` returns three `manual_caps_missing` errors;
    //   2. it calls `upsertGstSettings(..., { caSigned: false })`, and D5's tariff leg is
    //      `ok && caSigned`.
    // Both are closed here through the OWNING module's public API — never a hand-rolled insert
    // into tariff's tables (spec §4 module isolation).
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
      await upsertGstSettings(tx, base.drafter, { caSigned: true });
    });

    const res = await request(server())
      .post("/ops/config-validation")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(
      res.body.scopes.map((s: { scope: string; ok: boolean; errors: unknown[] }) => [s.scope, s.ok, s.errors.length]),
    ).toEqual([["tariff", true, 0], ["billing", true, 0]]);
    greenReportId = res.body.reportId;

    const latest = await request(server())
      .get("/ops/config-validation/latest")
      .set("Authorization", `Bearer ${bystanderToken}`);
    expect(latest.status).toBe(200);
    expect([latest.body.report.id, latest.body.report.ok]).toEqual([greenReportId, true]);
  });

  // ═══════════════════════════════ leg 3 — the doors open ════════════════════════════════════

  it("leg 3 — commissioning → normal, and the row records WHICH report authorised it", async () => {
    const res = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal" });
    expect(res.status).toBe(201);
    // `reportId` is filled by the GUARD from the report it read, never by the caller — so this
    // being the green report's id is the row proving the gate was actually consulted.
    expect(res.body).toMatchObject({ from: "commissioning", to: "normal", note: null, reportId: greenReportId });

    const view = await request(server()).get("/ops/mode").set("Authorization", `Bearer ${dutyToken}`);
    expect(view.body.mode).toBe("normal");
    expect(typeof view.body.since).toBe("string");
    expect(view.body.reportId).toBe(greenReportId);
  });

  // ═════════════════ leg 4 — the power fails, and a human is woken up for it ═════════════════

  it("leg 4 — downtime is declared WITH a note, and the alerts fabric puts a row in front of every owner", async () => {
    const before = await eventHighWater();

    const noNote = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "downtime" });
    expect([noNote.status, noNote.body.code]).toEqual([400, "mode_note_required"]);

    const declared = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "downtime", note: DOWNTIME_NOTE });
    expect(declared.status).toBe(201);
    expect(declared.body).toMatchObject({ from: "normal", to: "downtime", note: DOWNTIME_NOTE, reportId: null });

    expect(await eventNamesSince(before)).toEqual(["ops.mode_changed"]);

    // The consumer, driven the way the dispatcher drives it. `alertsManifest` subscribes
    // `kernel.alerts` to `ops.mode_changed` (T1/D4); the worker is not booted in this suite, so
    // the projection is done here rather than waited for — which is also why there is no sleep.
    const dispatched = await readDispatched("ops.mode_changed", before);
    await alertsConsumer(db)(dispatched);

    const inbox = await request(server()).get("/alerts").set("Authorization", `Bearer ${ownerToken}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.items).toHaveLength(1);
    expect(inbox.body.items[0]).toMatchObject({
      kind: "operating_mode",
      title: "Operating mode: normal → downtime",
      body: DOWNTIME_NOTE,
      refType: "operating_mode",
      refId: "downtime",
      readAt: null,
    });
    expect(inbox.body.unreadCount).toBe(1);

    // Idempotent on redelivery (D4 is at-least-once): the same event twice adds no second row.
    await alertsConsumer(db)(dispatched);
    const again = await request(server()).get("/alerts").set("Authorization", `Bearer ${ownerToken}`);
    expect(again.body.items).toHaveLength(1);

    // The bystander holds no owner role and therefore learns nothing — an alert is a per-user row.
    const bystanderInbox = await request(server()).get("/alerts").set("Authorization", `Bearer ${bystanderToken}`);
    expect([bystanderInbox.status, bystanderInbox.body.items.length]).toEqual([200, 0]);
  });

  // ══════════════════════ leg 5 — the paper goes out to the desks (D7) ═══════════════════════

  it("leg 5 — the kit routes require ops.downtime.generate, and the guard names it", async () => {
    for (const [method, path] of [
      ["post", "/ops/downtime-kits"],
      ["get", "/ops/downtime-kits"],
      ["get", "/ops/downtime-kits/01HNOSUCHKIT00000000000000"],
    ] as const) {
      const res = await (method === "post"
        ? request(server()).post(path).send({ desks: [{ desk: "d", counts: { registration: 1 } }] })
        : request(server()).get(path)
      ).set("Authorization", `Bearer ${bystanderToken}`);
      // THE MESSAGE, not just the status: a 403 alone would be produced by ANY permission string
      // on the decorator, including a wrong one (§3.42).
      expect([path, res.status, res.body.message]).toEqual([
        path, 403, `missing permission ${OPS_DOWNTIME_GENERATE}`,
      ]);
    }
  });

  it("leg 5b — a kit is generated over HTTP, its ranges are disjoint, and a second kit continues them", async () => {
    const before = await eventHighWater();

    const resA = await request(server())
      .post("/ops/downtime-kits")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({
        note: DOWNTIME_NOTE,
        desks: [
          { desk: "front-desk", counts: { registration: 6, consultation: 4, receipt: 6 } },
          { desk: "billing-desk", counts: { receipt: 4 } },
        ],
      });
    expect(resA.status).toBe(201);
    kitA = resA.body as KitResult;
    expect(kitA.totalForms).toBe(20);
    expect(await eventNamesSince(before)).toEqual(["downtime.kit_generated"]);

    // Every range in the kit, pairwise disjoint WITHIN a form kind (V13's invariant, asserted here
    // on the shape a real generation produces rather than under contention).
    expectPairwiseDisjoint(kitA.ranges);
    // …and the two desks' receipt ranges really do abut: 6 sheets then 4, no gap.
    const frontReceipt = pick(kitA.ranges, "front-desk", "receipt");
    const billingReceipt = pick(kitA.ranges, "billing-desk", "receipt");
    expect([frontReceipt.startSerial, frontReceipt.endSerial, billingReceipt.startSerial, billingReceipt.endSerial])
      .toEqual([1, 6, 7, 10]);

    const resB = await request(server())
      .post("/ops/downtime-kits")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ note: "second shift", desks: [{ desk: "front-desk", counts: { registration: 5 } }] });
    expect(resB.status).toBe(201);
    kitB = resB.body as KitResult;

    // V14 over HTTP: kit B's registration starts one past where kit A's ended.
    const aReg = pick(kitA.ranges, "front-desk", "registration");
    const bReg = pick(kitB.ranges, "front-desk", "registration");
    expect([aReg.startSerial, aReg.endSerial, bReg.startSerial, bReg.endSerial]).toEqual([1, 6, 7, 11]);
    expectPairwiseDisjoint([...kitA.ranges, ...kitB.ranges]);

    const list = await request(server()).get("/ops/downtime-kits").set("Authorization", `Bearer ${dutyToken}`);
    expect(list.status).toBe(200);
    expect(list.body.kits.map((k: DowntimeKitView) => k.id)).toEqual([kitB.id, kitA.id]); // newest first
  });

  it("leg 5c — flag ③: every sheet in the kit carries a QR that verifies under the kernel key, and a tampered one does not", async () => {
    const res = await request(server())
      .get(`/ops/downtime-kits/${kitA.id}`)
      .set("Authorization", `Bearer ${dutyToken}`);
    expect(res.status).toBe(200);
    const payload = res.body as KitPrintPayload;
    expect([payload.kitId, payload.note, payload.totalForms]).toEqual([kitA.id, DOWNTIME_NOTE, 20]);

    // Twenty sheets, twenty distinct (kind, serial) pairs, twenty QRs that verify. This IS the
    // payload T5's print screen renders; that ink reaches paper is owner UAT (flag ③).
    const seen: string[] = [];
    for (const range of payload.ranges) {
      expect(range.forms).toHaveLength(range.count);
      for (const form of range.forms) {
        expect(form.qr.startsWith(`${KIT_QR_PREFIX}.${kitA.id}.${range.formKind}.${form.serial}.`)).toBe(true);
        expect(verifyKitSerial(cfg.secretKey, form.qr)).toEqual({
          kitId: kitA.id,
          formKind: range.formKind,
          serial: form.serial,
        });
        seen.push(`${range.formKind}#${form.serial}`);
      }
    }
    expect([seen.length, new Set(seen).size]).toEqual([20, 20]);

    // The tamper, over the wire: one serial digit changed to another serial that REALLY EXISTS in
    // this kit and kind, signature untouched. Only the mac can reject it.
    const sample = payload.ranges[0]!.forms[0]!;
    const parts = sample.qr.split(".");
    const tampered = [parts[0], parts[1], parts[2], String(sample.serial + 1), parts[4]].join(".");
    expect(tampered).not.toBe(sample.qr);
    expect(verifyKitSerial(cfg.secretKey, tampered)).toBeNull();

    // An unknown kit is a 404, not an empty kit.
    const missing = await request(server())
      .get("/ops/downtime-kits/01HNOSUCHKIT00000000000000")
      .set("Authorization", `Bearer ${dutyToken}`);
    expect([missing.status, missing.body.code]).toEqual([404, "downtime_kit_not_found"]);
  });

  // ═════════════ leg 6 — a device goes quiet under the sweep, and comes back (D6) ════════════

  it("leg 6 — an interface is registered, heartbeats, is DOWNED by the sweep, and is RESTORED by the next beat", async () => {
    const registered = await request(server())
      .post("/ops/interfaces")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ kind: "printer", name: "front-desk label printer", location: "OPD", staleAfterMs: 30_000 });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ status: "unknown", lastSeenAt: null, active: true });
    printerId = registered.body.id;

    // Never seen is NOT down (Book V10): a sweep run now must leave it alone and append nothing.
    const beforeFirstSweep = await eventHighWater();
    expect(await sweepInterfaceHeartbeats(db, new Date("2099-01-01T00:00:00.000Z"))).toEqual([]);
    expect(await eventNamesSince(beforeFirstSweep)).toEqual([]);

    const beat = await request(server())
      .post(`/ops/interfaces/${printerId}/heartbeat`)
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({});
    expect(beat.status).toBe(201);
    expect(beat.body).toMatchObject({ status: "up", restored: false, eventId: null }); // unknown→up is silent

    // THE SWEEP'S `now` IS DERIVED FROM THE ROW THE SERVER WROTE, never from the wall clock and
    // never from a sleep: the heartbeat route refuses an injected instant, so the only honest
    // reference point is the `last_seen_at` it recorded.
    const seen = await lastSeenAt(printerId);
    const past = new Date(seen.getTime() + 30_000 + 1_000);

    const beforeDown = await eventHighWater();
    const downed = await sweepInterfaceHeartbeats(db, past);
    expect(downed.map((d) => d.interfaceId)).toEqual([printerId]);
    expect(await eventNamesSince(beforeDown)).toEqual(["interface.down"]);

    const listed = await request(server()).get("/ops/interfaces").set("Authorization", `Bearer ${dutyToken}`);
    expect(listed.body.interfaces.find((i: { id: string }) => i.id === printerId)).toMatchObject({ status: "down" });

    const beforeRestore = await eventHighWater();
    const again = await request(server())
      .post(`/ops/interfaces/${printerId}/heartbeat`)
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({});
    expect(again.body).toMatchObject({ status: "up", restored: true });
    expect(typeof again.body.eventId).toBe("string");
    expect(await eventNamesSince(beforeRestore)).toEqual(["interface.restored"]);

    // Idempotence of the loud edge: a second beat is `up → up` and says nothing at all.
    const beforeQuiet = await eventHighWater();
    const third = await request(server())
      .post(`/ops/interfaces/${printerId}/heartbeat`)
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({});
    expect(third.body).toMatchObject({ status: "up", restored: false, eventId: null });
    expect(await eventNamesSince(beforeQuiet)).toEqual([]);
  });

  // ════════════════════════════ leg 7 — the hospital recovers ════════════════════════════════

  it("leg 7 — downtime → normal, ungated, and the whole story is on the mode ledger in order", async () => {
    const recovered = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal", note: RECOVERY_NOTE });
    expect(recovered.status).toBe(201);
    // No gate on this one: only the exit from `commissioning` is gated, so `reportId` is null.
    expect(recovered.body).toMatchObject({ from: "downtime", to: "normal", note: RECOVERY_NOTE, reportId: null });

    const view = await request(server()).get("/ops/mode").set("Authorization", `Bearer ${dutyToken}`);
    expect(view.body as ModeView).toMatchObject({ mode: "normal", note: RECOVERY_NOTE, reportId: null });

    // A no-op is refused, so the ledger never carries a change that changed nothing.
    const unchanged = await request(server())
      .post("/ops/mode")
      .set("Authorization", `Bearer ${dutyToken}`)
      .send({ to: "normal", note: "again" });
    expect([unchanged.status, unchanged.body.code]).toEqual([409, "mode_unchanged"]);

    // The whole run's event stream, in order — the story this file told, as the log recorded it.
    const names = await eventNamesSince(0);
    expect(names.filter((n) => n.startsWith("ops.") || n.startsWith("downtime.") || n.startsWith("interface."))).toEqual([
      "ops.config_validated", // leg 1b — the red run on an unconfigured deployment
      "ops.config_validated", // leg 2  — the green run
      "ops.mode_changed", // leg 3 — commissioning → normal
      "ops.mode_changed", // leg 4 — normal → downtime
      "downtime.kit_generated", // leg 5b — kit A
      "downtime.kit_generated", // leg 5b — kit B
      "interface.down", // leg 6
      "interface.restored", // leg 6
      "ops.mode_changed", // leg 7 — downtime → normal
    ]);
  });

  // ────────────────────────────────────── helpers ──────────────────────────────────────────

  async function lastSeenAt(id: string): Promise<Date> {
    const rows = await db.select({ lastSeenAt: interfaces.lastSeenAt }).from(interfaces).where(eq(interfaces.id, id));
    const value = rows[0]?.lastSeenAt;
    if (value === undefined || value === null) throw new Error(`interface ${id} has never been seen`);
    return value;
  }

  function pick(ranges: DowntimeKitRange[], desk: string, formKind: string): DowntimeKitRange {
    const found = ranges.find((r) => r.desk === desk && r.formKind === formKind);
    if (found === undefined) throw new Error(`no ${formKind} range for desk "${desk}"`);
    return found;
  }

  /** Every pair of ranges over the SAME form kind must not intersect. Serials are per kind. */
  function expectPairwiseDisjoint(ranges: DowntimeKitRange[]): void {
    const overlaps: string[] = [];
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        const a = ranges[i]!;
        const b = ranges[j]!;
        if (a.formKind !== b.formKind) continue;
        if (a.startSerial <= b.endSerial && b.startSerial <= a.endSerial) {
          overlaps.push(
            `${a.formKind}: ${a.desk} [${a.startSerial},${a.endSerial}] overlaps ${b.desk} [${b.startSerial},${b.endSerial}]`,
          );
        }
      }
    }
    expect(overlaps).toEqual([]);
  }
});
