import { loadConfig } from "../config";
import { collectCopilotIntents, collectCopilotTools } from "../copilot/catalog";
import { strongCue } from "../copilot/intents";
import { collectDeskProviders } from "../desk/registry";
import { collectOrderKinds } from "../orders/kinds";
import { collectProviders } from "../search/registry";
import { buildSubscriptionBus } from "../worker/jobs";
import { withoutPermissions } from "../auth/permissions";
import { ModuleRegistry } from "./loader";
import { ALL_MANIFESTS } from "./manifests";
import { DARK_MODULE_KEYS, isModuleOn, liveModules, modulesOn, runIfModuleOn, switchOf } from "./switch";
import type { ModuleManifest } from "./manifest";

/**
 * DECISION 0085 / A1 — a module switched off changes nothing anyone can see or receive. A FAKE dark manifest (key
 * `ipd`, one of the ten) carries one of everything a manifest can put in front of a person — a menu entry, a Now card,
 * a search provider, an order kind, a copilot tool and intent — plus a subscription, and every collector is asked
 * about it with the switch off (production) and on. Its permission must survive either way: tables and permissions
 * exist whatever the switch says.
 */
const FAKE_PERMISSION = "ipd.fake.view";
const fakeDark: ModuleManifest = {
  key: "ipd",
  title: "Fake inpatient module",
  menu: [{ label: "Fake beds", path: "/ipd/fake", permission: FAKE_PERMISSION }],
  permissions: [FAKE_PERMISSION],
  subscriptions: [{ event: "ipd.fake.happened", consumer: "ipd.fake_consumer" }],
  desk: [{ key: "ipd.fake_card", permission: FAKE_PERMISSION, load: async () => [] }],
  search: [{ key: "ipd.fake_search", entity: "patient", permission: FAKE_PERMISSION, run: async () => ({ hits: [], total: 0 }) }],
  orderKinds: [{
    kind: "ipd_fake", seriesKey: "lab_order", placePermission: FAKE_PERMISSION,
    requiresClinician: false, requiresIndication: false, selfOrderable: false,
  }],
  copilotTools: [{
    intent: "ipd.fake_count", permission: FAKE_PERMISSION, needsSubject: false,
    run: async () => ({ key: "copilot.answer.erCasualtyQuiet", params: {} }),
  } as unknown as NonNullable<ModuleManifest["copilotTools"]>[number]],
  copilotIntents: {
    "ipd.fake_count": { cues: [strongCue("zqfakewardcount")], answerKeys: ["copilot.answer.erCasualtyQuiet"] },
  } as unknown as ModuleManifest["copilotIntents"],
};
const lit: ModuleManifest = { key: "billing", title: "Billing", menu: [], permissions: ["billing.fake"], subscriptions: [] };

function registryWith(on: Parameters<typeof switchOf>[0]): ModuleRegistry {
  const r = new ModuleRegistry(switchOf(on));
  r.install(lit);
  r.install(fakeDark);
  return r;
}

describe("decision 0085 — HMIS_MODULES_ON", () => {
  it("is empty by default (production): all ten off; it names keys, ignores spaces, and refuses a key it does not know", () => {
    expect([...modulesOn({})]).toEqual([]);
    expect([...modulesOn({ HMIS_MODULES_ON: "" })]).toEqual([]);
    expect([...modulesOn({ HMIS_MODULES_ON: " ipd , emergency," })].sort()).toEqual(["emergency", "ipd"]);
    expect(() => modulesOn({ HMIS_MODULES_ON: "ipd,idp" })).toThrow();
    for (const key of DARK_MODULE_KEYS) expect(isModuleOn(key, {})).toBe(false);
    expect(isModuleOn("ipd", { HMIS_MODULES_ON: "ipd" })).toBe(true);
    expect(isModuleOn("diet", { HMIS_MODULES_ON: "ipd" })).toBe(false);
    // The switch can hide only the ten: every other module is on whatever it says.
    expect(isModuleOn("billing", {})).toBe(true);
    expect(isModuleOn("opd", { HMIS_MODULES_ON: "ipd" })).toBe(true);
  });

  it("loadConfig parses it (empty = none) and fails the boot on a typo", () => {
    const base = { DATABASE_URL: "postgres://unused", SECRET_KEY: "a".repeat(64) };
    expect([...(loadConfig(base).modulesOn ?? [])]).toEqual([]);
    expect([...(loadConfig({ ...base, HMIS_MODULES_ON: "tasks,ipd" }).modulesOn ?? [])].sort()).toEqual(["ipd", "tasks"]);
    expect(() => loadConfig({ ...base, HMIS_MODULES_ON: "beds" })).toThrow(/HMIS_MODULES_ON/);
  });
});

