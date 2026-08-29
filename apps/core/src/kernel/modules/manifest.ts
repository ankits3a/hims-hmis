import type { ResourceKindDecl } from "../resources/kinds";
import type { SearchProvider } from "../search/types";
import type { DeskProvider } from "../desk/types";

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
  /**
   * PLAN 13 T2 / DD4 — the resource kinds this module OWNS, and each kind's status vocabulary.
   * OPTIONAL for the same reason `search` is, and it is the same seam solving the same problem:
   * every existing manifest stays valid unchanged. `kernel/resources/kinds.ts`'s
   * `collectResourceKinds` collects these from `registry.all()` exactly as `collectProviders`
   * does, and refuses at BOOT on a kind two manifests claim or a declaration naming a status
   * outside its own vocabulary.
   *
   * THE SEAM IS OPEN FOR VOCABULARIES AND FOR CLAIMING A KIND; IT IS CLOSED FOR THE SET OF KINDS.
   * The ten names live in `kinds.ts` and in the `resources_kind_ck` CHECK constraint, so an
   * eleventh kind is a kernel edit plus a migration plus the parity test — by design. Plan 15
   * (`theatre`, `device`), Plan 16 (`store`) and Plan 17 (`bench`, `analyzer`) edit no kernel code
   * only because their kinds are already among the ten.
   *
   * `readonly` where `search` is mutable, and the difference is deliberate rather than
   * inconsistent: `KERNEL_RESOURCE_KINDS` is a frozen-by-convention constant that `kinds.test.ts`
   * compares by IDENTITY, and a mutable field would let a consumer push a kind onto a manifest's
   * declaration list at runtime — which is a way to claim a kind that no boot-time collector would
   * ever see refuse.
   */
  resourceKinds?: readonly ResourceKindDecl[];
  /**
   * PLAN 07c T1 / DD2 — the module's DESK CARDS. OPTIONAL for the same reason `search` and
   * `resourceKinds` are, and it is the same seam solving the same problem a third time: every
   * existing manifest stays valid unchanged. `kernel/desk/registry.ts`'s `collectDeskProviders`
   * collects these from `registry.all()` exactly as `collectProviders` does, and refuses at BOOT on
   * a duplicate key or a permission no manifest declares.
   *
   * A module owns its own card. When pharmacy or the lab lands, its card ships with the module and
   * every holder's home gains a band without the kernel learning anything about pharmacy.
   */
  desk?: DeskProvider[];
};
