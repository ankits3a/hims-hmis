import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import {
  formularyInteractions, formularyMedicineSalts, formularyMedicines, formularySalts,
} from "../../kernel/db/schema";
import { requireAllergyClasses } from "./allergy-vocabulary";
import { FormularyError } from "./errors";
import { normalizeDrugName } from "./resolve";
import {
  interactionAdded, interactionUpdated, medicineAdded, medicineCorrected, medicineUpdated,
  saltAdded, saltUpdated,
} from "./events";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";

export type SaltRow = typeof formularySalts.$inferSelect;
export type MedicineRow = typeof formularyMedicines.$inferSelect;
export type InteractionRow = typeof formularyInteractions.$inferSelect;

/** A medicine as the admin surfaces read it: the brand plus what it is made of. */
export type MedicineWithSalts = MedicineRow & { salts: { saltId: string; strength: string | null }[] };

export type RouteClass = "systemic" | "topical";
export type Severity = "severe" | "moderate";

/** The `billing/sessions.ts` helper, same shape: a raw 23505 under a race becomes a typed refusal. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/**
 * THERE IS NO `requireUserActor` HERE, AND THE ABSENCE IS A DECISION (T2, disclosed in CLOSE).
 *
 * `opd/masters.ts` carries one and throws `user_actor_required` for it. This module's error union
 * is CLOSED at the five codes the plan names, and none of them means that — so the choice was
 * between widening the union beyond the plan and leaving the guard out. It is left out, because
 * here it would be redundant rather than protective: every writer below is reachable only through
 * a route whose `RequirePermission` decorator demands `formulary.manage` at hospital scope, agents
 * hold no permissions at all (Plan 02's PermissionGuard; Plan 12a is the phase that gives them
 * any), and the module exports no other path to these functions. If 12a ever grants an agent
 * `formulary.manage`, THAT is the commit where this guard and its code belong.
 *
 * (The decorator is NAMED rather than written out with its parentheses on purpose.
 * `test/roles-catalog.e2e.test.ts` scans every non-test `.ts` file for that decorator's opening
 * token and requires a scope literal in each match — it cannot tell a real decorator from a
 * comment quoting one, and an earlier draft of this very comment failed that suite. CLOSE F8.)
 */

/**
 * PLAN 16a T2 — the formulary masters.
 *
 * Every writer takes `(tx, actor, …)` and appends its event inside the SAME transaction as the
 * row it describes (the `opd/masters.ts` + `allergies.ts` shape). The three reads at the bottom
 * take a `Db` and are what the controller and, later, `resolve.ts` build on.
 *
 * ═══ WHAT `addMedicine` REFUSES, AND WHY IT IS THE ONLY REFUSAL WITH A FLAG (DD8) ═══
 *
 * A fixed-dose combination whose own salts interact is a MARKETED PRODUCT — the pair is real, and
 * a prescriber can do nothing about it, which is why prescribing-time checks skip same-line pairs
 * entirely (spec §1.1). The place where that pair IS actionable is admission: a pharmacist typing
 * the composition can see it, judge it, and admit anyway. So the check lives here and takes an
 * explicit `acknowledgeIntraFdc`, and the event records which branch happened — an FDC admitted
 * over a known internal interaction is a fact somebody may want to find later.
 */
