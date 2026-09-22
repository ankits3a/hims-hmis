# HANDOFF — the formulary lane after phase 2, 2026-09-16 (evening)

**Read this, `CLAUDE.md`, and `2026-09-16-phase2-formulary-mapping-loop.md` §1, §3.6–3.7 and §5.**
Nothing else is required.

Everything below that is not a command is a claim about 2026-09-16. The previous handoff was wrong
about three things (production's location, a curve label, and which files carried a figure); each
was cheap to check. Check these the same way.

---

## 1. STATE, AND HOW TO RE-MEASURE IT

| | at handoff | re-measure with |
|---|---|---|
| `origin/main` | `c03080ed` (#210) on top of `e8da7851` (#203) | `git fetch origin && git log --oneline -3 origin/main` |
| migrations | 98; `0096_backfill_encounter_refs`, `0097_formulary_mapping_loop` | `python3 -c "import json;e=json.load(open('apps/core/drizzle/meta/_journal.json'))['entries'];print(len(e),e[-1]['tag'])"` |
| open work | **PR #211** (web + residuals + drafter reversal rule), CI running at handoff | `gh pr checks 211` |
| dev DB | `hmis_formulary_dev`: both tiers, 1,043 release + 474 model drafts, 27 substances mapped | `docker exec hmis-db-1 psql -U hmis -d hmis_formulary_dev -Atc "select mapping_status, count(*) from formulary_substances group by 1"` |
| model drafts | `/opt/hmis-context/nrces-2026-09-drafts/` (md5 `433339d9…`) | `md5sum /opt/hmis-context/nrces-2026-09-drafts/*.json` |
| production | owner: no loaded catalogue anywhere; `hmis-prod-*` IS on this box and is not ours to read | — |

If #211 is merged, the lane is done with this phase. If it is red on **both** CI runs, it is
real: read `gh run view --job <id> --log-failed | grep -E "FAIL |●"`.

## 2. WHAT THE OWNER DECIDED, AND WHAT THE OWNER STILL OWES

Rulings (owner delegated 2026-09-16, recorded in the phase doc §1):
- **R1:** no pharmacist hire; the system drafts, the pharmacist attests.
- **R2:** no catalogue is loaded anywhere.
- **R3:** load NRCeS with the worklist deploy.
- **R4:** #203 landed.

**Owed by the owner or the P&T committee:**
1. **Deploy, then the load sequence**, in the phase doc §5.2 order. `import-cds-catalogue` comes
   last, never first.
2. **Give a real person the `pharmacy` role.** `formulary.manage` is what the worklist needs.
3. **The mineral-salt policy.** The model skipped sodium chloride, sodium bicarbonate, zinc salts,
   magnesium and aluminium hydroxide and similar: is the moiety the ion or the compound? That is a
   P&T call, and it governs about 26 substances (`agent-drafts-skipped.md`).
4. **Read the model's ten least-certain drafts first** (README beside the file).

## 3. WHAT IS NEXT, IN THE ORDER IT PAYS

1. **The prescribing verdict for unreviewed lines** (phase doc §3.4). `searchMedicines` says
   `reviewed`, but `runRxChecks` still reports such a line as checked. The natural shape mirrors
   `unresolvedLineIndexes`: an `unreviewedLineIndexes` decided by the server, computed with
   `moiety.ts`'s `isMoiety` (one predicate, do not write a second), and shown on the consult screen.
   `opd-consult.tsx` is edited by several live lanes, so check `gh pr list` and the lanes' branches
   first (three-dot diffs only).
2. **The drafter's scorecard for the P&T committee.** Every `substance.mapped` event (module `formulary`)
   carries `agreedWithProposal` and the draft id. Agreement rate by `basis` is one query over
   `events`, and it is the evidence for whether the model half can be trusted with more.
3. **`activeSalts()`** still reads all 3,287 moieties on every free-text resolution (a PR-A
   residual).
4. **The retro-scan** of prescriptions issued before a projection moved their composition. It is
   buildable now: `derived_from` plus the `substance.mapped` event.
5. `opd-consult.tsx`'s "15 MB" prose, when no lane is editing that file.

## 4. THINGS THAT BIT THIS SESSION

- **A local test selection misses what it does not name.** `src/kernel/db/schema/formulary.test.ts`
  pins every formulary column. I ran `src/modules/formulary` and CI caught it on both runs. When a
  schema file changes, run `src/kernel/db/schema` too.
- **Jest's `expect` takes ONE argument** and throws at runtime if given a message (vitest's does
  not). A red from that looks like a real failure.
- **A grep exclusion with the wrong path prefix excludes nothing** (`^./modules` against output
  that prints `modules/…`).
- **The first "concurrent" test ran the two transactions in sequence** (the second connection
  opened late). Force the overlap: hold the first transaction open until `pg_stat_activity` shows
  the second one waiting.
- **A playwright `hasText` locator matched the wrong card**, because sample generics mention other
  substances. Select by heading.
- **Only the browser found five of this phase's defects** (phase doc §5.1). The recipe:
  - rebuild `hmis_formulary_dev` (migrate → `seed:roles` → `seed:formulary` → `import:nrces` →
    drafter → `import-cds-catalogue`);
  - `pnpm --filter @hmis/core run build`;
  - `seed:admin` with `ADMIN_USERNAME=pharma.demo` and a fresh password, plus a `role_assignments`
    row for `pharmacy`;
  - `PORT=3011 node dist/src/main.js` with the lane `.env` and that `DATABASE_URL`;
  - `VITE_API_TARGET=http://127.0.0.1:3011 npx vite --port 5181`;
  - playwright from `/root/.npm/_npx/e41f203b7505f1fb`. **Stop both processes when done.**

## 5. THE METHOD THAT PAID

- **Measure before planning.** The curve's first row, the production location and the name
  collision were all found by running a query, not by reading prose.
- **Seams before merge.** The allergy regression had both endpoints correct and no failing test
  until one was written through the real `runRxChecks`.
- **Mutate with a written prediction.** 35 mutants this phase (27 core, 8 web and boundary). Two tests were found to be unable
  to see what they claimed (the overlap test and the first rank test), and one mutant was invalid
  (a SQL syntax error) and was redone.
