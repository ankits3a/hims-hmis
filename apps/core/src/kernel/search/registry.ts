import type { Actor, SearchGroup, SearchQuery, SearchResponse } from "@hmis/contracts";
import { hasPermission } from "../auth/permissions";
import { SearchError } from "./types";
import type { ModuleRegistry } from "../modules/loader";
import type { SearchProvider, SearchProviderCtx } from "./types";
import type { Db } from "../db/client";

/** DD8. One provider's share of the §15 300 ms budget, with the fan-out's own overhead outside it. */
export const PROVIDER_BUDGET_MS = 250;

/** DD8. Rows per entity before the palette offers "show all" — an anti-enumeration cap, not a page size. */
export const DEFAULT_PER_ENTITY = 5;

/** Below this a query is not a query, it is a keystroke. Matches `searchPatients`' own floor. */
export const MIN_QUERY_CHARS = 2;

/**
 * The order groups render in. It is DELIBERATELY FIXED rather than sorted by hit count: a desk
 * learns where patients appear and stops reading the headings, and a list that reorders itself
 * under a fast typist is a list nobody can aim at.
 */
const ENTITY_ORDER: readonly string[] = [
  "command", "patient", "appointment", "invoice", "doctor", "department", "room", "service",
  "approval", "user",
];

/**
 * Every provider every installed manifest declares (plan DD1).
 *
 * THERE IS NO SECOND LIST. `ALL_MANIFESTS` is already the one place that answers "which modules
 * exist" (Plan 11d D2), so search reads it rather than growing a registry of its own — which is
 * the whole of §2.54's lesson applied before the drift instead of after it.
 */
export function collectProviders(registry: ModuleRegistry): SearchProvider[] {
  const providers = registry.all().flatMap((m) => m.search ?? []);
  const seen = new Set<string>();
  const declared = new Set(registry.allPermissions());
  for (const p of providers) {
    if (seen.has(p.key)) {
      throw new SearchError("duplicate_provider", `duplicate search provider key: ${p.key}`);
    }
    seen.add(p.key);
    if (!declared.has(p.permission)) {
      throw new SearchError(
        "undeclared_permission",
        `search provider "${p.key}" declares permission "${p.permission}", which no manifest declares — ` +
          "a provider gated on a permission nothing declares is a provider no role can ever reach",
      );
    }
  }
  return providers;
}

function emptyGroup(p: SearchProvider, over: Partial<SearchGroup> = {}): SearchGroup {
  return { entity: p.entity, provider: p.key, hits: [], total: 0, timedOut: false, errored: false, ...over };
}

/**
 * Run ONE provider under its budget.
 *
 * Neither a slow provider nor a broken one may take the palette down with it (DD8), and the two
 * are reported DIFFERENTLY on purpose: `timedOut` says "incomplete, try narrowing", `errored` says
 * "this module is broken" — collapsing them would let a thrown exception hide behind a plausible
 * timeout for as long as nobody read the logs.
 */
async function runProvider(p: SearchProvider, ctx: Omit<SearchProviderCtx, "signal">): Promise<SearchGroup> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, PROVIDER_BUDGET_MS);
  });
  try {
    const outcome = await Promise.race([p.run({ ...ctx, signal: controller.signal }), budget]);
    if (outcome === "timeout") return emptyGroup(p, { timedOut: true });
    return { entity: p.entity, provider: p.key, hits: outcome.hits, total: outcome.total, timedOut: false, errored: false };
  } catch {
    return emptyGroup(p, { errored: true });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type SearchAllOptions = { perEntity?: number; entities?: string[] };

/**
 * The federated search (plan DD1/DD8).
 *
 * THE PERMISSION DECISION HAPPENS BEFORE THE QUERY, NOT AFTER IT. A provider the caller may not
 * use is never invoked at all — it is not run-then-filtered, because a filtered result still cost
 * a query against records the caller had no right to have touched, and no audit could tell the
 * two apart afterwards.
 */
export async function searchAll(
  db: Db,
  registry: ModuleRegistry,
  actor: Actor,
  query: SearchQuery,
  opts: SearchAllOptions = {},
): Promise<SearchResponse> {
  if (actor.type !== "user") {
    throw new SearchError("user_actor_required", "search is a desk surface — user actors only");
  }
  const started = Date.now();
  const perEntity = Math.min(Math.max(opts.perEntity ?? DEFAULT_PER_ENTITY, 1), 50);

  // A chip is itself a query: `@patient <resolved> ` with no trailing text is "show me this
  // patient's things", so the character floor applies to FREE TEXT ONLY.
  if (query.text.trim().length < MIN_QUERY_CHARS && query.chips.length === 0) {
    return { groups: [], tookMs: Date.now() - started, skipped: [] };
  }

  const wanted = collectProviders(registry).filter(
    (p) => opts.entities === undefined || opts.entities.includes(p.entity),
  );

  const permitted = await Promise.all(
    wanted.map(async (p) => ({ p, ok: await hasPermission(db, actor.id, p.permission, "hospital") })),
  );
  const skipped = permitted.filter((x) => !x.ok).map((x) => x.p.key);
  const runnable = permitted.filter((x) => x.ok).map((x) => x.p);

  const groups = await Promise.all(
    runnable.map((p) => runProvider(p, { db, actor, query, limit: perEntity })),
  );

  groups.sort((a, b) => {
    const ia = ENTITY_ORDER.indexOf(a.entity);
    const ib = ENTITY_ORDER.indexOf(b.entity);
    return (ia === -1 ? ENTITY_ORDER.length : ia) - (ib === -1 ? ENTITY_ORDER.length : ib);
  });

  return { groups, tookMs: Date.now() - started, skipped };
}
