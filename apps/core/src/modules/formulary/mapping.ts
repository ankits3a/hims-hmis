import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { decodeCursor, finishPage, pageLimit } from "../../kernel/db/page";
import { escapeLike } from "../../kernel/search/text";
import { formularyMappingProposals, formularySubstances } from "../../kernel/db/schema";
import { FormularyError } from "./errors";
import { substanceMapped, substanceRuledUnmappable } from "./events";
import { addSalt } from "./masters";
import { isMoiety } from "./moiety";
import { requireCursorRow } from "./reads";
import type { SQL } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { Page, PageRequest } from "../../kernel/db/page";
import type { MappingProposalEvidence } from "../../kernel/db/schema";

/**
 * ═══ THE MAPPING LOOP — A DRAFTER PROPOSES, A PHARMACIST ATTESTS ═══
 *
 * Owner ruling R1, 2026-09-16 (`docs/superpowers/plans/2026-09-16-phase2-formulary-mapping-loop.md`).
 * The national release names 3,283 substances, 1,006 of them as a salt form, and the checks need
 * the active MOIETY ("warfarin", not "warfarin sodium"). Collapsing a salt form to its moiety is a
 * clinical act. So the release waits in `formulary_substances`, a drafter writes proposals
 * beside it, and this file holds the one write that records a decision, which only a person can
 * make.
 *
 * ═══ WHAT HAPPENS WHEN A PHARMACIST DECIDES: THE PROJECTION ═══
 *
 * Every derived composition row names the release substance it came from (`derived_from`). A
 * decision re-points exactly those rows, IN THE SAME TRANSACTION:
 *
 *   mapped      → the curated moiety the pharmacist chose
 *   otherwise   → the release image (the importer's verbatim copy of that substance)
 *
 * **Per row, not per medicine.** An Augmentin whose amoxicillin is mapped and whose clavulanate is
 * not has one curated row and one release-image row. That composition is COMPLETE: no component
 * is missing. So it is not the partial composition DECIDED 3 forbids, which is a composition with
 * components DROPPED. Projecting row by row puts amoxicillin's drug class under the allergy check
 * the moment amoxicillin is attested, rather than when every co-ingredient in the catalogue has
 * been.
 *
 * **Two refusals, and each refuses the whole medicine rather than part of it:**
 *   - a medicine with any `curated` row is a pharmacist's own statement and is never touched
 *     (the schema header's rule for every derivation writer);
 *   - a medicine whose rows would name ONE moiety twice (two salt forms of a drug in one product)
 *     cannot be stored under the join's primary key. Merging the two strengths into one row is a
 *     representation choice for a person, so the medicine stays where it is and is counted.
 *
 * The release image is never deleted, so a correction or an "unmappable" ruling can always move
 * rows back. That is W10's refusal (keep `source_ref`) doing its job.
 *
 * ═══ AND THE COMMONEST DECISION MOVES NOTHING: "THIS SUBSTANCE IS ITS OWN MOIETY" ═══
 *
 * Most release substances are already moieties (`Paracetamol`, `Telmisartan`), and the importer has
 * already written each one's release image under that name. A pharmacist says so by choosing the
 * substance's OWN entry. The rows are already there, and the entry becomes a moiety because a mapped
 * substance now points at it (`moiety.ts`). This is also the only way such a moiety can exist: the
 * name is taken, so a curated duplicate cannot be created.
 */

// ─────────────────────────────── who may decide ───────────────────────────────

/**
 * A `switch` with no `default`, returning the id, so a fifth `Actor` member stops compiling here
 * rather than arriving with whatever the last branch did (`kernel/orders/place.ts`, 22c-A).
 * It runs before anything is read: a refused actor learns nothing about the substance.
 */
export function attesterId(actor: Actor): string {
  switch (actor.type) {
    case "user":
      return actor.id;
    case "agent":
    case "system":
    case "patient":
      throw new FormularyError(
        "attester_not_user",
        `a ${actor.type} actor may not decide what a release substance is — a drafter proposes, a pharmacist attests`,
      );
  }
}

/**
 * A decision adopted in bulk names the resolution it was adopted under (phase-3 doc §1). A
 * pharmacist's own decision, or correction, names none, and so clears the mark.
 */
