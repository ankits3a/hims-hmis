import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../modules/loader";
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { collectDeskProviders, loadDesk } from "./registry";
import { DeskError } from "./types";
import type { DeskProvider } from "./types";
import type { Db } from "../db/client";

/**
 * PLAN 07c T1 — THE DESK SEAM.
 *
 * `/` redirected every authenticated user to the patient registration desk — a doctor, a cashier and
 * an administrator all landed on the same screen, and role decided only which links were hidden.
 * These assertions defend the three properties that make a permission-composed home safe: a card
 * gated on a string nothing declares must not exist, a card the caller may not see must not RUN,
 * and one module's bad day must not blank the front door for everybody else.
 */
function provider(over: Partial<DeskProvider> & { key: string; permission: string }): DeskProvider {
  return {
    load: () => Promise.resolve([{ key: over.key, band: "now" as const, titleKey: "t" }]),
    ...over,
  };
}

function registryWith(permissions: string[], providers: DeskProvider[]): ModuleRegistry {
  const r = new ModuleRegistry();
  r.install({ key: "t", title: "T", menu: [], permissions, subscriptions: [], desk: providers });
  return r;
}

describe("desk providers (07c T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  /**
   * A1 — the boot refusal. A card gated on a permission no manifest declares is a card no role can
   * ever reach, and it would sit in the tree looking implemented forever. This is the same refusal
   * `grantPermissionToRole` already makes about the same class of mistake.
   */
  it("A1: a provider whose permission no manifest declares is refused at collection", () => {
    const r = registryWith(["t.read"], [provider({ key: "t.card", permission: "t.nobody_declares" })]);
    expect(() => collectDeskProviders(r)).toThrow(DeskError);
    expect(() => collectDeskProviders(r)).toThrow(/no manifest declares/);
  });

  it("A1b: two providers with the same key are refused — the response keys on it", () => {
    const r = registryWith(["t.read"], [
      provider({ key: "dupe", permission: "t.read" }),
      provider({ key: "dupe", permission: "t.read" }),
    ]);
    expect(() => collectDeskProviders(r)).toThrow(/duplicate desk provider/);
  });

  it("a well-formed declaration collects", () => {
    const r = registryWith(["t.read"], [provider({ key: "t.card", permission: "t.read" })]);
    expect(collectDeskProviders(r).map((p) => p.key)).toEqual(["t.card"]);
  });

  /**
   * A2 — GATED BEFORE IT RUNS, not run-then-filtered. The difference is not tidiness: a provider
   * that runs and is then discarded has already READ the data for a card its caller may not see.
   */
  it("A2: a provider the caller lacks the permission for is never invoked", async () => {
    const registry = new ModuleRegistry();
    registry.install({
      key: "t", title: "T", menu: [], permissions: ["t.allowed", "t.denied"], subscriptions: [], desk: [],
    });
    await syncPermissions(db, registry);
    // The role must EXIST before a permission can be granted to it (the FK says so); `mkUser`
    // creates it, so the user comes first.
    await ensureRole(db, "desk_t");
    await grantPermissionToRole(db, registry, "desk_t", "t.allowed");
    const user = await mkUser(db, "desk1", ["desk_t"]);

    let allowedRan = false;
    let deniedRan = false;
    const providers = [
      provider({
        key: "a", permission: "t.allowed",
        load: () => { allowedRan = true; return Promise.resolve([{ key: "a", band: "now" as const, titleKey: "a" }]); },
      }),
      provider({
        key: "d", permission: "t.denied",
        load: () => { deniedRan = true; return Promise.resolve([{ key: "d", band: "now" as const, titleKey: "d" }]); },
      }),
    ];

    const { cards } = await loadDesk(providers, { db, actor: user.actor, reader: user.actor, date: "2026-08-29", now: new Date() });
    expect(allowedRan).toBe(true);
    expect(deniedRan).toBe(false);
    expect(cards.map((c) => c.key)).toEqual(["a"]);
  });

  /**
   * A3 — this is the home screen for every person in the hospital. A module that throws must not
   * blank the front door for a cashier who does not even hold that module's permission.
   */
  it("A3: one provider throwing costs its own card and nothing else", async () => {
    const registry = new ModuleRegistry();
    registry.install({ key: "t", title: "T", menu: [], permissions: ["t.read"], subscriptions: [], desk: [] });
    await syncPermissions(db, registry);
    await ensureRole(db, "desk_t2");
    await grantPermissionToRole(db, registry, "desk_t2", "t.read");
    const user = await mkUser(db, "desk2", ["desk_t2"]);

    const providers = [
      provider({ key: "good", permission: "t.read" }),
      provider({ key: "bad", permission: "t.read", load: () => Promise.reject(new Error("boom")) }),
    ];

    const { cards } = await loadDesk(providers, { db, actor: user.actor, reader: user.actor, date: "2026-08-29", now: new Date() });
    expect(cards.map((c) => c.key)).toEqual(["good"]);
  });

  it("a person who holds nothing gets an empty desk, not an error", async () => {
    const user = await mkUser(db, "desk3", []);
    const { cards } = await loadDesk(
      [provider({ key: "x", permission: "t.read" })],
      { db, actor: user.actor, reader: user.actor, date: "2026-08-29", now: new Date() },
    );
    expect(cards).toEqual([]);
  });
});