describe("decision 0085 / A1 — a module switched off shows nothing and consumes nothing", () => {
  it("off: no Now card, search provider, order kind, copilot tool or intent; its permission still exists", () => {
    const r = registryWith([]);
    expect(r.all().map((m) => m.key)).toEqual(["billing", "ipd"]);
    expect(r.live().map((m) => m.key)).toEqual(["billing"]);
    expect(r.allPermissions()).toContain(FAKE_PERMISSION);
    expect(collectDeskProviders(r).map((p) => p.key)).not.toContain("ipd.fake_card");
    expect(collectProviders(r).map((p) => p.key)).not.toContain("ipd.fake_search");
    expect(collectOrderKinds(r).map((k) => k.kind)).not.toContain("ipd_fake");
    expect(collectCopilotTools(r).map((t) => t.intent)).not.toContain("ipd.fake_count");
    expect(collectCopilotIntents(r).map((i) => i.intent)).not.toContain("ipd.fake_count");
  });

  it("off: its subscriptions are not on the bus, and a missing handler is no boot error", () => {
    const r = registryWith([]);
    const bus = buildSubscriptionBus(r, {});
    expect(bus.consumers().map((c) => c.consumer)).not.toContain("ipd.fake_consumer");
  });

  it("off: its menu links are not drawn — /auth/me's projection drops permissions only off modules declare", () => {
    const r = registryWith([]);
    expect([...r.darkPermissions()]).toEqual([FAKE_PERMISSION]);
    const held = { hospital: ["billing.fake", FAKE_PERMISSION], scoped: { department: { d1: [FAKE_PERMISSION] }, floor: { f1: ["billing.fake", FAKE_PERMISSION] } } };
    expect(withoutPermissions(held, r.darkPermissions())).toEqual({ hospital: ["billing.fake"], scoped: { department: {}, floor: { f1: ["billing.fake"] } } });
    expect(withoutPermissions(held, registryWith(["ipd"]).darkPermissions())).toEqual(held);
  });

  it("on: every collector sees it, and its subscription needs its handler again", () => {
    const r = registryWith(["ipd"]);
    expect(r.live().map((m) => m.key)).toEqual(["billing", "ipd"]);
    expect(collectDeskProviders(r).map((p) => p.key)).toContain("ipd.fake_card");
    expect(collectProviders(r).map((p) => p.key)).toContain("ipd.fake_search");
    expect(collectOrderKinds(r).map((k) => k.kind)).toContain("ipd_fake");
    expect(collectCopilotTools(r).map((t) => t.intent)).toContain("ipd.fake_count");
    expect(collectCopilotIntents(r).map((i) => i.intent)).toContain("ipd.fake_count");
    expect(() => buildSubscriptionBus(r, {})).toThrow(/ipd\.fake_consumer/);
    const bus = buildSubscriptionBus(r, { "ipd.fake_consumer": async () => {} });
    expect(bus.consumers().map((c) => c.consumer)).toContain("ipd.fake_consumer");
  });

  it("off: its Nest module is not imported (no route), and its job body is never called", async () => {
    class FakeIpdModule {}
    expect(liveModules([["ipd", FakeIpdModule]], switchOf([]))).toEqual([]);
    expect(liveModules([["ipd", FakeIpdModule]], switchOf(["ipd"]))).toEqual([FakeIpdModule]);
    const body = jest.fn(async () => {});
    await expect(runIfModuleOn("lapseBedReservations", "ipd", body, switchOf([]))).resolves.toBe("off");
    expect(body).not.toHaveBeenCalled();
    await expect(runIfModuleOn("lapseBedReservations", "ipd", body, switchOf(["ipd"]))).resolves.toBe("ran");
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("production's registry: no manifest of the ten is live with the switch unset", () => {
    const r = new ModuleRegistry(switchOf([]));
    for (const m of ALL_MANIFESTS) r.install(m);
    const dark = new Set<string>(DARK_MODULE_KEYS);
    expect(r.live().filter((m) => dark.has(m.key))).toEqual([]);
    // …and nothing outside the ten is hidden by it.
    expect(r.live().length).toBe(ALL_MANIFESTS.filter((m) => !dark.has(m.key)).length);
  });
});
