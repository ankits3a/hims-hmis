import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, withTx } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { writeProposals } from "../src/modules/formulary";
import type { ProposalInput } from "../src/modules/formulary";
import type { Db } from "../src/kernel/db/client";

/**
 * `pnpm --filter @hmis/core exec tsx scripts/draft-substance-mappings.ts [--apply]`
 *     `[--agent-file <drafts.json>]`                 ingest a model's drafts (see AGENT FILE below)
 *     `[--export-undrafted <out.json> [--top <n>]]`  write what is left for a model to draft
 *
 * ═══ THE DRAFTER — HALF OF OWNER RULING R1, AND THE HALF THAT MAY NEVER DECIDE ANYTHING ═══
 *
 * `docs/superpowers/plans/2026-09-16-phase2-formulary-mapping-loop.md`. The ~500 substance → moiety
 * decisions are drafted by the system and attested by a pharmacist, one at a time. This writes
 * DRAFTS: rows in `formulary_mapping_proposals`, which nothing on the safety path reads. The one
 * write that records a decision is `attestSubstance`, and it refuses every actor that is not a
 * person. So this script has no actor at all, only a `drafted_by` label.
 *
 * It follows the loaders' doctrine (`import-cds-catalogue.ts`): PLAN, PRINT, and write nothing
 * without `--apply`. The dry run prints exactly what an applied run would write.
 *
 * ═══ THE RELEASE HALF: WHAT THE NATIONAL RELEASE ALREADY SAYS ═══
 *
 * A SNOMED CT clinical drug whose precise active ingredient is a salt names its basis of strength,
 * and the release's names say so in words: "Product containing precisely **amoxicillin** (as
 * **amoxicillin trihydrate**) 500 milligram …", or, in the release's shorter form, "**Amlodipine**
 * (as **amlodipine besylate**) 5 mg …". That is the salt → moiety step, stated by the national
 * release. Two drafts come from it:
 *
 *   release_boss  a substance named inside "(as …)" → the base the release names beside it;
 *   release_base  a substance the release NAMES AS SUCH A BASE → itself ("it is its own moiety").
 *
 * `release_base` is deliberately narrow. A substance that merely appears without "(as …)" is NOT
 * evidence of being a moiety: "precisely warfarin sodium 5 milligram" states strength AS the salt,
 * and drafting "Warfarin sodium is its own moiety" would invite exactly the second warfarin the
 * schema header warns about.
 *
 * ═══ THE RELEASE IS NOT ALWAYS RIGHT, SO THE DRAFTER VOTES AND SHOWS THE DISSENT ═══
 *
 * Measured in `nrces-2026-09`: generic 1621000189106 reads "Menthol (as guaifenesin) … Terbutaline
 * (as menthol)", with its components misaligned, and 1240358000 gives "(S)-metoprolol tartrate (as
 * (S)-metoprolol succinate)". So a statement counts only if its "(as …)" names one of THAT
 * generic's own linked substances. Where the release names several bases for one substance, the
 * draft takes the one most generics state and carries the rest in `evidence.alternatives` with
 * their counts. A hydrate word ("levofloxacin anhydrous") is dropped from the base and recorded,
 * and a base that then equals its own ingredient is not a statement at all.
 *
 * ═══ THE MODEL HALF: WHAT THE RELEASE DOES NOT SAY ═══
 *
 * About three quarters of the release's substances carry no such statement: many plain moieties
 * (`Paracetamol`) and some salts the release always expresses by salt (`Chlorphenamine maleate`).
 * Those are for a model. `--export-undrafted` writes them, most-used first, with what a model needs
 * to see. `--agent-file` takes the model's answer back. The server makes no model call:
 * `kernel/inference` is the one door for that, and Plan 12a owns it. So the model runs outside, as
 * an agent, and its drafts arrive as a file carrying the model's name and a rationale per item.
 *
 * AGENT FILE:
 *
 *     { "model": "<model id>", "release": "nrces-2026-09",
 *       "items": [ { "sctid": "…", "moietyName": "…", "rationale": "…" } ] }
 *
 * An sctid the release tier does not hold refuses the whole file, by name. A file drafted against
 * another release is not something to half-apply.
 */