export async function addSalt(
  tx: Tx,
  actor: Actor,
  input: { name: string; aliases?: string[]; drugClass?: string | null; atcCode?: string | null; ndpsClass?: "narcotic" | "psychotropic" | null },
): Promise<{ saltId: string }> {
  const saltId = newId();
  const aliases = input.aliases ?? [];
  try {
    await tx.insert(formularySalts).values({
      id: saltId, name: input.name, aliases,
      drugClass: input.drugClass ?? null, atcCode: input.atcCode ?? null, ndpsClass: input.ndpsClass ?? null,
      createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    // `formulary_salts_name_lower_ux` is an EXPRESSION index, so there is no `onConflictDoNothing`
    // target to name — the refusal is read off the violation instead (the tariff `services.ts`
    // precedent, and the reason that file says a raw 23505 escaping a pre-check is expected).
    if (isUniqueViolation(e)) {
      throw new FormularyError("duplicate_name", `a moiety named "${input.name}" already exists`);
    }
    throw e;
  }
  await appendEvent(tx, saltAdded.make({
    payload: { saltId, name: input.name, drugClass: input.drugClass ?? null, aliases },
    actor, correlationId: saltId,
  }));
  return { saltId };
}

export async function updateSalt(
  tx: Tx,
  actor: Actor,
  saltId: string,
  patch: {
    name?: string; aliases?: string[]; drugClass?: string | null; atcCode?: string | null; active?: boolean; allergyClasses?: string[];
    /** PHARMACY P6 — the NDPS Act's class (`ndps.ts`). */
    ndpsClass?: "narcotic" | "psychotropic" | null;
  },
): Promise<void> {
  const existing = await tx.select().from(formularySalts).where(eq(formularySalts.id, saltId));
  if (existing[0] === undefined) throw new FormularyError("unknown_salt", `moiety ${saltId} not found`);
  // P22 — only a class the prescribing check knows, so a typo cannot record a class nothing reads.
  if (patch.allergyClasses !== undefined) patch = { ...patch, allergyClasses: requireAllergyClasses(patch.allergyClasses) };
  const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
  if (changed.length === 0) return;
  try {
    await tx.update(formularySalts)
      .set({ ...patch, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(formularySalts.id, saltId));
  } catch (e) {
    if (isUniqueViolation(e)) throw new FormularyError("duplicate_name", `that moiety name already exists`);
    throw e;
  }
  await appendEvent(tx, saltUpdated.make({ payload: { saltId, changed }, actor, correlationId: saltId }));
}

/** Throws `unknown_salt` naming the first id the formulary does not have. */
async function requireSalts(tx: Tx, saltIds: string[]): Promise<void> {
  if (saltIds.length === 0) return;
  const found = await tx.select({ id: formularySalts.id }).from(formularySalts)
    .where(inArray(formularySalts.id, saltIds));
  const have = new Set(found.map((r) => r.id));
  const missing = saltIds.find((id) => !have.has(id));
  if (missing !== undefined) throw new FormularyError("unknown_salt", `moiety ${missing} not found`);
}

/** DD8 — the pairs among a medicine's OWN salts. Empty for a single-moiety medicine, always. */
async function intraFdcPairs(
  tx: Tx,
  saltIds: string[],
): Promise<{ saltAId: string; saltBId: string; severity: string; note: string }[]> {
  if (saltIds.length < 2) return [];
  const rows = await tx.select({
    saltAId: formularyInteractions.saltAId, saltBId: formularyInteractions.saltBId,
    severity: formularyInteractions.severity, note: formularyInteractions.note,
  }).from(formularyInteractions).where(and(
    eq(formularyInteractions.active, true),
    inArray(formularyInteractions.saltAId, saltIds),
    inArray(formularyInteractions.saltBId, saltIds),
  ));
  return rows;
}

export async function addMedicine(
  tx: Tx,
  actor: Actor,
  input: {
    brandName: string; form: string; routeClass: RouteClass;
    strengthLabel?: string | null; scheduleFlag?: string | null;
    salts: { saltId: string; strength?: string | null }[];
    stagingId?: string | null; acknowledgeIntraFdc?: boolean;
  },
): Promise<{ medicineId: string }> {
  const saltIds = input.salts.map((s) => s.saltId);
  // M4 — a medicine with no composition resolves to "known, and contains nothing", which C3 showed
  // is the shape that makes a check suite go quiet while reporting success. The controller's zod
  // schema blocks the HTTP path; the domain function must refuse it too, or the next caller
  // (a seed, a script, 16b) mints one.
  if (saltIds.length === 0) {
    throw new FormularyError("unknown_salt", `"${input.brandName}" needs at least one moiety`);
  }
  await requireSalts(tx, saltIds);

  const pairs = await intraFdcPairs(tx, saltIds);
  if (pairs.length > 0 && input.acknowledgeIntraFdc !== true) {
    throw new FormularyError(
      "intra_fdc_interaction",
      `"${input.brandName}" contains an interacting pair — admit anyway?`,
      { pairs },
    );
  }

  const medicineId = newId();
  try {
    await tx.insert(formularyMedicines).values({
      id: medicineId, brandName: input.brandName, form: input.form, routeClass: input.routeClass,
      nameNormalized: normalizeDrugName(input.brandName),
      strengthLabel: input.strengthLabel ?? null, scheduleFlag: input.scheduleFlag ?? null,
      stagingId: input.stagingId ?? null, createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new FormularyError("duplicate_name", `a medicine named "${input.brandName}" already exists`);
    }
    throw e;
  }
  if (input.salts.length > 0) {
    await tx.insert(formularyMedicineSalts).values(input.salts.map((s) => ({
      // A pharmacist typed this. Stated, not defaulted — see the table's header.
      medicineId, saltId: s.saltId, strength: s.strength ?? null, source: "curated" as const,
    })));
  }
  await appendEvent(tx, medicineAdded.make({
    payload: {
      medicineId, brandName: input.brandName, routeClass: input.routeClass, saltIds,
      stagingId: input.stagingId ?? null, intraFdcAcknowledged: pairs.length > 0,
    },
    actor, correlationId: medicineId,
  }));
  return { medicineId };
}

/**
 * A composition change emits `medicine.corrected`; anything else emits `medicine.updated`. The
 * decision is made HERE by comparing what is stored to what is asked for — never by a caller-
 * supplied flag, because the caller who could choose would eventually choose the quiet one, and
 * the retro-scan spec §1.1 defers reads this name to find its work.
 */
export async function updateMedicine(
  tx: Tx,
  actor: Actor,
  medicineId: string,
  patch: {
    brandName?: string; form?: string; routeClass?: RouteClass;
    strengthLabel?: string | null; scheduleFlag?: string | null; active?: boolean;
    salts?: { saltId: string; strength?: string | null }[];
    /** DD8, same acknowledgement `addMedicine` requires — see the gate below (C6). */
    acknowledgeIntraFdc?: boolean;
  },
): Promise<void> {
  const existing = await tx.select().from(formularyMedicines).where(eq(formularyMedicines.id, medicineId));
  const row = existing[0];
  if (row === undefined) throw new FormularyError("unknown_medicine", `medicine ${medicineId} not found`);

  const { salts, ...attributes } = patch;
  const changed = Object.keys(attributes).filter((k) => attributes[k as keyof typeof attributes] !== undefined);

  let compositionChanged = false;
  let fromSaltIds: string[] = [];
  let toSaltIds: string[] = [];
  if (salts !== undefined) {
    toSaltIds = salts.map((s) => s.saltId);
    /**
     * M4 AT THE SECOND DOOR — the same guard `addMedicine` applies above, and for the same reason
     * it gives: a medicine with no composition resolves to "known, and contains nothing", which is
     * the shape that makes a check suite go quiet while reporting success.
     *
     * This path did not have it. `salts: []` passed `requireSalts([])` and `intraFdcPairs([])`,
     * which both return early on an empty list, then deleted every composition row at :247 and
     * re-inserted none because :248 is guarded by `if (salts.length > 0)` — so the curation surface
     * could mint the exact row the other door refuses, and appended `medicine.corrected` recording
     * that it had done so. It is the same failure C6 found on this pair three paragraphs down:
     * TWO DOORS, ONE LOCK. `curation-door-parity.test.ts` now holds both guards as a class.
     *
     * A brand that should no longer be prescribed is DEACTIVATED (`active: false`), which keeps its
     * composition readable for the labels and refusals that still name it. Emptying it is not a
     * quieter way of saying the same thing; it is a way of saying nothing while looking checked.
     */
    if (toSaltIds.length === 0) {
      throw new FormularyError(
        "unknown_salt",
        `"${patch.brandName ?? row.brandName}" needs at least one moiety — deactivate it instead of emptying it`,
      );
    }
    await requireSalts(tx, toSaltIds);
    /**
     * C6 (independent review) — DD8 HAS TWO DOORS AND ONLY ONE HAD A LOCK. `addMedicine` refuses an
     * FDC whose own salts interact unless a pharmacist acknowledges it; this path accepted the same
     * composition silently. Creating the medicine single-salt and PATCHing the interacting pair in
     * walked straight past the gate, and the `medicine.corrected` event recorded no acknowledgement.
     */
    const pairs = await intraFdcPairs(tx, toSaltIds);
    if (pairs.length > 0 && patch.acknowledgeIntraFdc !== true) {
      throw new FormularyError(
        "intra_fdc_interaction",
        `"${patch.brandName ?? row.brandName}" would contain an interacting pair — admit anyway?`,
        { pairs },
      );
    }
    const current = await tx.select({ saltId: formularyMedicineSalts.saltId })
      .from(formularyMedicineSalts).where(eq(formularyMedicineSalts.medicineId, medicineId));
    fromSaltIds = current.map((r) => r.saltId);
    compositionChanged = [...fromSaltIds].sort().join("|") !== [...toSaltIds].sort().join("|");
    await tx.delete(formularyMedicineSalts).where(eq(formularyMedicineSalts.medicineId, medicineId));
    if (salts.length > 0) {
      await tx.insert(formularyMedicineSalts).values(salts.map((s) => ({
        medicineId, saltId: s.saltId, strength: s.strength ?? null, source: "curated" as const,
      })));
    }
  }

  if (changed.length > 0) {
    try {
      /*
        A RENAME MUST RE-NORMALIZE. `name_normalized` is a cache of `normalizeDrugName(brandName)`,
        and the two going out of step is silent in the direction that matters: the row keeps
        resolving under its OLD name and stops resolving under its new one, so a prescription typed
        as the brand the pharmacist just corrected to falls through to `legacySubstringMatch` while
        the screen reports that the advanced checks are unavailable.
      */
      await tx.update(formularyMedicines)
        .set({
          ...attributes,
          ...(attributes.brandName === undefined ? {} : { nameNormalized: normalizeDrugName(attributes.brandName) }),
          updatedBy: actor.id, updatedAt: new Date(),
        })
        .where(eq(formularyMedicines.id, medicineId));
    } catch (e) {
      if (isUniqueViolation(e)) throw new FormularyError("duplicate_name", `that brand name already exists`);
      throw e;
    }
  }

  if (compositionChanged) {
    await appendEvent(tx, medicineCorrected.make({
      payload: { medicineId, brandName: patch.brandName ?? row.brandName, fromSaltIds, toSaltIds },
      actor, correlationId: medicineId,
    }));
  }
  if (changed.length > 0) {
    await appendEvent(tx, medicineUpdated.make({
      payload: { medicineId, changed }, actor, correlationId: medicineId,
    }));
  }
}

/**
 * The pair is normalized before insert so the schema's `salt_a_id < salt_b_id` check can never be
 * the thing a curator meets. The CHECK is still what makes this trustworthy: it means a row that
 * arrived by any other path is unstorable, not merely unusual.
 */
export async function addInteraction(
  tx: Tx,
  actor: Actor,
  input: {
    saltAId: string; saltBId: string; severity: Severity; note: string; source: string;
    routeScope?: "systemic_only" | null;
  },
): Promise<{ interactionId: string }> {
  await requireSalts(tx, [input.saltAId, input.saltBId]);
  const [saltAId, saltBId] = input.saltAId < input.saltBId
    ? [input.saltAId, input.saltBId]
    : [input.saltBId, input.saltAId];
  const interactionId = newId();
  const routeScope = input.routeScope ?? null;
  try {
    await tx.insert(formularyInteractions).values({
      id: interactionId, saltAId, saltBId, severity: input.severity, note: input.note,
      source: input.source, routeScope, createdBy: actor.id, updatedBy: actor.id,
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new FormularyError("duplicate_name", "that interaction pair is already recorded");
    }
    throw e;
  }
  await appendEvent(tx, interactionAdded.make({
    payload: { interactionId, saltAId, saltBId, severity: input.severity, source: input.source, routeScope },
    actor, correlationId: interactionId,
  }));
  return { interactionId };
}

export async function updateInteraction(
  tx: Tx,
  actor: Actor,
  interactionId: string,
  patch: { severity?: Severity; note?: string; routeScope?: "systemic_only" | null; active?: boolean },
): Promise<void> {
  const existing = await tx.select().from(formularyInteractions)
    .where(eq(formularyInteractions.id, interactionId));
  if (existing[0] === undefined) {
    throw new FormularyError("unknown_interaction", `interaction ${interactionId} not found`);
  }
  const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
  if (changed.length === 0) return;
  await tx.update(formularyInteractions)
    .set({ ...patch, updatedBy: actor.id, updatedAt: new Date() })
    .where(eq(formularyInteractions.id, interactionId));
  await appendEvent(tx, interactionUpdated.make({
    payload: { interactionId, changed }, actor, correlationId: interactionId,
  }));
}

// ─────────────────────────────────────── the reads ───────────────────────────────────────

/**
 * THE THREE UNBOUNDED READERS THAT USED TO LIVE HERE ARE GONE, NOT CAPPED.
 *
 * `listSalts`, `listMedicines` and `listInteractions` each answered "give me the whole table".
 * `listMedicines` did it by reading every row and then asking for the composition with an `inArray`
 * over every id, which THROWS `08P01` past 65,535 rows — see `kernel/db/any-of.ts`. Their
 * replacements are in `reads.ts` and their names carry their bounds: `pageMedicines`, `pageSalts`,
 * `pageInteractions`, `medicinesByIds`, `saltsByIds`, `countSalts`, `catalogueCensus`.
 *
 * They were DELETED rather than given a `limit` because a capped version leaves the unbounded
 * question spellable, and the next caller spells it and gets a silently short answer.
 * `index.test.ts` freezes the module's export list so they cannot quietly return.
 */
