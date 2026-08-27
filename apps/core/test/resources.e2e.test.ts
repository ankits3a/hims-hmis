import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withTx } from "../src/kernel/db/client";
import { loadConfig, requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import {
  KERNEL_RESOURCE_KINDS, assignResource, changeResourceStatus, createResource,
} from "../src/kernel/resources";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";

/**
 * PLAN 13 T5 — THE HTTP SURFACE A BROWSER ACTUALLY CALLS.
 *
 * 11h's CLOSE (independent reviewer, MAJOR 5) is why this file exists at all rather than as a note
 * that the read functions are already unit-tested: T1 and T5 of that phase asserted everything
 * against the FUNCTIONS, and the route — its zod schema, its guards, its param binding — had no
 * test of any kind. Every one of those is a way a green unit suite can sit behind a broken endpoint.
 *
 * **The three legs the plan names are 401, 403 and 200**, and the 403 leg is the one that costs
 * something to write and is worth it: an authenticated actor holding a DIFFERENT permission must be
 * refused. A test that only proves 401-vs-200 cannot tell a permission-guarded route from an
 * authenticated-only one.
 */
describe("the resource registry over HTTP (Plan 13 T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let app: INestApplication;
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);
  const ACTOR: Actor = { type: "user", id: "seed-admin" };
  const KINDS = KERNEL_RESOURCE_KINDS;
  const T0 = new Date("2026-08-26T10:00:00.000Z");

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // The app under test must talk to THIS worker's database, not to whatever `DATABASE_URL`
    // happens to hold — the shipped e2e pattern (`alerts.e2e.test.ts`, `search.e2e.test.ts`).
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => { await app.close(); await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

  async function deskUser(permissions: string[]): Promise<string> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const suffix = Math.random().toString(36).slice(2, 9);
    const { id } = await createUser(db, { username: `u${suffix}`, fullName: "Desk", password: "correct horse battery" });
    const roleKey = `r${suffix}`;
    await createRole(db, roleKey, "Desk");
    for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    return token;
  }

  async function mk(kind: string, code: string, parentId: string | null = null): Promise<string> {
    const { resourceId } = await withTx(db, (tx) =>
      createResource(tx, ACTOR, KINDS, { kind, code, name: `${kind} ${code}`, parentId, at: T0 }));
    return resourceId;
  }

  // ───────────────────────────────────── the guards ─────────────────────────────────────

  it("401 unauthenticated, on all three routes — they are guarded like every other", async () => {
    for (const path of ["/resources/tree", "/resources/board?kind=bed", "/resources/X/history"]) {
      const res = await request(server()).get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  /**
   * THE LEG THAT DISTINGUISHES A PERMISSIONED ROUTE FROM AN AUTHENTICATED-ONLY ONE. This actor holds
   * `opd.masters.read` — a real, declared permission that is not `resources.read` — so a route with
   * no `@RequirePermission` would answer 200 to it and this leg would be the only thing that noticed.
   */
  it("403 for an authenticated actor without `resources.read`, on all three routes", async () => {
    const token = await deskUser(["opd.masters.read"]);
    for (const path of ["/resources/tree", "/resources/board?kind=bed", "/resources/X/history"]) {
      const res = await request(server()).get(path).set("Authorization", `Bearer ${token}`);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  // ───────────────────────────────────── the reads ─────────────────────────────────────

  it("200 with the tree, nested, for an actor holding `resources.read`", async () => {
    const token = await deskUser(["resources.read"]);
    const f1 = await mk("floor", "1");
    const w1 = await mk("ward", "W1", f1);
    await mk("bed", "B1", w1);

    const res = await request(server()).get("/resources/tree").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { roots: { code: string; kind: string; children: { code: string; children: { code: string }[] }[] }[] };
    expect(body.roots.map((r) => ({ code: r.code, kind: r.kind }))).toEqual([{ code: "1", kind: "floor" }]);
    expect(body.roots[0]!.children[0]!.code).toBe("W1");
    expect(body.roots[0]!.children[0]!.children.map((c) => c.code)).toEqual(["B1"]);
  });

  /**
   * `depth` arrives as a query STRING. This leg is what proves the coercion happened: an uncoerced
   * `"1"` would be truthy-but-not-a-number and the clamp `Math.min("1", 6)` would answer `1` by
   * accident on this input and `NaN` on others. Asserting the SHAPE at depth 1 pins the behaviour.
   */
  it("200 with `depth` coerced from the query string, and a non-numeric depth is a 400", async () => {
    const token = await deskUser(["resources.read"]);
    const f1 = await mk("floor", "1");
    await mk("ward", "W1", f1);

    const one = await request(server()).get("/resources/tree?depth=1").set("Authorization", `Bearer ${token}`);
    expect(one.status).toBe(200);
    expect((one.body as { roots: { children: unknown[] }[] }).roots[0]!.children).toEqual([]);

    const bad = await request(server()).get("/resources/tree?depth=deep").set("Authorization", `Bearer ${token}`);
    expect(bad.status).toBe(400);
  });

  it("200 with the board's flat rows and the occupancy triad, scoped to one parent", async () => {
    const token = await deskUser(["resources.read"]);
    const w1 = await mk("ward", "W1");
    const w2 = await mk("ward", "W2");
    const b1 = await mk("bed", "B1", w1);
    await mk("bed", "B2", w1);
    await mk("bed", "OTHER", w2);
    await withTx(db, (tx) => assignResource(tx, ACTOR, KINDS, b1, { occupantType: "admission", occupantRef: "ADM-1", at: T0 }));

    const res = await request(server()).get(`/resources/board?kind=bed&parentId=${w1}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: { code: string; status: string; occupantRef: string | null; since: string | null }[] }).rows;
    expect(rows.map((r) => ({ code: r.code, status: r.status, ref: r.occupantRef })))
      .toEqual([
        { code: "B1", status: "occupied", ref: "ADM-1" },
        { code: "B2", status: "available", ref: null },
      ]);
    expect(rows[0]!.since).toBe(T0.toISOString());
    // W2's bed is NOT here — the route carries `parentId` through, and A7 is what proves that
    // matters at the function; this is the leg that proves the ROUTE did not drop it.
    expect(rows.map((r) => r.code)).not.toContain("OTHER");
  });

  it("400 when `board` is asked for without a kind — it is the one required query parameter", async () => {
    const token = await deskUser(["resources.read"]);
    const res = await request(server()).get("/resources/board").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("200 with one resource's history, oldest first, and the :id param actually scopes it", async () => {
    const token = await deskUser(["resources.read"]);
    const b1 = await mk("bed", "B1");
    const b2 = await mk("bed", "B2");
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b1, "blocked", { reason: "repair", at: T0 }));
    await withTx(db, (tx) => changeResourceStatus(tx, ACTOR, KINDS, b2, "cleaning", { at: T0 }));

    const res = await request(server()).get(`/resources/${b1}/history`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: { fromStatus: string | null; toStatus: string; resourceId: string }[] }).rows;
    expect(rows.map((r) => [r.fromStatus, r.toStatus])).toEqual([[null, "available"], ["available", "blocked"]]);
    expect(rows.every((r) => r.resourceId === b1)).toBe(true);
  });

  /**
   * **An unknown id answers 200 with an empty list, not 404**, and the choice is the controller's —
   * see its doc comment. Pinned here so the behaviour reads as chosen rather than as a missing
   * existence check that nobody noticed.
   */
  it("200 with an empty list for an id the registry does not have — a sub-resource read, not a 404", async () => {
    const token = await deskUser(["resources.read"]);
    const res = await request(server()).get("/resources/NOSUCH/history").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [] });
  });
});
