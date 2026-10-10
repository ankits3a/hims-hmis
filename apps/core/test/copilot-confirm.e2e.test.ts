import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.bootstrap";
import { CONFIG } from "../src/kernel/tokens";
import { requireEnv } from "../src/kernel/config";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { copilotActs, events, rolePermissions } from "../src/kernel/db/schema";
import { appendEvent } from "../src/kernel/events/append";
import { COPILOT_EXTRA_TOOLS, argsHash, issueProposal, proposalKey } from "../src/kernel/copilot/act";
import { defineAct } from "../src/kernel/copilot/types";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkUser, seedOpdBase } from "./helpers/opd";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AppConfig } from "../src/kernel/config";
import type { Proposal } from "../src/kernel/copilot/act";
import type { CopilotToolDecl } from "../src/kernel/copilot/types";
import type { Db, Tx } from "../src/kernel/db/client";

/**
 * E0.2 PROPOSE → CONFIRM → ACT OVER HTTP (plan E0.2, decision 0064; spec
 * /opt/hmis-context/SPEC-copilot-confirm-2026-10-11.md — built overnight 2026-10-11, awaiting review).
 *
 * No real write tool exists yet (E2.x adds them), so the protocol is proved with a FIXTURE that
 * books a "slot" by appending an event, injected through `COPILOT_EXTRA_TOOLS` in this file only.
 * The proposal is minted with the app's own key exactly as the ask path mints it (`issueProposal`);
 * no phrasebook intent routes to a fixture, so the ask half is `act.test.ts`'s.
 */
const slotBooked = defineEvent("copilot_fixture.slot_booked", "copilot", z.object({ slot: z.string() }));
const SLOT_EVENT = slotBooked.name;

/** Fault switches the tests flip; reset before each test. */
const fault = { throwAfterWrite: false, readBackFails: false };

const slotTaken = async (tx: Tx | Db, slot: string): Promise<boolean> =>
  (await tx.select({ id: events.eventId }).from(events)
    .where(and(eq(events.name, SLOT_EVENT), sql`${events.payload}->>'slot' = ${slot}`))).length > 0;

const bookSlot: CopilotToolDecl = {
  intent: "fixture_book_slot" as CopilotToolDecl["intent"],
  permission: "opd.queue.read",
  needsSubject: false,
  kind: "act",
  run: () => Promise.resolve({ key: "copilot.answer.actDone", params: {}, propose: { args: { slot: "10:30" } } }),
  act: defineAct<{ slot: string }>({
    args: z.object({ slot: z.string().regex(/^\d\d:\d\d$/) }).strict(),
    recheck: async (tx, args) => ((await slotTaken(tx, args.slot)) ? "copilot.answer.actStateChanged" : null),
    apply: async (tx, args, ctx) => {
      const { eventId } = await appendEvent(tx, slotBooked.make({ actor: ctx.actor, payload: { slot: args.slot } }));
      if (fault.throwAfterWrite) throw new Error("forced failure after the module write");
      return { answer: { key: "copilot.answer.actDone", params: {} }, module: "copilot_fixture", rowId: eventId, subjectPatientId: null };
    },
    verify: {
      readBack: async (tx, _args, result) =>
        !fault.readBackFails && (await tx.select({ id: events.eventId }).from(events).where(eq(events.eventId, result.rowId))).length === 1,
    },
  }),
};

