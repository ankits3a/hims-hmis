import { sql } from "drizzle-orm";
import { FormularyError } from "./errors";
import { isMoiety } from "./moiety";
import { adoptionRef, attestSubstance, attesterId, ruleSubstanceUnmappable } from "./mapping";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { AttestTarget, ProjectionResult } from "./mapping";

/**
 * ═══ ADOPTION: EVERY PENDING SUBSTANCE DECIDED UNDER ONE NAMED RESOLUTION (formulary phase 3) ═══
 *
 * Owner ruling 2026-09-16 (phase-3 doc §1): nobody reviews the ~3,300 release substances one by
 * one. The P&T committee's standard answer applies instead: a reference source is ADOPTED by
 * resolution. The reference is the release's own statements, plus model drafts that a second,
 * independent pass checked.
 *
 * WHAT THIS IS NOT: a second writer. Every decision goes through `attestSubstance` or
 * `ruleSubstanceUnmappable`, so each one keeps the row lock, the projection, the event and the
 * refusals. The actor is still a PERSON (`attester_not_user`): the one who adopts. Every row and
 * every event names the resolution, so an adopted decision can never be read as a pharmacist's own
 * attestation.
 *
 * WHAT IT NEVER DOES:
 * - Override a decision. A substance someone already decided is reported and left alone.
 * - Target another substance's unreviewed release entry. It decides that substance first, when it
 *   is in the same adoption; it uses that substance's moiety, when it is already mapped; otherwise
 *   it refuses the item by name.
 *
 * It is one transaction, owned by the caller: the script runs it and rolls back for a dry run.
 */
export type AdoptionItem =
  | { sctid: string; decision: "moiety"; moietyName: string; reason: string }
  | { sctid: string; decision: "unmappable"; reason: string };

export type AdoptionReport = {
  resolution: string;
  /** Items that recorded a decision. */
  mapped: number;
  ruledUnmappable: number;
  /** How the mapped ones found their moiety. */
  createdMoieties: number;
  ownEntries: number;
  /** Named another substance's entry; that substance's moiety was used instead. */
  redirected: { sctid: string; named: string; used: string }[];
  /** Agreement with the substance's own draft, as the P&T scorecard will count it. */
  agreedWithDraft: number;
  disagreedWithDraft: number;
  noDraft: number;
  /** Already decided by someone: never overridden. */
  alreadyDecided: string[];
  /** Could not be adopted, and why. */
  refused: { sctid: string; moietyName: string; why: string }[];
  projection: ProjectionResult;
  /** Pending substances left in the whole release tier after this adoption. */
  pendingAfter: number;
};

type SaltByName = { id: string; name: string; active: boolean; source_ref: string | null; moiety: boolean };