export function adoptionRef(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const ref = raw.trim();
  if (ref === "" || ref.length > 200) {
    throw new FormularyError("invalid_adoption", "an adoption names its resolution in 1 to 200 characters");
  }
  return ref;
}

type SubstanceStatus = "pending" | "mapped" | "unmappable";

type LockedSubstance = {
  id: string; sctid: string; status: SubstanceStatus; saltId: string | null; mappedBy: string | null;
};

/**
 * `FOR UPDATE`: two pharmacists deciding one substance serialise here. The second one reads the
 * first one's decision after it commits, and is refused as `substance_already_decided`, which is
 * true, instead of silently overwriting it.
 */
async function lockSubstance(tx: Tx, substanceId: string): Promise<LockedSubstance> {
  const rows = await tx.select({
    id: formularySubstances.id, sctid: formularySubstances.sctid,
    status: formularySubstances.mappingStatus, saltId: formularySubstances.saltId,
    mappedBy: formularySubstances.mappedBy,
  }).from(formularySubstances).where(eq(formularySubstances.id, substanceId)).for("update");
  const row = rows[0];
  if (row === undefined) throw new FormularyError("unknown_substance", `release substance ${substanceId} not found`);
  return { ...row, status: row.status as SubstanceStatus };
}

/**
 * A plain decision is for an undecided substance; changing a decided one is a CORRECTION and must
 * say so. The two are different acts in the audit, and letting the first quietly become the second
 * would let a stale screen overwrite a colleague's ruling.
 */
function requireDecisionState(current: LockedSubstance, correction: boolean): void {
  if (!correction && current.status !== "pending") {
    throw new FormularyError(
      "substance_already_decided",
      `this substance was already ruled ${current.status} by ${current.mappedBy ?? "the importer"} — to change it, correct it and give a reason`,
    );
  }
  if (correction && current.status === "pending") {
    throw new FormularyError("substance_not_decided", "nobody has decided this substance yet, so there is nothing to correct");
  }
}

/**
 * The ONE spelling of "a draft names this moiety". The worklist's `existingSaltId` and the
 * attestation's `agreedWithProposal` both use it, in SQL, so Postgres `lower()` is the only case
 * fold involved and the two can never disagree about the same pair (`kernel/db/page.ts`, LAW 1:
 * JavaScript and Postgres lowercase `İ` differently).
 */
function namesMoiety(proposalName: SQL, saltName: SQL): SQL {
  return sql`lower(btrim(${proposalName})) = lower(${saltName})`;
}

export type ProjectionResult = { rowsMoved: number; medicinesMoved: number; medicinesBlocked: number };

export type MappingDecision = {
  substanceId: string;
  status: "mapped" | "unmappable";
  saltId: string | null;
  projection: ProjectionResult;
};

/**
 * `saltId` names an existing row: a curated moiety, a release entry a pharmacist already
 * attested, or THIS substance's own entry ("it is its own moiety"). `newMoiety` creates one.
 */
export type AttestTarget =
  | { saltId: string }
  | { newMoiety: { name: string; drugClass?: string | null } };

// ─────────────────────────────── the two decisions ───────────────────────────────

/**
 * A pharmacist states which curated moiety a release substance is.
 *
 * `newMoiety` creates the moiety and maps to it in ONE act, through `addSalt`, so its
 * `duplicate_name` refusal and its event are the masters' own. A draft naming a moiety that does
 * not exist yet is the common case for the first few hundred decisions.
 *
 * `correctionReason` present means "change a decided substance"; absent means "decide an
 * undecided one". See `requireDecisionState`.
 */
