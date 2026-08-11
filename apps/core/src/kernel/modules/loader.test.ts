import { ModuleRegistry } from "./loader";
import type { ModuleManifest } from "./manifest";

const reg = (over: Partial<ModuleManifest> = {}): ModuleManifest => ({
  key: "registration",
  title: "Registration",
  menu: [{ label: "New Patient", path: "/registration/new", permission: "registration.create" }],
  permissions: ["registration.create", "registration.read"],
  subscriptions: [],
  ...over,
});

describe("ModuleRegistry", () => {
  it("installs modules and lists permissions deduped", () => {
    const r = new ModuleRegistry();
    r.install(reg());
    r.install(reg({ key: "billing", title: "Billing", permissions: ["billing.create", "registration.read"] }));
    expect(r.all().map((m) => m.key)).toEqual(["registration", "billing"]);
    expect(r.allPermissions().sort()).toEqual(["billing.create", "registration.create", "registration.read"]);
  });

  it("rejects duplicate module keys", () => {
    const r = new ModuleRegistry();
    r.install(reg());
    expect(() => r.install(reg())).toThrow(/duplicate/i);
  });

  it("indexes event subscriptions by event name", () => {
    const r = new ModuleRegistry();
    r.install(reg({ key: "billing", subscriptions: [{ event: "visit.opened", consumer: "billing.autoCharge" }] }));
    expect(r.subscriptionsFor("visit.opened")).toEqual([{ consumer: "billing.autoCharge", moduleKey: "billing" }]);
    expect(r.subscriptionsFor("nothing.happened")).toEqual([]);
  });

  it("rejects subscriptions to malformed event names", () => {
    const r = new ModuleRegistry();
    expect(() =>
      r.install(reg({ subscriptions: [{ event: "BadName", consumer: "x.y" }] })),
    ).toThrow(/event name/i);
  });
});