export async function adoptDecisions(
  tx: Tx, actor: Actor, resolution: string, items: readonly AdoptionItem[],
): Promise<AdoptionReport> {
  attesterId(actor); // a person adopts, checked before anything is read
  const ref = adoptionRef(resolution);
  if (ref === null) throw new FormularyError("invalid_adoption", "an adoption names its resolution");
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.sctid)) throw new FormularyError("invalid_adoption", `substance ${item.sctid} appears twice`);
    seen.add(item.sctid);
    if (item.decision === "moiety" ? item.moietyName.trim() === "" : item.decision !== "unmappable") {
      throw new FormularyError("invalid_adoption", `substance ${item.sctid}: a decision needs a kind and a moiety name`);
    }
    if (item.reason.trim() === "") throw new FormularyError("invalid_adoption", `substance ${item.sctid}: a decision needs a reason`);
  }

  const substances = new Map<string, { id: string; status: string }>();
  const sctids = [...seen];
  for (let i = 0; i < sctids.length; i += 1000) {
    const rows = await tx.execute<{ id: string; sctid: string; mapping_status: string }>(sql`
      select id, sctid, mapping_status from formulary_substances
       where sctid = any(${sql.param(sctids.slice(i, i + 1000))}::text[])
    `);
    for (const r of rows.rows) substances.set(r.sctid, { id: r.id, status: r.mapping_status });
  }
  const unknown = sctids.filter((s) => !substances.has(s));
  if (unknown.length > 0) {
    // A file for another release is not something to half-adopt.
    throw new FormularyError("unknown_substance", `${String(unknown.length)} substance(s) are not in this release tier: ${unknown.slice(0, 10).join(", ")}`, { unknown });
  }

  const report: AdoptionReport = {
    resolution: ref, mapped: 0, ruledUnmappable: 0, createdMoieties: 0, ownEntries: 0, redirected: [],
    agreedWithDraft: 0, disagreedWithDraft: 0, noDraft: 0, alreadyDecided: [], refused: [],
    projection: { rowsMoved: 0, medicinesMoved: 0, medicinesBlocked: 0 }, pendingAfter: 0,
  };
  const add = (p: ProjectionResult): void => {
    report.projection.rowsMoved += p.rowsMoved;
    report.projection.medicinesMoved += p.medicinesMoved;
    report.projection.medicinesBlocked += p.medicinesBlocked;
  };

  let queue: AdoptionItem[] = [];
  for (const item of items) {
    if (substances.get(item.sctid)?.status === "pending") queue.push(item);
    else report.alreadyDecided.push(item.sctid);
  }
  const queued = (sctid: string): boolean => queue.some((q) => q.sctid === sctid);

  // Unmappable rulings first: they never wait on another substance.
  for (const item of queue) {
    if (item.decision !== "unmappable") continue;
    const decided = await ruleSubstanceUnmappable(tx, actor, substances.get(item.sctid)!.id, {
      reason: item.reason, adoptedUnder: ref,
    });
    add(decided.projection);
    report.ruledUnmappable += 1;
  }
  queue = queue.filter((q) => q.decision === "moiety");

  /*
    To a fixed point: an item naming another substance's unreviewed entry waits until that
    substance is decided in this same pass. Each round decides at least one item or stops.
  */
  let progress = true;
  while (progress && queue.length > 0) {
    progress = false;
    const waiting: AdoptionItem[] = [];
    for (const item of queue) {
      if (item.decision !== "moiety") continue;
      const outcome = await adoptOne(tx, actor, ref, substances.get(item.sctid)!.id, item, queued);
      if (outcome.kind === "wait") { waiting.push(item); continue; }
      progress = true;
      if (outcome.kind === "refused") {
        report.refused.push({ sctid: item.sctid, moietyName: item.moietyName, why: outcome.why });
        continue;
      }
      report.mapped += 1;
      add(outcome.projection);
      if (outcome.created) report.createdMoieties += 1;
      if (outcome.ownEntry) report.ownEntries += 1;
      if (outcome.redirectedTo !== null) {
        report.redirected.push({ sctid: item.sctid, named: item.moietyName, used: outcome.redirectedTo });
      }
      if (outcome.agreed === null) report.noDraft += 1;
      else if (outcome.agreed) report.agreedWithDraft += 1;
      else report.disagreedWithDraft += 1;
    }
    queue = waiting;
  }
  for (const item of queue) {
    if (item.decision !== "moiety") continue;
    report.refused.push({
      sctid: item.sctid, moietyName: item.moietyName,
      why: "names another substance's release entry, and that substance's own decision names it too: a cycle",
    });
  }

  const left = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from formulary_substances where mapping_status = 'pending'
  `);
  report.pendingAfter = left.rows[0]?.n ?? 0;
  return report;
}

type OneOutcome =
  | { kind: "wait" }
  | { kind: "refused"; why: string }
  | {
    kind: "mapped"; projection: ProjectionResult; created: boolean; ownEntry: boolean;
    redirectedTo: string | null; agreed: boolean | null;
  };

async function adoptOne(
  tx: Tx, actor: Actor, ref: string, substanceId: string,
  item: Extract<AdoptionItem, { decision: "moiety" }>,
  queued: (sctid: string) => boolean,
): Promise<OneOutcome> {
  const name = item.moietyName.trim();
  // lower(name) is unique across formulary_salts, so this is at most one row.
  const found = await tx.execute<SaltByName>(sql`
    select s.id, s.name, s.active, s.source_ref, ${isMoiety(sql`s`)} as moiety
      from formulary_salts s where lower(s.name) = lower(${name})
  `);
  const salt = found.rows[0];

  let target: AttestTarget;
  let targetName = name;
  let redirectedTo: string | null = null;
  if (salt === undefined) {
    target = { newMoiety: { name } };
  } else if (!salt.active) {
    return { kind: "refused", why: `the moiety "${salt.name}" exists and is inactive: the hospital withdrew it` };
  } else if (salt.moiety || salt.source_ref === item.sctid) {
    target = { saltId: salt.id };
    targetName = salt.name;
  } else {
    // Another substance's release entry that nobody has decided on.
    const owner = await tx.execute<{ sctid: string; mapping_status: string; salt_id: string | null; salt_name: string | null }>(sql`
      select o.sctid, o.mapping_status, o.salt_id, m.name as salt_name
        from formulary_substances o left join formulary_salts m on m.id = o.salt_id
       where o.sctid = ${salt.source_ref}
    `);
    const o = owner.rows[0];
    if (o !== undefined && o.mapping_status === "pending" && queued(o.sctid)) return { kind: "wait" };
    if (o === undefined || o.mapping_status !== "mapped" || o.salt_id === null || o.salt_name === null) {
      return {
        kind: "refused",
        why: `"${salt.name}" is the release entry of substance ${salt.source_ref ?? "?"}, which is ${o?.mapping_status ?? "absent"} and not in this adoption`,
      };
    }
    target = { saltId: o.salt_id };
    targetName = o.salt_name;
    redirectedTo = o.salt_name;
  }

  const draft = await tx.execute<{ id: string }>(sql`
    select p.id from formulary_mapping_proposals p
     where p.substance_id = ${substanceId}
     order by (lower(btrim(p.moiety_name)) = lower(${targetName})) desc,
              case p.basis when 'release_boss' then 0 when 'release_base' then 1 else 2 end,
              p.drafted_by
     limit 1
  `);
  const proposalId = draft.rows[0]?.id ?? null;

  const decision = await attestSubstance(tx, actor, substanceId, target, { proposalId, adoptedUnder: ref });
  const agreed = proposalId === null
    ? null
    : (await tx.execute<{ agreed: boolean }>(sql`
        select lower(btrim(p.moiety_name)) = lower(s.name) as agreed
          from formulary_mapping_proposals p, formulary_salts s
         where p.id = ${proposalId} and s.id = ${decision.saltId}
      `)).rows[0]?.agreed ?? null;
  return {
    kind: "mapped", projection: decision.projection,
    created: "newMoiety" in target,
    ownEntry: "saltId" in target && salt !== undefined && salt.source_ref === item.sctid,
    redirectedTo, agreed,
  };
}
