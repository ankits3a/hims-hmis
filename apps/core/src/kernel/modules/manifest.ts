import type { SearchProvider } from "../search/types";

export type ModuleManifest = {
  key: string;
  title: string;
  menu: { label: string; path: string; permission: string }[];
  permissions: string[];
  subscriptions: { event: string; consumer: string }[];
  /**
   * PLAN 11h T1 / DD1 — the module's search providers, OPTIONAL so every existing manifest stays
   * valid unchanged. `kernel/search/registry.ts` collects these from `registry.all()`; a provider
   * whose `permission` no manifest declares fails at collection rather than answering nothing
   * forever, which is the same refusal `grantPermissionToRole` already makes.
   */
  search?: SearchProvider[];
};