export async function attestSubstance(
  tx: Tx,
  actor: Actor,
  substanceId: string,
  target: AttestTarget,
  opts: { proposalId?: string | null; correctionReason?: string | null; adoptedUnder?: string | null } = {},
): Promise<MappingDecision> {
  const userId = attesterId(actor);
  const correctionReason = opts.correctionReason?.trim() || null;
  const adoptedUnder = adoptionRef(opts.adoptedUnder);
  const current = await lockSubstance(tx, substanceId);
  requireDecisionState(current, correctionReason !== null);

  let saltId: string;
  let createdMoiety = false;
  let ownEntry = false;
  if ("newMoiety" in target) {
    ({ saltId } = await addSalt(tx, actor, {
      name: target.newMoiety.name.trim(), drugClass: target.newMoiety.drugClass ?? null,
    }));
    createdMoiety = true;
  } else {
    const rows = await tx.execute<{ id: string; active: boolean; source_ref: string | null; moiety: boolean }>(sql`
      select s.id, s.active, s.source_ref, ${isMoiety(sql`s`)} as moiety
        from formulary_salts s where s.id = ${target.saltId}
    `);
    const salt = rows.rows[0];
    // An inactive moiety is one the hospital withdrew. It may stay on old rows; it may not be newly chosen.
    if (salt === undefined || !salt.active) {
      throw new FormularyError("unknown_salt", `no active moiety ${target.saltId}`);
    }
    ownEntry = salt.source_ref === current.sctid;
    /*
      ANOTHER substance's entry that nobody has reviewed is refused, even though a pharmacist might
      be right about it. Choosing it would turn that entry into a moiety as a side effect of
      deciding something else, and the substance it belongs to would never get its own attestation.
      Decide that one first. It is usually the base, and the worklist puts bases first by coverage.
    */
    if (salt.moiety !== true && !ownEntry) {
      throw new FormularyError(
        "release_image_target",
        "that is the release's entry for a different substance, and nobody has reviewed it yet — decide that substance first, or choose a moiety",
      );
    }
    saltId = salt.id;
  }
  if (current.status === "mapped" && current.saltId === saltId) {
    // A "correction" to the moiety already recorded changes nothing, and must not look like it did.
    throw new FormularyError("substance_already_decided", "this substance is already mapped to that moiety");
  }

  const agreedWithProposal = await proposalAgreement(tx, substanceId, opts.proposalId ?? null, saltId);

  const now = new Date();
  const updated = await tx.update(formularySubstances).set({
    saltId, mappingStatus: "mapped", mappedBy: userId, mappedAt: now, adoptedUnder, updatedBy: userId, updatedAt: now,
  }).where(and(
    eq(formularySubstances.id, substanceId), eq(formularySubstances.mappingStatus, current.status),
  )).returning({ id: formularySubstances.id });
  if (updated.length !== 1) {
    // Unreachable under the row lock. Refused rather than assumed, because a decision that did
    // not land must never emit an event saying it did.
    throw new FormularyError("substance_already_decided", "this substance changed while it was being decided");
  }

  const projection = await projectSubstances(tx, { sctids: [current.sctid] });
  await appendEvent(tx, substanceMapped.make({
    payload: {
      substanceId, sctid: current.sctid, saltId,
      fromStatus: current.status, fromSaltId: current.saltId,
      createdMoiety, ownEntry,
      proposalId: opts.proposalId ?? null, agreedWithProposal,
      correctionReason,
      adoptedUnder,
      projection,
    },
    actor, correlationId: substanceId,
  }));
  return { substanceId, status: "mapped", saltId, projection };
}

/**
 * A pharmacist rules that a release substance is not a moiety at all: a grouper concept, an
 * excipient, a vehicle. Its rows go back to the release image, and the products stay unreviewed.
 * That is the honest state for a product with a component nobody can name as a drug.
 */
export async function ruleSubstanceUnmappable(
  tx: Tx,
  actor: Actor,
  substanceId: string,
  opts: { reason: string; correction?: boolean; adoptedUnder?: string | null },
): Promise<MappingDecision> {
  const userId = attesterId(actor);
  const reason = opts.reason.trim();
  const adoptedUnder = adoptionRef(opts.adoptedUnder);
  const current = await lockSubstance(tx, substanceId);
  requireDecisionState(current, opts.correction === true);
  if (current.status === "unmappable") {
    throw new FormularyError("substance_already_decided", "this substance is already ruled unmappable");
  }

  const now = new Date();
  const updated = await tx.update(formularySubstances).set({
    saltId: null, mappingStatus: "unmappable", mappedBy: userId, mappedAt: now, adoptedUnder, updatedBy: userId, updatedAt: now,
  }).where(and(
    eq(formularySubstances.id, substanceId), eq(formularySubstances.mappingStatus, current.status),
  )).returning({ id: formularySubstances.id });
  if (updated.length !== 1) {
    throw new FormularyError("substance_already_decided", "this substance changed while it was being decided");
  }

  const projection = await projectSubstances(tx, { sctids: [current.sctid] });
  await appendEvent(tx, substanceRuledUnmappable.make({
    payload: {
      substanceId, sctid: current.sctid,
      fromStatus: current.status, fromSaltId: current.saltId,
      reason, adoptedUnder, projection,
    },
    actor, correlationId: substanceId,
  }));
  return { substanceId, status: "unmappable", saltId: null, projection };
}