describe("E0.2 — propose → confirm → act", () => {
  let app: INestApplication;
  let db: Db;
  let teardown: () => Promise<void>;
  let key: Buffer;
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);

  let clerk: { id: string; token: string };
  let owner: { id: string; token: string };

  const http = () => request(app.getHttpServer());
  const confirm = (token: string, proposal: unknown) =>
    http().post("/copilot/confirm").set("Authorization", `Bearer ${token}`).send({ proposal }).expect(200);
  const propose = (slot = "10:30"): Proposal =>
    issueProposal(key, bookSlot, { type: "user", id: clerk.id }, { args: { slot } }, null, new Date())!;
  const booked = async () => (await db.select().from(events).where(eq(events.name, SLOT_EVENT))).length;
  const acts = () => db.select().from(copilotActs);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COPILOT_EXTRA_TOOLS).useValue([bookSlot])
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app as NestExpressApplication);
    await app.init();
    key = proposalKey(app.get<AppConfig>(CONFIG).secretKey);
  });

  afterAll(async () => {
    await app.close();
    await teardown();
  });

  beforeEach(async () => {
    fault.throwAfterWrite = false;
    fault.readBackFails = false;
    await truncateAll(db);
    await syncPermissions(db, registry);
    await seedOpdBase(db);
    await createRole(db, "desk", "Desk");
    await grantPermissionToRole(db, registry, "desk", "opd.queue.read");
    await createRole(db, "owner", "Owner");
    for (const p of ["copilot.halt.set", "copilot.halt.clear"]) await grantPermissionToRole(db, registry, "owner", p);
    clerk = await mkUser(db, "confirm_clerk", ["desk"]);
    owner = await mkUser(db, "confirm_owner", ["owner"]);
  });

  it("a confirmed proposal writes the module row and ONE act row, together", async () => {
    const p = propose();
    const res = await confirm(clerk.token, p);
    expect(res.body).toEqual({ outcome: "done", answer: { key: "copilot.answer.actDone", params: {} } });
    expect(await booked()).toBe(1);
    const [act] = await acts();
    const [ev] = await db.select().from(events).where(eq(events.name, SLOT_EVENT));
    expect(act).toMatchObject({
      actorId: clerk.id, tool: "fixture_book_slot", proposalId: p.id, confirmId: `cf_${p.id}`,
      argsHash: argsHash({ slot: "10:30" }), resultModule: "copilot_fixture", resultRowId: ev!.eventId, subjectPatientId: null,
    });
  });

  it("done-means 1: a replayed confirm writes nothing — in sequence and as a concurrent double tap", async () => {
    const p = propose();
    await confirm(clerk.token, p);
    const again = await confirm(clerk.token, p);
    expect(again.body).toMatchObject({ outcome: "alreadyDone", answer: { key: "copilot.answer.actAlreadyDone" } });
    expect(await booked()).toBe(1);
    expect(await acts()).toHaveLength(1);

    // Two taps in flight at once on a fresh slot: one act, one module write, whatever the interleaving.
    const q = propose("11:00");
    const both = await Promise.all([confirm(clerk.token, q), confirm(clerk.token, q)]);
    // The loser lost either at the pre-read / unique index (alreadyDone) or at the recheck (stateChanged).
    expect(both.map((r) => r.body.outcome).filter((o: string) => o !== "done")).toEqual([expect.stringMatching(/^(alreadyDone|stateChanged)$/)]);
    expect(both.filter((r) => r.body.outcome === "done")).toHaveLength(1);
    expect(await acts()).toHaveLength(2);
    expect(await booked()).toBe(2);
  });

  it("done-means 2: an expired proposal refuses and writes nothing", async () => {
    const p = issueProposal(key, bookSlot, { type: "user", id: clerk.id }, { args: { slot: "10:30" } }, null, new Date(Date.now() - 6 * 60_000))!;
    expect((await confirm(clerk.token, p)).body).toMatchObject({ outcome: "expired", answer: { key: "copilot.answer.actExpired" } });
    expect(await booked()).toBe(0);
    expect(await acts()).toHaveLength(0);
  });

  it("done-means 3: args changed after signing refuse and write nothing", async () => {
    const p = { ...propose(), args: { slot: "11:30" } };
    expect((await confirm(clerk.token, p)).body).toMatchObject({ outcome: "invalid", answer: { key: "copilot.answer.actInvalid" } });
    expect(await booked()).toBe(0);
    expect(await acts()).toHaveLength(0);
  });

  it("another user cannot confirm the clerk's proposal", async () => {
    expect((await confirm(owner.token, propose())).body.outcome).toBe("invalid");
    expect(await booked()).toBe(0);
  });

  it("done-means 4: a permission revoked between propose and confirm refuses", async () => {
    const p = propose();
    await db.delete(rolePermissions).where(and(eq(rolePermissions.roleKey, "desk"), eq(rolePermissions.permission, "opd.queue.read")));
    expect((await confirm(clerk.token, p)).body).toMatchObject({ outcome: "notPermitted", answer: { key: "copilot.answer.notPermitted" } });
    expect(await booked()).toBe(0);
    expect(await acts()).toHaveLength(0);
  });

  it("done-means 5: a forced failure after the module write leaves neither the write nor the act row", async () => {
    fault.throwAfterWrite = true;
    expect((await confirm(clerk.token, propose())).body).toMatchObject({ outcome: "failed", answer: { key: "copilot.answer.failed" } });
    expect(await booked()).toBe(0);
    expect(await acts()).toHaveLength(0);

    // The verify step saying the write did not land rolls back the same way.
    fault.throwAfterWrite = false;
    fault.readBackFails = true;
    expect((await confirm(clerk.token, propose())).body.outcome).toBe("failed");
    expect(await booked()).toBe(0);
    expect(await acts()).toHaveLength(0);
  });

  it("done-means 6: the slot taken between propose and confirm refuses and writes nothing more", async () => {
    const mine = propose("10:30");
    const theirs = propose("10:30");
    expect((await confirm(clerk.token, theirs)).body.outcome).toBe("done");
    expect((await confirm(clerk.token, mine)).body).toMatchObject({ outcome: "stateChanged", answer: { key: "copilot.answer.actStateChanged" } });
    expect(await booked()).toBe(1);
    expect(await acts()).toHaveLength(1);
  });

  it("done-means 7: halting 'act' refuses the next confirm; clearing it lets the same proposal through", async () => {
    const p = propose();
    await http().post("/copilot/halt").set("Authorization", `Bearer ${owner.token}`).send({ scope: "act" }).expect(200);
    expect((await confirm(clerk.token, p)).body).toMatchObject({ outcome: "halted", answer: { key: "copilot.answer.paused" } });
    expect(await booked()).toBe(0);
    await http().post("/copilot/halt/clear").set("Authorization", `Bearer ${owner.token}`).send({ scope: "act" }).expect(200);
    expect((await confirm(clerk.token, p)).body.outcome).toBe("done");
  });

  it("done-means 8 (#678): a validly signed proposal naming a tool not declared act refuses", async () => {
    const p = issueProposal(key, { ...bookSlot, intent: "queue_depth" }, { type: "user", id: clerk.id }, { args: { slot: "10:30" } }, null, new Date())!;
    expect((await confirm(clerk.token, p)).body).toMatchObject({ outcome: "notAct", answer: { key: "copilot.answer.actInvalid" } });
    expect(await booked()).toBe(0);
  });

  it("a malformed body is a 400, and an unauthenticated confirm a 401", async () => {
    await http().post("/copilot/confirm").set("Authorization", `Bearer ${clerk.token}`).send({ proposal: { v: 2 } }).expect(400);
    await http().post("/copilot/confirm").send({ proposal: propose() }).expect(401);
  });
});
