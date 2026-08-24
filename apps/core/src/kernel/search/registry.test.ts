import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "../auth/identity";
import { assignRole, createRole, grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { ModuleRegistry } from "../modules/loader";
import { PROVIDER_BUDGET_MS, collectProviders, searchAll } from "./registry";
import { SearchError } from "./types";
import { parseSearchQuery } from "@hmis/contracts";
import type { ModuleManifest } from "../modules/manifest";
import type { SearchProvider } from "./types";
import type { Db } from "../db/client";

/** How long the "slow" provider sleeps. The budget assertion is measured against THIS, not a
 * multiple of the budget — see the slow-provider test. */
const SLOW_PROVIDER_MS = PROVIDER_BUDGET_MS * 8;

/** A provider that records every invocation — the only way to prove a provider was NOT run. */
function spyProvider(
  over: Partial<SearchProvider> & { key: string; permission: string },
  behaviour: "ok" | "slow" | "throw" = "ok",
): SearchProvider & { calls: number } {
  const p = {
    key: over.key,
    entity: over.entity ?? ("patient" as const),
    permission: over.permission,
    calls: 0,
    async run(): Promise<{ hits: never[]; total: number }> {
      p.calls += 1;
      if (behaviour === "throw") throw new Error("provider exploded");
      if (behaviour === "slow") await new Promise((r) => setTimeout(r, SLOW_PROVIDER_MS));
      return { hits: [], total: 7 };
    },
  };
  return p as SearchProvider & { calls: number };
}

function manifest(over: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    key: "t",
    title: "Test module",
    menu: [],
    permissions: ["t.alpha", "t.beta"],
    subscriptions: [],
    ...over,
  };
}

describe("search registry — collectProviders", () => {
  it("collects providers from every installed manifest", () => {
    const r = new ModuleRegistry();
    r.install(manifest({ search: [spyProvider({ key: "t.patient", permission: "t.alpha" })] }));
    r.install(manifest({ key: "u", permissions: ["u.read"], search: [spyProvider({ key: "u.doctor", permission: "u.read", entity: "doctor" })] }));
    expect(collectProviders(r).map((p) => p.key)).toEqual(["t.patient", "u.doctor"]);
  });

  it("a manifest with no providers contributes nothing and does not throw", () => {
    const r = new ModuleRegistry();
    r.install(manifest());
    expect(collectProviders(r)).toEqual([]);
  });

  it("refuses a provider whose permission no manifest declares", () => {
    const r = new ModuleRegistry();
    r.install(manifest({ search: [spyProvider({ key: "t.patient", permission: "t.nobody_declares_this" })] }));
    expect(() => collectProviders(r)).toThrow(SearchError);
    expect(() => collectProviders(r)).toThrow(/no manifest declares/);
  });

  it("refuses two providers sharing a key", () => {
    const r = new ModuleRegistry();
    r.install(manifest({
      search: [
        spyProvider({ key: "t.patient", permission: "t.alpha" }),
        spyProvider({ key: "t.patient", permission: "t.beta" }),
      ],
    }));
    expect(() => collectProviders(r)).toThrow(/duplicate search provider key/);
  });
});