/**
 * Null when no draft was on screen, which is a different fact from "disagreed". A draft id that
 * belongs to another substance is REFUSED: agreement is the P&T committee's measure of the
 * drafter, and it must never be recorded against the wrong draft.
 */
async function proposalAgreement(
  tx: Tx, substanceId: string, proposalId: string | null, saltId: string,
): Promise<boolean | null> {
  if (proposalId === null) return null;
  const res = await tx.execute<{ substance_id: string; agrees: boolean }>(sql`
    select p.substance_id,
           ${namesMoiety(sql`p.moiety_name`, sql`s.name`)} as agrees
      from formulary_mapping_proposals p
      join formulary_salts s on s.id = ${saltId}
     where p.id = ${proposalId}
  `);
  const row = res.rows[0];
  if (row === undefined || row.substance_id !== substanceId) {
    throw new FormularyError("unknown_proposal", `draft ${proposalId} is not a draft for this substance`);
  }
  return row.agrees === true;
}

// ─────────────────────────────── the projection ───────────────────────────────

/**
 * Re-point every derived row that came from the given release substances at whatever those
 * substances are now decided to be. `"all"` is for the catalogue importer, which writes rows that
 * may belong to substances a pharmacist mapped before the catalogue arrived.
 *
 * ONE STATEMENT. The plan, the refusals and the move read one snapshot, so no row can change
 * between being judged and being moved. It returns counts rather than rows because the importer's
 * scope is the whole catalogue.
 *
 * `target` resolution, per row:
 *   - substance mapped                 → its curated moiety
 *   - otherwise, a release image exists → the release image
 *   - otherwise                         → where the row already is. That covers E8: the importer
 *     reused a curated moiety by exact name, so there is no image to return to.
 */
export async function projectSubstances(
  tx: Tx, scope: { sctids: readonly string[] } | "all",
): Promise<ProjectionResult> {
  if (scope !== "all" && scope.sctids.length === 0) return { rowsMoved: 0, medicinesMoved: 0, medicinesBlocked: 0 };
  const which = scope === "all"
    ? sql`l.derived_from is not null`
    : sql`l.derived_from = any(${sql.param([...scope.sctids])}::text[])`;

  const res = await tx.execute<{ rows: number; medicines: number; blocked: number; salts: string[] | null }>(sql`
    with plan as (
      select l.medicine_id, l.salt_id as current,
             case when sub.mapping_status = 'mapped' then sub.salt_id
                  else coalesce(img.id, l.salt_id) end as target
        from formulary_medicine_salts l
        left join formulary_substances sub on sub.sctid = l.derived_from
        left join formulary_salts img on img.source_ref = l.derived_from
       where l.source = 'derived' and ${which}
    ),
    moving as (select * from plan where target <> current),
    touched as (select distinct medicine_id from moving),
    blocked as (
      select t.medicine_id
        from touched t
       where exists (select 1 from formulary_medicine_salts c
                      where c.medicine_id = t.medicine_id and c.source = 'curated')
          or (select count(*) from formulary_medicine_salts a where a.medicine_id = t.medicine_id)
             <> (select count(distinct coalesce(m.target, a.salt_id))
                   from formulary_medicine_salts a
                   left join moving m on m.medicine_id = a.medicine_id and m.current = a.salt_id
                  where a.medicine_id = t.medicine_id)
    ),
    moved as (
      update formulary_medicine_salts l
         set salt_id = m.target
        from moving m
       where l.medicine_id = m.medicine_id and l.salt_id = m.current and l.source = 'derived'
         and not exists (select 1 from blocked b where b.medicine_id = m.medicine_id)
      returning l.medicine_id, m.current, m.target
    )
    select (select count(*) from moved)::int                       as "rows",
           (select count(distinct medicine_id) from moved)::int    as "medicines",
           (select count(*) from blocked)::int                     as "blocked",
           (select array_agg(distinct x) from (select current as x from moved
                                               union select target from moved) s) as "salts"
  `);
  const row = res.rows[0];
  if (row === undefined) throw new Error("projectSubstances returned no row");
  const salts = row.salts ?? [];
  if (salts.length > 0) await refreshRankSignals(tx, { saltIds: salts });
  return { rowsMoved: Number(row.rows), medicinesMoved: Number(row.medicines), medicinesBlocked: Number(row.blocked) };
}

