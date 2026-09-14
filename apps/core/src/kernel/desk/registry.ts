import { hasPermission } from "../auth/permissions";
import { DeskError } from "./types";
import type { DeskCard, DeskProvider, DeskProviderCtx, ReportSection } from "./types";
import { assertRange, mergeBuckets, totalsOf } from "./range";
import type { RangeCtx, RangeRow } from "./range";
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


/**
 * PHASE STAFF-REPORTS T3 — THE BREAKDOWN, COMPOSED ACROSS MODULES.
 *
 * Same gate as `loadDesk` and `loadReport`, applied the same way: a module's provider is RUN only
 * if the caller holds its permission, never run-then-filtered — which would read the data for a
 * module the person may not see and then discard it.
 *
 * ═══ THE GATE IS THE ROUTE'S, NOT THE MODULE'S — AND THAT IS A DELIBERATE DIVERGENCE ═══
 *
 * `loadDesk` runs a provider only if the caller holds that MODULE's permission, and `loadReport`
 * only if the SUBJECT does. This one runs every provider that declares a range, and the gate is
 * `staff.reports.read` on the route above it. Three composers, three gates, because they answer
 * three different questions:
 *
 *   - the desk asks *"what may I do"* — a projection of the caller's own permissions;
 *   - the report asks *"what did this person do"* — correctly limited to what that person could do;
 *   - this asks *"what did the hospital do"*, and `desk/manifest.ts` already rules on who may ask:
 *     **"a holder of `staff.reports.read` may read ANY active user's figures."**
 *
 * Gating this one on the READER's module permissions was the first thing written here, by copying
 * `loadDesk`, and it is wrong in a way worth recording: a supervisor who holds `staff.reports.read`
 * but not `opd.queue.read` — which is most of them, since supervising is not working a counter —
 * would get a report with NO OPD ROWS AT ALL. Not an error. An empty table, which reads as a quiet
 * month. That is the same silent-zero failure `requireSubject` and `rollup.ts` both already refuse,
 * arriving through a permission check that looked like prudence.
 *
 * What keeps it safe is the response shape rather than a second gate: `mergeBuckets` refuses any
 * value that is not a non-negative integer, so nothing here can carry a patient, a name or a note.
 * Whose rows come back is a FILTER (`filters.userIds`), never an identity.
 *
 * ═══ A PROVIDER THAT THROWS IS NOT SWALLOWED HERE ═══
 *
 * `loadDesk` swallows, and its doc explains why: the desk is the front door and a broken module
 * must not blank it. A REPORT is the opposite bargain. A total silently missing one module's
 * contribution is a wrong number that looks like a right one — it will be exported, mailed and
 * reconciled — so this lets the failure out and the caller sees an error instead of an
 * understatement.
 */
export async function loadRange(
  providers: DeskProvider[], ctx: RangeCtx,
): Promise<{ rows: RangeRow[]; totals: Record<string, number> }> {
  assertRange(ctx.filters);
  const contributing = providers.filter((p) => p.range !== undefined);
  const buckets = (await Promise.all(contributing.map((p) => p.range!(ctx)))).flat();
  const rows = mergeBuckets(buckets, ctx.groupBy);
  return { rows, totals: totalsOf(rows) };
}
