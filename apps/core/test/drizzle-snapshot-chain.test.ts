import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══ THE SNAPSHOT CHAIN, AND THE ONE SHAPE THAT BREAKS `db:generate` FOR EVERY LANE ═══
 *
 * `drizzle-kit generate` diffs the TypeScript schema against the LAST snapshot and writes a new one
 * carrying `prevId` — the id of the snapshot it was built on. That single field is the chain.
 *
 * **The failure this file exists for is a FORK: two snapshots naming the same `prevId`.** It happens
 * when two lanes generate from the same tip and both land — measured on this repo 2026-09-06, when
 * `0079` and radiology's migration both pointed at `0077` and `drizzle-kit generate` refused in all
 * thirteen worktrees until PR #149 repaired it by re-pointing one `prevId`. It nearly happened again
 * on 2026-09-13: `#186` was to be RENAMED `0082 -> 0084` behind `#183`/`#184`, and a rename moves the
 * filename, the journal `idx` and the `tag` but **not** `prevId`, which lives inside the snapshot —
 * so it would have shipped chaining onto `0081` and skipping two migrations. It was regenerated
 * instead, which recomputes `prevId`, and the assertions below now hold for `0084`.
 *
 * ═══ WHY THIS DOES **NOT** ASSERT `journal.entries.length === snapshot files` ═══
 *
 * That check looks like the obvious guard and **it would fire on this repository today, which is
 * sound.** Measured 2026-09-14 on `8fe7a78c`: 85 journal entries, 78 snapshot files. Seven entries
 * have no snapshot —
 *
 *     0050_form_f_completion              0066_encounter_attribution_code
 *     0057_uhid_floor_11000               0067_registration_demographics_coverage
 *     0058_entitlement_counter_unit       0068_department_token_series
 *     0059_lab_analyte_applicability
 *
 * — and **they were never created, not deleted.** The proof is the chain itself: every surviving
 * snapshot's `prevId` names a snapshot that EXISTS, and the links step straight over the holes
 * (`0051 -> 0049`, `0060 -> 0056`, `0069 -> 0065`). Had those seven ever existed, their successors
 * would name them and the references would dangle. They do not.
 *
 * All seven are HAND-WRITTEN migrations — prose headers, `IF NOT EXISTS` throughout — authored with a
 * journal entry added by hand and `generate` never run. Everything they create is nevertheless
 * present in the head snapshot (`patients.father_husband_name`, `opd_department_tokens`, …) and **no
 * other `.sql` re-emits any of it**, so a later generate absorbed them into the chain without
 * duplicating the DDL. Proved at the artefact rather than the exit code: `drizzle-kit generate` on a
 * clean tree reports *"No schema changes"*, writes no file, and leaves the tree clean.
 *
 * So the chain has **no gap — only the file NUMBERING does.** A completeness check would report a
 * healthy repository as broken, and a guard that cries wolf on a sound tree is worse than no guard:
 * the next person silences it, and the fork it was meant to catch walks through. The invariants
 * below are the ones that are actually true and actually load-bearing.
 *
 * **Nothing here needs a database.** The chain is a filesystem artefact and this suite is
 * milliseconds, so it can run wherever the static checks run.
 */

const DRIZZLE = join(__dirname, "..", "drizzle");
const META = join(DRIZZLE, "meta");
/** drizzle's own sentinel for "this is the first snapshot" — never a real id. */
const GENESIS = "00000000-0000-0000-0000-000000000000";

type Snapshot = { file: string; id: string; prevId: string | null };
type JournalEntry = { idx: number; tag: string; when: number };

function snapshots(): Snapshot[] {
  return readdirSync(META)
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .sort()
    .map((file) => {
      const d = JSON.parse(readFileSync(join(META, file), "utf8")) as { id: string; prevId: string | null };
      return { file, id: d.id, prevId: d.prevId };
    });
}

function journal(): JournalEntry[] {
  const d = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return d.entries;
}

describe("the drizzle snapshot chain", () => {
  /**
   * **THE FORK, AND THE WHOLE REASON THIS FILE EXISTS.** Two snapshots claiming the same parent is
   * what two lanes generating from one tip produce, and `drizzle-kit generate` then refuses for
   * everybody. It is one line to detect and it has cost this repo two incidents.
   */
  it("no two snapshots name the same prevId — the fork that stops db:generate in every worktree", () => {
    const byPrev = new Map<string, string[]>();
    for (const s of snapshots()) {
      if (s.prevId === null || s.prevId === GENESIS) continue;
      byPrev.set(s.prevId, [...(byPrev.get(s.prevId) ?? []), s.file]);
    }
    const forks = [...byPrev.entries()].filter(([, files]) => files.length > 1);
    expect(forks).toEqual([]);
  });

  /**
   * A `prevId` pointing at nothing is the other half of the same damage — a rename or a hand-edit
   * that moved a file without moving the link. Note this is exactly what the seven absent snapshots
   * do NOT do, which is how we know they were never written.
   */
  it("every prevId names a snapshot that exists — no dangling link", () => {
    const snaps = snapshots();
    const ids = new Set(snaps.map((s) => s.id));
    const dangling = snaps
      .filter((s) => s.prevId !== null && s.prevId !== GENESIS && !ids.has(s.prevId))
      .map((s) => `${s.file} -> ${String(s.prevId)}`);
    expect(dangling).toEqual([]);
  });

  /** Exactly one root, and it is the lowest-numbered file. Two roots is a fork wearing another hat. */
  it("exactly one snapshot is the root, and it is the first", () => {
    const snaps = snapshots();
    const roots = snaps.filter((s) => s.prevId === null || s.prevId === GENESIS);
    expect(roots.map((r) => r.file)).toEqual([snaps[0]!.file]);
  });

  /**
   * ═══ THE WATERMARK RULE, AT THE JOURNAL ═══
   *
   * `drizzle-orm`'s migrator reads `meta/_journal.json` and `<tag>.sql` and **nothing else** — it
   * never opens a snapshot, and it decides what to apply by comparing `when` against the newest
   * `created_at` the database has already applied. A `when` that dips below its predecessor is
   * therefore a migration that will be SILENTLY SKIPPED on any database already past it, with exit 0
   * and no row. Monotonic-by-merge-order is the only property safe under every deploy schedule.
   */
  it("the journal's `when` is strictly increasing — a dip is a migration silently skipped for ever", () => {
    const w = journal().map((e) => e.when);
    const dips = w.slice(1).map((x, i) => (x <= w[i]! ? `${String(i)}->${String(i + 1)}` : null)).filter(Boolean);
    expect(dips).toEqual([]);
  });

  it("the journal's `idx` is contiguous from zero — a hole is a serial nobody can take", () => {
    expect(journal().map((e) => e.idx)).toEqual(journal().map((_e, i) => i));
  });

  /**
   * The migrator reads `<tag>.sql` by name and throws if it is absent. A journal entry without its
   * file is a deploy that dies partway, which is the one failure here with a production blast radius.
   */
  it("every journal entry has its .sql file — what the migrator actually opens", () => {
    const missing = journal().filter((e) => !existsSync(join(DRIZZLE, `${e.tag}.sql`))).map((e) => e.tag);
    expect(missing).toEqual([]);
  });
});