/**
 * ═══ THE TYPEAHEAD'S RANKING SIGNALS, AND ONE PLACE THAT COMPUTES THEM ═══
 *
 * `formulary_salts.product_count` and `formulary_medicines.salt_rank` were "derived and owned by the
 * import", and the import was their only writer. The projection is now a second one: moving
 * amoxicillin products from the release image onto the curated moiety moves the count with them.
 * Two writers with two copies of the formula is this lane's recurring defect, so the formula lives
 * here and the importer calls it too.
 *
 * Scoped by salt: a salt's count, and the rank of every medicine that contains one of those salts.
 * A medicine is included whether its own rows moved or only a co-ingredient's count did.
 */
export async function refreshRankSignals(tx: Tx, scope: { saltIds: readonly string[] } | "all"): Promise<void> {
  if (scope !== "all" && scope.saltIds.length === 0) return;
  const ids = scope === "all" ? null : sql.param([...scope.saltIds]);
  await tx.execute(sql`
    update formulary_salts s
       set product_count = coalesce((
             select count(*) from formulary_medicine_salts l where l.salt_id = s.id
           ), 0)
     where ${ids === null ? sql`true` : sql`s.id = any(${ids}::text[])`}
  `);
  await tx.execute(sql`
    update formulary_medicines m
       set salt_rank = coalesce((
             select max(s.product_count) from formulary_medicine_salts l
               join formulary_salts s on s.id = l.salt_id
              where l.medicine_id = m.id
           ), 0)
     where ${ids === null ? sql`true` : sql`exists (
             select 1 from formulary_medicine_salts l
              where l.medicine_id = m.id and l.salt_id = any(${ids}::text[]))`}
  `);
}

// ─────────────────────────────── the drafts ───────────────────────────────

export type ProposalBasis = "release_boss" | "release_base" | "agent";

export type ProposalInput = {
  sctid: string;
  moietyName: string;
  basis: ProposalBasis;
  evidence: MappingProposalEvidence;
};

export type ProposalWriteResult = { written: number; withdrawn: number; unknownSctids: string[] };

/**
 * Write one drafter's drafts. It replaces that drafter's earlier draft for the same substance and
 * leaves every other drafter's alone. A draft for a DECIDED substance is still written: it costs
 * nothing, and it is what a correction screen would show.
 *
 * An sctid the release tier does not hold is REFUSED AND NAMED, with nothing written. An agent file
 * drafted against a different release is not an input to quietly half-apply.
 *
 * `drafter` is a label, not an actor, because no actor is deciding anything here. It lands in
 * `drafted_by`, and the worklist shows it beside the draft.
 *
 * `withdrawOthers` is for a drafter whose run is the WHOLE of what it says (the release half): its
 * drafts for substances this run does not draft are deleted, so a statement the drafter has since
 * learned to distrust stops being shown. A model's file arrives in batches and never passes it.
 * Only this drafter's rows are ever touched.
 */
