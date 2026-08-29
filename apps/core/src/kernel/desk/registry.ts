import { hasPermission } from "../auth/permissions";
import { DeskError } from "./types";
import type { DeskCard, DeskProvider, DeskProviderCtx, ReportSection } from "./types";
import type { ModuleRegistry } from "../modules/loader";

/** One provider's share of the desk's budget. The desk is a home screen, not a report. */
export const DESK_PROVIDER_BUDGET_MS = 250;

/**
 * PLAN 07c T1 — every desk provider every installed manifest declares.
 *
 * THERE IS NO SECOND LIST, for the reason `collectProviders` gives about search: `ALL_MANIFESTS` is
 * already the one place that answers "which modules exist", so the desk reads it rather than
 * growing a registry of its own. That is §2.54's lesson applied before the drift rather than after.
 *
 * It REFUSES AT BOOT on a permission no manifest declares, which is the same refusal
 * `grantPermissionToRole` makes: a card gated on a string nothing declares is a card no role can
 * ever reach, and it would sit in the tree looking implemented forever.
 */
export function collectDeskProviders(registry: ModuleRegistry): DeskProvider[] {
  const providers = registry.all().flatMap((m) => m.desk ?? []);
  const seen = new Set<string>();
  const declared = new Set(registry.allPermissions());
  for (const p of providers) {
    if (seen.has(p.key)) {
      throw new DeskError("duplicate_provider", `duplicate desk provider key: ${p.key}`);
    }
    seen.add(p.key);
    if (!declared.has(p.permission)) {
      throw new DeskError(
        "undeclared_permission",
        `desk provider "${p.key}" declares permission "${p.permission}", which no manifest declares — ` +
          "a card gated on a permission nothing declares is a card no role can ever reach",
      );
    }
  }
  return providers;
}

/**
 * ONE PROVIDER FAILING DEGRADES ITS OWN CARD, NEVER THE DESK.
 *
 * This is the home screen for every person in the hospital. A module that throws — or hangs on a
 * query somebody forgot to index — must not blank the front door for a cashier who does not even
 * hold that module's permission. The failure is swallowed here and the card simply does not appear,
 * which is the same bargain `runProvider` already makes for search.
 */
async function runOne(provider: DeskProvider, ctx: DeskProviderCtx): Promise<DeskCard[]> {
  try {
    return await Promise.race([
      provider.load(ctx),
      new Promise<DeskCard[]>((resolve) => {
        setTimeout(() => { resolve([]); }, DESK_PROVIDER_BUDGET_MS);
      }),
    ]);
  } catch {
    return [];
  }
}

/**
 * THE DESK, COMPOSED. Only the providers whose permission the caller actually holds are RUN — not
 * run-then-filtered, which would do the work and read the data for cards the person may not see.
 *
 * The permission check is per provider and at hospital scope, matching every other projection in
 * this tree (`can()` on the client reads `permissions.hospital` and nothing else).
 */
export async function loadDesk(
  providers: DeskProvider[],
  ctx: DeskProviderCtx,
): Promise<{ cards: DeskCard[] }> {
  const allowed: DeskProvider[] = [];
  for (const p of providers) {
    if (await hasPermission(ctx.db, ctx.actor.id, p.permission, "hospital")) allowed.push(p);
  }
  const results = await Promise.all(allowed.map((p) => runOne(p, ctx)));
  return { cards: results.flat() };
}

/**
 * PLAN 07c T2 — THE PERSON'S OWN DAY, composed from the same providers as their desk.
 *
 * The permission gate is identical and applied identically — before the provider runs. What is NOT
 * here is any notion of WHOSE report it is: the caller's actor is the only subject, and there is no
 * parameter for another. Self-scoping is structural rather than a check somebody can forget to
 * write (07c DD4); a supervisor reading across staff is a different route behind a different
 * permission, not an argument on this one.
 *
 * A provider that throws is skipped exactly as its card is — a report is worth having with a
 * section missing, and worth nothing if one module's bad query makes it un-openable.
 */
export async function loadReport(
  providers: DeskProvider[],
  ctx: DeskProviderCtx,
): Promise<{ sections: ReportSection[] }> {
  const sections: ReportSection[] = [];
  for (const p of providers) {
    if (p.report === undefined) continue;
    if (!(await hasPermission(ctx.db, ctx.actor.id, p.permission, "hospital"))) continue;
    try {
      sections.push(...(await p.report(ctx)));
    } catch {
      // one section short beats an unopenable report
    }
  }
  return { sections };
}