// ─────────────────────────────── the release half, pure ───────────────────────────────

/** "(substance)" is SNOMED's semantic tag, not part of the name. */
export function stripSemanticTag(name: string): string {
  return name.replace(/\s*\((?:substance|product)\)\s*$/i, "").trim();
}

const HYDRATE = /\s+(anhydrous|monohydrate|dihydrate|trihydrate|tetrahydrate|pentahydrate|hexahydrate|heptahydrate|hemihydrate|sesquihydrate)$/i;
/** A base that carries a strength is a parse that ran into the previous component. */
const STRENGTH = /\d\s*(?:milli|micro|nano|gram|mg\b|g\b|ml\b|mcg\b|unit|iu\b|%)/i;
const PLAIN_NAME = /^[a-z][a-z0-9 ,'+-]*$/i;

export type BasisStatement = { base: string; ingredient: string; droppedWord: string | null };

/**
 * Every "BASE (as INGREDIENT)" statement in one clinical-drug name.
 *
 * The ingredient is read with balanced parentheses. The base is the text since the last component
 * boundary: the start of the name, "precisely ", or " and ". A base that is not a plain name is
 * skipped, not guessed at: one with a strength means the boundary was missed, and one with
 * parentheses is `(S)-metoprolol`, whose one statement in this release is wrong anyway.
 */
export function parseBasisStatements(genericName: string): BasisStatement[] {
  const out: BasisStatement[] = [];
  const marker = /\(as\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(genericName)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < genericName.length && depth > 0; i += 1) {
      if (genericName[i] === "(") depth += 1;
      else if (genericName[i] === ")") depth -= 1;
    }
    if (depth !== 0) break;
    const ingredient = genericName.slice(start, i - 1).trim();

    const before = genericName.slice(0, m.index);
    const lower = before.toLowerCase();
    /* `lastIndexOf` answers -1 for "absent", and -1 plus a length is a plausible wrong offset. */
    const after = (needle: string): number => {
      const at = lower.lastIndexOf(needle);
      return at === -1 ? 0 : at + needle.length;
    };
    const cut = Math.max(after(" and "), after("precisely "));
    let base = before.slice(cut).trim();
    if (base === "" || !PLAIN_NAME.test(base) || STRENGTH.test(base)) continue;
    let droppedWord: string | null = null;
    const hydrate = HYDRATE.exec(base);
    if (hydrate !== null) {
      droppedWord = (hydrate[1] as string).toLowerCase();
      base = base.slice(0, hydrate.index).trim();
    }
    if (base.toLowerCase() === ingredient.toLowerCase()) continue;
    out.push({ base: base.toLowerCase(), ingredient, droppedWord });
  }
  return out;
}

/**
 * A base and its salt share a stem: "amoxicillin" / "amoxicillin trihydrate", "clavulanic acid" /
 * "potassium clavulanate". The release's misaligned statements do not: "menthol" / "guaifenesin".
 * Those pass the own-substance check (guaifenesin IS in that product), so this is the check that
 * catches them. The cost is that a real statement between two unrelated-looking names is dropped
 * to the model half. That is the cheap direction: a missing draft costs a pharmacist a search,
 * while a confident wrong one invites a wrong attestation.
 */
export function sharesStem(base: string, ingredient: string): boolean {
  const head = base.toLowerCase().split(/[\s-]+/)[0] ?? "";
  if (head === "") return false;
  return ingredient.toLowerCase().split(/[\s-]+/).some((word) => {
    let n = 0;
    while (n < head.length && n < word.length && head[n] === word[n]) n += 1;
    // Four, not five: "amoxycillin" (the spelling Indian labels use) and "amoxicillin" share only "amox".
    return n >= Math.min(4, head.length, word.length);
  });
}