export async function writeProposals(
  tx: Tx, drafter: string, proposals: readonly ProposalInput[], opts: { withdrawOthers?: boolean } = {},
): Promise<ProposalWriteResult> {
  if (drafter.trim() === "") throw new Error("a drafter label is required");
  const sctids = [...new Set(proposals.map((p) => p.sctid))];
  const known = new Map<string, string>();
  for (let i = 0; i < sctids.length; i += 1000) {
    const rows = await tx.select({ id: formularySubstances.id, sctid: formularySubstances.sctid })
      .from(formularySubstances)
      .where(sql`${formularySubstances.sctid} = any(${sql.param(sctids.slice(i, i + 1000))}::text[])`);
    for (const r of rows) known.set(r.sctid, r.id);
  }
  const unknownSctids = sctids.filter((s) => !known.has(s));
  if (unknownSctids.length > 0) return { written: 0, withdrawn: 0, unknownSctids };

  const values = proposals.map((p) => ({
    id: newId(), substanceId: known.get(p.sctid) as string, moietyName: p.moietyName.trim(),
    basis: p.basis, evidence: p.evidence, draftedBy: drafter,
  }));
  for (let i = 0; i < values.length; i += 500) {
    await tx.insert(formularyMappingProposals).values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [formularyMappingProposals.substanceId, formularyMappingProposals.draftedBy],
        set: {
          moietyName: sql`excluded.moiety_name`, basis: sql`excluded.basis`,
          evidence: sql`excluded.evidence`, createdAt: sql`now()`,
        },
      });
  }
  let withdrawn = 0;
  if (opts.withdrawOthers === true) {
    const keep = [...known.values()];
    const gone = await tx.execute(sql`
      delete from formulary_mapping_proposals
       where drafted_by = ${drafter}
         and not (substance_id = any(${sql.param(keep)}::text[]))
    `);
    withdrawn = gone.rowCount ?? 0;
  }
  return { written: values.length, withdrawn, unknownSctids: [] };
}

// ─────────────────────────────── the worklist ───────────────────────────────

export type WorklistStatus = SubstanceStatus;

/**
 * What the draft's name already is in `formulary_salts`, so the screen can offer the right act:
 *   `moiety`       - a moiety: choose it;
 *   `own_entry`    - this substance's own release entry: "it is its own moiety";
 *   `other_entry`  - another substance's unreviewed entry: decide that one first (the server refuses it);
 *   `none`         - nothing by that name: create it.
 */
export type ExistingNameState = "moiety" | "own_entry" | "other_entry" | "none";

export type WorklistProposal = {
  id: string;
  moietyName: string;
  basis: ProposalBasis;
  evidence: MappingProposalEvidence;
  draftedBy: string;
  /** The ACTIVE row carrying the draft's name, if any. */
  existingSaltId: string | null;
  existingState: ExistingNameState;
};

export type WorklistItem = {
  id: string;
  sctid: string;
  /** Exactly as released. */
  name: string;
  synonyms: string[];
  status: WorklistStatus;
  saltId: string | null;
  saltName: string | null;
  mappedBy: string | null;
  mappedAt: Date | null;
  /** The resolution a decision was adopted under; null when `mappedBy` decided it on this worklist. */
  adoptedUnder: string | null;
  /** Products in the catalogue naming this substance's release image: the ordering, and the reason to do this one first. */
  coverage: number;
  /**
   * This substance's own release entry, if the catalogue importer wrote one. The screen offers it as
   * "it is its own moiety" whether or not a draft says so. Null on a release-only database (E11),
   * or where the importer reused a curated moiety of the same name (E8).
   */
  ownEntryId: string | null;
  /** Up to three clinical drugs containing it, as a prescriber reads them. */
  sampleGenerics: string[];
  /** Release drafts first, then model drafts. */
  proposals: WorklistProposal[];
};

const SAMPLE_GENERICS = 3;

/**
 * One page of release substances in one decision state, the most-used first.
 *
 * ORDER: coverage descending, then id. That is the owner's schedule (R1: the curve is the
 * delivery plan), and it is a keyset in the `kernel/db/page.ts` sense: the cursor names a row, and
 * the row's own `(coverage, id)` is read back in SQL from the same CTE the page is sorted by, so
 * the expression exists once. Coverage is mutable (LAW 4). A pending substance's coverage changes
 * only when one of its products is re-projected, and that cannot happen while it is pending, so
 * the pending list is stable in practice.
 *
 * A PULL LIST, NOT A BULK SURFACE. It serves a pharmacist one decision at a time. Nothing here, or
 * in the route above it, accepts more than one decision per request (R1's guard against
 * automation bias).
 */
