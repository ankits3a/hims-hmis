import { buildSubscriptionBus } from "./jobs";
import { ModuleRegistry } from "../modules/loader";
import { authManifest } from "../auth/manifest";
import { workflowManifest } from "../workflow/manifest";
import { approvalsManifest } from "../approvals/manifest";
import { patientsManifest } from "../../modules/patients";
import { tariffManifest } from "../../modules/tariff";
import { opdManifest } from "../../modules/opd";
import { billingManifest } from "../../modules/billing";
import type { Handler, SubscriptionBus } from "../events/subscriptions";
import type { ModuleManifest } from "../modules/manifest";

// Flattens a bus into (consumer, event) pairs for comparison. A consumer may in principle
// carry more than one event name (SubscriptionBus.on adds to the same entry), so this is a
// proper flatMap, not an assumption of one event per consumer.
function busPairs(bus: SubscriptionBus): [string, string][] {
  return bus.consumers().flatMap((c) => c.events.map((e): [string, string] => [c.consumer, e]));
}

const noopHandler: Handler = async () => {};

describe("buildSubscriptionBus (amendment 6 seam)", () => {
  // Leg (a) — THE DISCRIMINATING LEG. Spike question D measured that all seven shipped
  // manifests declare `subscriptions: []` today, so an assertion against the real registry
  // alone is `[] === []` and proves nothing (EXECUTION-LESSONS 3.14's class). A synthetic
  // manifest with a matching stub handler gives the bus something non-empty to get wrong.
  it("wires exactly the registry's declared subscriptions to their handlers", () => {
    const registry = new ModuleRegistry();
    const synthetic: ModuleManifest = {
      key: "synthetic",
      title: "Synthetic",
      menu: [],
      permissions: [],
      subscriptions: [{ event: "synthetic.happened", consumer: "synthetic.consumer" }],
    };
    registry.install(synthetic);

    const bus = buildSubscriptionBus(registry, { "synthetic.consumer": noopHandler });

    expect(busPairs(bus)).toEqual([["synthetic.consumer", "synthetic.happened"]]);
  });

  it("throws — a boot error, not a silent skip — when a declared subscription has no matching handler", () => {
    const registry = new ModuleRegistry();
    const synthetic: ModuleManifest = {
      key: "synthetic2",
      title: "Synthetic2",
      menu: [],
      permissions: [],
      subscriptions: [{ event: "synthetic.happened", consumer: "synthetic.consumer" }],
    };
    registry.install(synthetic);

    expect(() => buildSubscriptionBus(registry, {})).toThrow(/synthetic\.consumer/);
  });

  // Leg (b) — the honest, currently-empty pin. Every one of the seven shipped manifests
  // declares `subscriptions: []` at T2's commit (spike question D); this assertion is
  // load-bearing FROM T4 ON, once amendment 6's `alertsManifest` joins this same registry and
  // declares `escalation.triggered -> kernel.alerts`. Shipping ONLY this leg (without leg (a)
  // above) would be EXECUTION-LESSONS 3.14's failure class — an assertion that cannot
  // discriminate because it starts and ends at `[] === []`.
  it("the real registry's union equals the real bus — CURRENTLY EMPTY (all seven shipped manifests declare subscriptions: [])", () => {
    const registry = new ModuleRegistry();
    registry.install(authManifest);
    registry.install(workflowManifest);
    registry.install(approvalsManifest);
    registry.install(patientsManifest);
    registry.install(tariffManifest);
    registry.install(opdManifest);
    registry.install(billingManifest);

    const bus = buildSubscriptionBus(registry, {});

    expect(busPairs(bus)).toEqual([]);
  });
});
