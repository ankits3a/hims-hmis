import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ASSIGNABLE_SCOPES } from "../src/kernel/auth/roles-admin.controller";
import { ALL_MANIFESTS } from "../src/kernel/modules/manifests";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

/**
 * `GET /admin/roles` — the catalogue that finally lets the admin screen ASSIGN rather than only
 * revoke, plus the assertion that keeps its `assignableScopes` honest.
 */
describe("roles catalogue e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  for (const manifest of ALL_MANIFESTS) registry.install(manifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
  const server = (): ReturnType<INestApplication["getHttpServer"]> => app.getHttpServer();

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
  });
  afterAll(async () => { await app.close(); await teardown(); });

  /** A user holding `roleKey` at hospital scope, and a live token for them. */
  async function mkUser(username: string, roleKey: string): Promise<{ id: string; token: string }> {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);
    return { id, token };
  }

  /**
   * ═══ THE ASSERTION `ASSIGNABLE_SCOPES` RESTS ON ═══
   *
   * `ASSIGNABLE_SCOPES` claims a MEASUREMENT — that no route in this tree can be satisfied by a
   * floor- or department-scoped holding, because none of them asks for one. A constant asserting
   * that about a tree it never reads would be a comment; this reads the tree.
   *
   * It parses SOURCE rather than reflecting over Nest's metadata deliberately, following
   * `deploy-parity.test.ts`'s precedent: a decorator that was deleted still leaves its route
   * reachable and its metadata absent, so reflection cannot distinguish "requires hospital" from
   * "requires nothing". The regex sees what a reviewer sees.
   *
   * THE DAY THIS FAILS IS THE DAY THE PICKER GAINS AN OPTION, in the same commit — which is the
   * whole point of it failing rather than the client quietly hard-coding a list of its own.
   */
  it("every guarded route in the tree demands a scope the picker offers", () => {
    const root = resolve(__dirname, "../src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(root);

    const scopes = new Set<string>();
    let decorators = 0;
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/@RequirePermission\(\s*([^)]*?)\s*\)/gs)) {
        decorators += 1;
        const scope = /"(hospital|floor|department)"/.exec(m[1] ?? "");
        // A decorator with no scope literal would default somewhere this test cannot see; there
        // are none today, and one appearing is a finding rather than something to skip past.
        expect(scope).not.toBeNull();
        scopes.add(scope![1]!);
      }
    }

    // The parser is load-bearing: zero matches would make every assertion below vacuously true.
    expect(decorators).toBeGreaterThan(100);
    expect([...scopes].sort()).toEqual([...ASSIGNABLE_SCOPES].sort());
  });

  it("lists every role with its permissions, holder count and access-authority flag", async () => {
    await createRole(db, "cashier", "Cashier");
    await grantPermissionToRole(db, registry, "cashier", "billing.invoice.issue");
    await grantPermissionToRole(db, registry, "cashier", "billing.receipt.record");
    await createRole(db, "roles_admin", "Roles administrator");
    await grantPermissionToRole(db, registry, "roles_admin", "auth.roles.manage");

    const { token } = await mkUser("owner", "roles_admin");
    // A second, DEACTIVATED cashier and a DEPARTMENT-scoped one: neither may be counted, because
    // neither can exercise the role (`hospitalScopeHolders`'s predicate, matched exactly).
    await mkUser("asha", "cashier");
    const { id: goneId } = await createUser(db, { username: "gone", fullName: "G", password: "p1234567" });
    await assignRole(db, { userId: goneId, roleKey: "cashier", scopeType: "hospital" });
    await db.execute(`update users set active = false where id = '${goneId}'` as never);
    const { id: deptId } = await createUser(db, { username: "dept", fullName: "D", password: "p1234567" });
    await assignRole(db, { userId: deptId, roleKey: "cashier", scopeType: "department", scopeId: "PAEDS" });

    const res = await request(server()).get("/admin/roles").set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.assignableScopes).toEqual(["hospital"]);
    const byKey = Object.fromEntries(res.body.roles.map((r: { key: string }) => [r.key, r]));

    expect(byKey.cashier).toMatchObject({
      title: "Cashier",
      permissions: ["billing.invoice.issue", "billing.receipt.record"], // sorted
      holders: 1,                    // asha only — not the deactivated one, not the department one
      grantsAccessAuthority: false,  // billing.* is not authority over access
    });
    // The flag is DERIVED from authManifest, so it is what makes "you are handing over control of
    // who may do what" sayable before the click rather than discoverable afterwards.
    expect(byKey.roles_admin.grantsAccessAuthority).toBe(true);
  });

  it("is gated on auth.roles.manage, not on auth.users.manage", async () => {
    await createRole(db, "users_only", "User administrator");
    await grantPermissionToRole(db, registry, "users_only", "auth.users.manage");
    const { token } = await mkUser("frontdesk", "users_only");

    // The person who may create accounts may reach /admin/users and NOT the catalogue: assigning
    // authority is the other permission, and the split is the boundary 11e CLOSE restored.
    await request(server()).get("/admin/users").set("Authorization", `Bearer ${token}`).expect(200);
    await request(server()).get("/admin/roles").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("the catalogue feeds an assignment that actually takes effect", async () => {
    await createRole(db, "roles_admin", "Roles administrator");
    await grantPermissionToRole(db, registry, "roles_admin", "auth.roles.manage");
    await createRole(db, "cashier", "Cashier");
    await grantPermissionToRole(db, registry, "cashier", "billing.invoice.read");

    const { token } = await mkUser("owner", "roles_admin");
    const { id: ashaId } = await createUser(db, { username: "asha", fullName: "A", password: "p1234567" });
    const { token: ashaToken } = await createSession(db, cfg, ashaId);

    await request(server()).get("/billing/invoices").set("Authorization", `Bearer ${ashaToken}`).expect(403);

    const catalogue = await request(server()).get("/admin/roles").set("Authorization", `Bearer ${token}`).expect(200);
    const picked = catalogue.body.roles.find((r: { key: string }) => r.key === "cashier");
    await request(server())
      .post(`/admin/users/${ashaId}/roles`).set("Authorization", `Bearer ${token}`)
      .send({ roleKey: picked.key, scopeType: catalogue.body.assignableScopes[0] }).expect(201);

    // EFFECTIVE ON THE NEXT CALL, on the SAME token: `hasPermission` reads `role_assignments` live,
    // so there is no session work and nothing to wait out — the mirror of what `revoke` proves.
    await request(server()).get("/billing/invoices").set("Authorization", `Bearer ${ashaToken}`).expect(200);
    expect((await request(server()).get("/admin/roles").set("Authorization", `Bearer ${token}`))
      .body.roles.find((r: { key: string }) => r.key === "cashier").holders).toBe(1);
  });
});