export type ReleaseSubstance = { sctid: string; name: string; synonyms: string[] };
export type ReleaseGeneric = { sctid: string; name: string; substanceSctids: string[] };

export type ReleasePlan = {
  proposals: ProposalInput[];
  report: {
    statements: number;
    /** "(as X)" naming none of that generic's own substances: the release contradicting itself. */
    unmatchedStatements: number;
    /** A base sharing no stem with its ingredient ("Menthol (as guaifenesin)"): misaligned, dropped. */
    dissonantStatements: number;
    /** Statements the release also makes the other way round as often or more: the minority direction, dropped. */
    reversedStatements: number;
    releaseBoss: number;
    releaseBase: number;
    /** Substances for which the release names more than one base. */
    contested: number;
  };
};

const SAMPLE = 3;

export function planReleaseDrafts(substances: ReleaseSubstance[], generics: ReleaseGeneric[]): ReleasePlan {
  const bySctid = new Map(substances.map((s) => [s.sctid, s] as const));
  const namesOf = (s: ReleaseSubstance): Set<string> =>
    new Set([s.name, ...s.synonyms].map((n) => stripSemanticTag(n).toLowerCase()).filter((n) => n !== ""));

  /** substance sctid → base → the generics stating it */
  const stated = new Map<string, Map<string, { sctid: string; name: string }[]>>();
  const dropped = new Map<string, string>();
  const basesNamed = new Map<string, { sctid: string; name: string }[]>();
  let statements = 0;
  let unmatched = 0;
  let dissonant = 0;
  let reversed = 0;

  type Kept = { subject: ReleaseSubstance; base: string; droppedWord: string | null; generic: { sctid: string; name: string } };
  const kept: Kept[] = [];
  const subjectName = (s: ReleaseSubstance): string => stripSemanticTag(s.name).toLowerCase();
  for (const g of generics) {
    const own = g.substanceSctids.map((id) => bySctid.get(id)).filter((s): s is ReleaseSubstance => s !== undefined);
    for (const st of parseBasisStatements(g.name)) {
      statements += 1;
      const ingredient = st.ingredient.toLowerCase();
      const subject = own.find((s) => namesOf(s).has(ingredient));
      if (subject === undefined) { unmatched += 1; continue; }
      if (!sharesStem(st.base, st.ingredient)) { dissonant += 1; continue; }
      kept.push({ subject, base: st.base, droppedWord: st.droppedWord, generic: { sctid: g.sctid, name: g.name } });
    }
  }

  /*
    THE RELEASE SOMETIMES STATES A PAIR BOTH WAYS. Measured: 38 clinical drugs say "clavulanic acid
    (as clavulanate potassium)" and one says "Clavulanate potassium (as clavulanic acid)". Taken at
    its word, the one would draft the salt as the moiety of the base. So for any pair stated in both
    directions only the direction more generics state survives, and a tie drops both: the release
    has not said which way round it is.
  */
  const pairKey = (base: string, subject: ReleaseSubstance): string => `${base}|${subjectName(subject)}`;
  const directed = new Map<string, number>();
  for (const k of kept) directed.set(pairKey(k.base, k.subject), (directed.get(pairKey(k.base, k.subject)) ?? 0) + 1);
  for (const { subject, base, droppedWord, generic } of kept) {
    const forward = directed.get(pairKey(base, subject)) ?? 0;
    const backward = directed.get(`${subjectName(subject)}|${base}`) ?? 0;
    if (backward >= forward) { reversed += 1; continue; }

    const perBase = stated.get(subject.sctid) ?? new Map<string, { sctid: string; name: string }[]>();
    perBase.set(base, [...(perBase.get(base) ?? []), generic]);
    stated.set(subject.sctid, perBase);
    if (droppedWord !== null) dropped.set(`${subject.sctid}|${base}`, droppedWord);
    basesNamed.set(base, [...(basesNamed.get(base) ?? []), generic]);
  }

  const proposals: ProposalInput[] = [];
  let contested = 0;
  let releaseBase = 0;
  for (const s of substances) {
    const perBase = stated.get(s.sctid);
    if (perBase !== undefined) {
      // Majority, then alphabetical: deterministic, so a re-run writes the same draft.
      const ranked = [...perBase.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      const [base, support] = ranked[0] as [string, { sctid: string; name: string }[]];
      if (ranked.length > 1) contested += 1;
      const droppedWord = dropped.get(`${s.sctid}|${base}`);
      proposals.push({
        sctid: s.sctid, moietyName: base, basis: "release_boss",
        evidence: {
          generics: support.slice(0, SAMPLE), support: support.length,
          ...(ranked.length > 1 ? { alternatives: ranked.slice(1).map(([name, l]) => ({ name, support: l.length })) } : {}),
          ...(droppedWord === undefined ? {} : { droppedWord }),
        },
      });
      continue;
    }
    const own = stripSemanticTag(s.name);
    const asBase = basesNamed.get(own.toLowerCase());
    if (asBase !== undefined) {
      releaseBase += 1;
      proposals.push({
        sctid: s.sctid, moietyName: own, basis: "release_base",
        evidence: { generics: asBase.slice(0, SAMPLE), support: asBase.length },
      });
    }
  }
  return {
    proposals,
    report: {
      statements, unmatchedStatements: unmatched, dissonantStatements: dissonant, reversedStatements: reversed,
      releaseBoss: proposals.length - releaseBase, releaseBase, contested,
    },
  };
}

// ─────────────────────────────── the model half ───────────────────────────────

export const agentFileSchema = z.object({
  model: z.string().trim().min(1),
  release: z.string().trim().min(1),
  items: z.array(z.object({
    sctid: z.string().trim().min(1),
    moietyName: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(1000),
  }).strict()).min(1),
}).strict();

export function agentProposals(file: z.infer<typeof agentFileSchema>): ProposalInput[] {
  return file.items.map((i) => ({
    sctid: i.sctid, moietyName: i.moietyName, basis: "agent",
    evidence: { model: file.model, rationale: i.rationale },
  }));
}

// ─────────────────────────────── the run ───────────────────────────────

async function readRelease(db: Db): Promise<{ substances: ReleaseSubstance[]; generics: ReleaseGeneric[] }> {
  const subs = await db.execute<{ sctid: string; name: string; synonyms: string[] }>(sql`
    select sctid, name, synonyms from formulary_substances order by sctid
  `);
  const gens = await db.execute<{ sctid: string; name: string; substance_sctids: string[] }>(sql`
    select g.sctid, g.name, array_agg(s.sctid order by s.sctid) as substance_sctids
      from formulary_generics g
      join formulary_generic_substances gs on gs.generic_id = g.id
      join formulary_substances s on s.id = gs.substance_id
     group by g.sctid, g.name
     order by g.sctid
  `);
  return {
    substances: subs.rows,
    generics: gens.rows.map((g) => ({ sctid: g.sctid, name: g.name, substanceSctids: g.substance_sctids })),
  };
}

type Undrafted = { sctid: string; name: string; synonyms: string[]; coverage: number; sampleGenerics: string[] };

/** Pending substances with no draft from anyone, most-used first: the model's worklist. */
async function readUndrafted(db: Db, alsoDrafted: Set<string>, top: number): Promise<Undrafted[]> {
  const r = await db.execute<{ sctid: string; name: string; synonyms: string[]; coverage: number; samples: string[] | null }>(sql`
    select s.sctid, s.name, s.synonyms, coalesce(img.product_count, 0) as coverage,
           array(select g.name_normalized from formulary_generic_substances gs
                   join formulary_generics g on g.id = gs.generic_id
                  where gs.substance_id = s.id order by g.name_normalized limit 3) as samples
      from formulary_substances s
      left join formulary_salts img on img.source_ref = s.sctid
     where s.mapping_status = 'pending'
       and not exists (select 1 from formulary_mapping_proposals p where p.substance_id = s.id)
     order by coverage desc, s.sctid
  `);
  return r.rows
    .filter((x) => !alsoDrafted.has(x.sctid))
    .slice(0, top)
    .map((x) => ({
      sctid: x.sctid, name: stripSemanticTag(x.name), synonyms: x.synonyms,
      coverage: Number(x.coverage), sampleGenerics: x.samples ?? [],
    }));
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const agentPath = arg(args, "--agent-file");
  const exportPath = arg(args, "--export-undrafted");
  const top = Number(arg(args, "--top") ?? "500");
  if (!Number.isInteger(top) || top < 1) throw new Error("--top takes a positive integer");

  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  void (async () => {
    try {
      const release = await readRelease(db);
      if (release.substances.length === 0) {
        throw new Error("the release tier is empty — load it with import:nrces first; there is nothing to draft");
      }
      const plan = planReleaseDrafts(release.substances, release.generics);
      const r = plan.report;
      console.log("release drafts · drafter:release@1");
      console.log(`  substances            ${String(release.substances.length)}`);
      console.log(`  "(as …)" statements   ${String(r.statements)}`);
      console.log(`    ignored             ${String(r.unmatchedStatements)} name none of their own generic's substances`);
      console.log(`    ignored             ${String(r.dissonantStatements)} pair names sharing no stem (the release misaligned them)`);
      console.log(`    ignored             ${String(r.reversedStatements)} stated the other way round at least as often`);
      console.log(`  release_boss drafts   ${String(r.releaseBoss)}  (${String(r.contested)} contested: the release names more than one base)`);
      console.log(`  release_base drafts   ${String(r.releaseBase)}`);

      let agent: ProposalInput[] = [];
      let agentLabel = "";
      if (agentPath !== undefined) {
        const file = agentFileSchema.parse(JSON.parse(readFileSync(agentPath, "utf8")));
        agent = agentProposals(file);
        agentLabel = `agent:${file.model}`;
        console.log(`agent drafts · ${agentLabel} · release ${file.release} · ${String(agent.length)} items`);
      }

      if (exportPath !== undefined) {
        const drafted = new Set([...plan.proposals, ...agent].map((p) => p.sctid));
        const rows = await readUndrafted(db, drafted, top);
        const releases = (await db.execute<{ source: string }>(sql`select distinct source from formulary_substances order by source`))
          .rows.map((x) => x.source);
        writeFileSync(exportPath, `${JSON.stringify({ release: releases.join(","), items: rows }, null, 2)}\n`);
        console.log(`exported ${String(rows.length)} undrafted pending substances, most-used first → ${exportPath}`);
      }

      if (!apply) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); return; }
      const written = await withTx(db, async (tx) => {
        /* The release half is the WHOLE of what the release says, so a draft it no longer makes is withdrawn. */
        const rel = await writeProposals(tx, "drafter:release@1", plan.proposals, { withdrawOthers: true });
        if (rel.unknownSctids.length > 0) throw new Error(`release drafts name unknown substances: ${rel.unknownSctids.join(", ")}`);
        if (agent.length === 0) return { release: rel.written, withdrawn: rel.withdrawn, agent: 0 };
        const ag = await writeProposals(tx, agentLabel, agent);
        if (ag.unknownSctids.length > 0) {
          throw new Error(`the agent file names ${String(ag.unknownSctids.length)} substance(s) this release does not hold: `
            + `${ag.unknownSctids.slice(0, 10).join(", ")} — nothing was written`);
        }
        return { release: rel.written, withdrawn: rel.withdrawn, agent: ag.written };
      });
      console.log(`\nAPPLIED · release drafts ${String(written.release)} (${String(written.withdrawn)} withdrawn) · agent drafts ${String(written.agent)}`);
    } finally {
      await pool.end();
    }
  })().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

/* Guarded so a test can import the planner without the script running itself. */
if (require.main === module) main();