export async function pageMappingWorklist(
  db: Db, opts: { status?: WorklistStatus; q?: string } & PageRequest = {},
): Promise<Page<WorklistItem>> {
  const limit = pageLimit(opts.limit);
  const afterId = decodeCursor(opts.cursor);
  const status = opts.status ?? "pending";
  const q = (opts.q ?? "").trim().toLowerCase();
  if (afterId !== null) await requireCursorRow(db, "formulary_substances", afterId);

  const res = await db.execute<{
    id: string; sctid: string; name: string; synonyms: string[]; mapping_status: string;
    salt_id: string | null; salt_name: string | null; mapped_by: string | null; mapped_at: Date | string | null;
    adopted_under: string | null;
    coverage: number; own_entry_id: string | null;
  }>(sql`
    with ranked as (
      select s.id, s.sctid, s.name, s.synonyms, s.mapping_status, s.salt_id, s.mapped_by, s.mapped_at,
             s.adopted_under, coalesce(img.product_count, 0) as coverage, img.id as own_entry_id
        from formulary_substances s
        left join formulary_salts img on img.source_ref = s.sctid
    )
    select r.*, m.name as salt_name
      from ranked r
      left join formulary_salts m on m.id = r.salt_id
     where r.mapping_status = ${status}
       ${q === "" ? sql`` : sql`and lower(r.name) like ${`%${escapeLike(q)}%`}`}
       ${afterId === null ? sql`` : sql`and (-r.coverage, r.id) > (
         select -c.coverage, c.id from ranked c where c.id = ${afterId})`}
     order by r.coverage desc, r.id asc
     limit ${limit + 1}
  `);
  const page = finishPage(res.rows, limit, (r) => r.id);
  if (page.items.length === 0) return { items: [], nextCursor: page.nextCursor };
  const ids = page.items.map((r) => r.id);

  const proposals = await db.execute<{
    id: string; substance_id: string; moiety_name: string; basis: string;
    evidence: MappingProposalEvidence; drafted_by: string; existing_salt_id: string | null;
    existing_state: ExistingNameState;
  }>(sql`
    select p.id, p.substance_id, p.moiety_name, p.basis, p.evidence, p.drafted_by,
           e.id as existing_salt_id,
           case when e.id is null then 'none'
                when ${isMoiety(sql`e`)} then 'moiety'
                when e.source_ref = sub.sctid then 'own_entry'
                else 'other_entry' end as existing_state
      from formulary_mapping_proposals p
      join formulary_substances sub on sub.id = p.substance_id
      -- lower(name) is unique across formulary_salts, so this is at most one row.
      left join formulary_salts e
        on e.active and ${namesMoiety(sql`p.moiety_name`, sql`e.name`)}
     where p.substance_id = any(${sql.param(ids)}::text[])
     order by case p.basis when 'release_boss' then 0 when 'release_base' then 1 else 2 end,
              p.drafted_by
  `);
  const bySubstance = new Map<string, WorklistProposal[]>();
  for (const p of proposals.rows) {
    const list = bySubstance.get(p.substance_id) ?? [];
    list.push({
      id: p.id, moietyName: p.moiety_name, basis: p.basis as ProposalBasis, evidence: p.evidence,
      draftedBy: p.drafted_by, existingSaltId: p.existing_salt_id, existingState: p.existing_state,
    });
    bySubstance.set(p.substance_id, list);
  }

  const samples = await db.execute<{ id: string; names: string[] | null }>(sql`
    select s.id,
           array(select g.name_normalized
                   from formulary_generic_substances gs
                   join formulary_generics g on g.id = gs.generic_id
                  where gs.substance_id = s.id
                  order by g.name_normalized
                  limit ${SAMPLE_GENERICS}) as names
      from formulary_substances s
     where s.id = any(${sql.param(ids)}::text[])
  `);
  const sampleOf = new Map(samples.rows.map((r) => [r.id, r.names ?? []] as const));

  return {
    items: page.items.map((r) => ({
      id: r.id, sctid: r.sctid, name: r.name, synonyms: r.synonyms,
      status: r.mapping_status as WorklistStatus,
      saltId: r.salt_id, saltName: r.salt_name,
      mappedBy: r.mapped_by,
      mappedAt: r.mapped_at === null ? null : new Date(r.mapped_at),
      adoptedUnder: r.adopted_under,
      coverage: Number(r.coverage),
      ownEntryId: r.own_entry_id,
      sampleGenerics: sampleOf.get(r.id) ?? [],
      proposals: bySubstance.get(r.id) ?? [],
    })),
    nextCursor: page.nextCursor,
  };
}
