import { Test } from "@nestjs/testing";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import { DB } from "../../kernel/tokens";
import { RadiologyDeskController } from "./radiology-desk.controller";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";

/**
 * #1078 — the desk controller's own refusals, before any act runs: a body its contracts schema rejects
 * is a 400, and a collect without an Idempotency-Key is a 400 — a desk retry without a key could charge
 * twice. Behind a stub guard that lets everybody in (the permission guard is the app's, not this
 * file's), over a database that fails the request if anybody queries it.
 */
class EveryoneIn implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<Record<string, unknown>>()["hmisActor"] = { type: "user", id: "desk-user" };
    return true;
  }
}
const DB_SURFACE = new Set(["select", "selectDistinct", "insert", "update", "delete", "execute", "transaction", "query"]);
const UNTOUCHABLE_DB = new Proxy({}, {
  get: (_t, prop) => (typeof prop === "string" && DB_SURFACE.has(prop)
    ? () => { throw new Error("the database was queried before the request was checked"); }
    : undefined),
});

const COLLECT = { encounterNo: "V2608310001", studyIds: ["S1"], tender: { mode: "cash", amountPaise: 120000 } };

describe("the imaging desk controller's own refusals (#1078)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RadiologyDeskController],
      providers: [{ provide: DB, useValue: UNTOUCHABLE_DB }, { provide: APP_GUARD, useClass: EveryoneIn }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  it("a collect without an Idempotency-Key is a 400 and reaches nothing", async () => {
    const res = await request(server()).post("/radiology/desk/collect").send(COLLECT);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("Idempotency-Key");
  });

  it("bodies the contracts schemas reject are 400s: no study, a credit tender, a zero amount, no visit", async () => {
    for (const body of [
      { ...COLLECT, studyIds: [] },
      { ...COLLECT, tender: { mode: "credit", amountPaise: 120000 } },
      { ...COLLECT, tender: { mode: "cash", amountPaise: 0 } },
      { ...COLLECT, addOns: [{ studyId: "S1", kind: "print" }] },
    ]) {
      const res = await request(server()).post("/radiology/desk/collect").set("Idempotency-Key", "k").send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect((await request(server()).post("/radiology/desk/arrive").send({})).status).toBe(400);
    expect((await request(server()).get("/radiology/desk/visits")).status).toBe(400);
  });
});