describe("search registry — searchAll", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  /** A user holding exactly the permissions named, at hospital scope. */
  async function userHolding(registry: ModuleRegistry, permissions: string[]): Promise<string> {
    await syncPermissions(db, registry);
    const { id } = await createUser(db, { username: `u${Math.random().toString(36).slice(2, 9)}`, fullName: "Desk", password: "correct horse battery" });
    if (permissions.length > 0) {
      const roleKey = `r${Math.random().toString(36).slice(2, 9)}`;
      await createRole(db, roleKey, "Test role");
      for (const p of permissions) await grantPermissionToRole(db, registry, roleKey, p);
      await assignRole(db, { userId: id, roleKey, scopeType: "hospital" });
    }
    return id;
  }

  it("NEVER INVOKES a provider whose permission the caller lacks", async () => {
    const allowed = spyProvider({ key: "t.patient", permission: "t.alpha" });
    const forbidden = spyProvider({ key: "t.doctor", permission: "t.beta", entity: "doctor" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [allowed, forbidden] }));
    const userId = await userHolding(registry, ["t.alpha"]);

    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("asha", 20));

    expect(allowed.calls).toBe(1);
    // The whole assertion: not "filtered from the response" — NEVER RAN.
    expect(forbidden.calls).toBe(0);
    expect(res.groups.map((g) => g.provider)).toEqual(["t.patient"]);
    expect(res.skipped).toEqual(["t.doctor"]);
  });

  it("a caller holding nothing gets an empty answer, every provider skipped, none invoked", async () => {
    const a = spyProvider({ key: "t.patient", permission: "t.alpha" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [a] }));
    const userId = await userHolding(registry, []);

    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("asha", 20));

    expect(a.calls).toBe(0);
    expect(res.groups).toEqual([]);
    expect(res.skipped).toEqual(["t.patient"]);
  });

  it("one slow provider does not delay the answer, and its group is INCOMPLETE rather than empty", async () => {
    const slow = spyProvider({ key: "t.patient", permission: "t.alpha" }, "slow");
    const fast = spyProvider({ key: "t.doctor", permission: "t.beta", entity: "doctor" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [slow, fast] }));
    const userId = await userHolding(registry, ["t.alpha", "t.beta"]);

    const started = Date.now();
    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("asha", 20));
    const elapsed = Date.now() - started;

    /**
     * PLAN 11f's LESSON, RE-APPLIED: this was `< PROVIDER_BUDGET_MS * 4` — a single-sample
     * wall-clock assertion, the exact class 11f retired from this suite for flaking on a loaded
     * runner. The SEMANTIC claim is "the answer did not wait for the slow provider", and the
     * honest threshold is therefore the slow provider's OWN sleep, not a tight multiple of the
     * budget: under this assertion a correct implementation has 2 seconds of headroom on a
     * starved 2-core runner, while the no-budget mutant took 2020 ms and still dies.
     */
    expect(elapsed).toBeLessThan(SLOW_PROVIDER_MS);
    const slowGroup = res.groups.find((g) => g.provider === "t.patient");
    expect(slowGroup).toMatchObject({ timedOut: true, errored: false, hits: [], total: 0 });
    expect(res.groups.find((g) => g.provider === "t.doctor")).toMatchObject({ timedOut: false, total: 7 });
  });

  it("a provider that throws is reported ERRORED, distinctly from slow, and does not take the answer down", async () => {
    const broken = spyProvider({ key: "t.patient", permission: "t.alpha" }, "throw");
    const fine = spyProvider({ key: "t.doctor", permission: "t.beta", entity: "doctor" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [broken, fine] }));
    const userId = await userHolding(registry, ["t.alpha", "t.beta"]);

    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("asha", 20));

    expect(res.groups.find((g) => g.provider === "t.patient")).toMatchObject({ errored: true, timedOut: false });
    expect(res.groups.find((g) => g.provider === "t.doctor")).toMatchObject({ errored: false, total: 7 });
  });

  it("refuses a non-user actor — search is a desk surface", async () => {
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [spyProvider({ key: "t.patient", permission: "t.alpha" })] }));
    await expect(
      searchAll(db, registry, { type: "agent", id: "a1" }, parseSearchQuery("asha", 20)),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("a one-character query invokes nothing", async () => {
    const a = spyProvider({ key: "t.patient", permission: "t.alpha" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [a] }));
    const userId = await userHolding(registry, ["t.alpha"]);

    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("a", 20));

    expect(a.calls).toBe(0);
    expect(res.groups).toEqual([]);
  });

  it("a chip with no free text IS a query — the floor applies to typed text only", async () => {
    const a = spyProvider({ key: "t.patient", permission: "t.alpha" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [a] }));
    const userId = await userHolding(registry, ["t.alpha"]);

    const query = { ...parseSearchQuery("", 20), chips: [{ entity: "patient" as const, id: "p1", label: "Asha" }] };
    const res = await searchAll(db, registry, { type: "user", id: userId }, query);

    expect(a.calls).toBe(1);
    expect(res.groups).toHaveLength(1);
  });

  it("groups render in a FIXED entity order, not by hit count", async () => {
    const registry = new ModuleRegistry();
    registry.install(manifest({
      permissions: ["t.alpha", "t.beta", "t.gamma"],
      search: [
        spyProvider({ key: "t.user", permission: "t.gamma", entity: "user" }),
        spyProvider({ key: "t.doctor", permission: "t.beta", entity: "doctor" }),
        spyProvider({ key: "t.patient", permission: "t.alpha", entity: "patient" }),
      ],
    }));
    const userId = await userHolding(registry, ["t.alpha", "t.beta", "t.gamma"]);

    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("asha", 20));

    expect(res.groups.map((g) => g.entity)).toEqual(["patient", "doctor", "user"]);
  });

  it("`entities` narrows the fan-out and the excluded provider never runs", async () => {
    const patient = spyProvider({ key: "t.patient", permission: "t.alpha" });
    const doctor = spyProvider({ key: "t.doctor", permission: "t.beta", entity: "doctor" });
    const registry = new ModuleRegistry();
    registry.install(manifest({ search: [patient, doctor] }));
    const userId = await userHolding(registry, ["t.alpha", "t.beta"]);

    const res = await searchAll(db, registry, { type: "user", id: userId }, parseSearchQuery("asha", 20), { entities: ["doctor"] });

    expect(patient.calls).toBe(0);
    expect(doctor.calls).toBe(1);
    expect(res.groups.map((g) => g.provider)).toEqual(["t.doctor"]);
  });
});
