import type { ModuleManifest } from "../../kernel/modules/manifest";
import { serviceSearchProvider } from "./search-provider";
export const tariffManifest: ModuleManifest = {
  key: "tariff",
  title: "Tariff, Pricing & GST",
  menu: [], // no UI this plan — Plan 08's screens link here
  permissions: [
    "tariff.read", "tariff.services.manage", "tariff.versions.draft",
    "tariff.versions.activate", "tariff.config.manage",
  ],
  // PLAN 11h T4 — services by code or name, on `tariff.read`.
  search: [serviceSearchProvider],
  subscriptions: [],
};
