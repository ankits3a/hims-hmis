---
name: module-knowledge
description: How the repo's knowledge files work — the generated architecture map, hand-written module MAP.md notes, and docs/decisions records with OKF frontmatter and a generated index. Use when reading a module before a change, or when adding a decision, a module note, routes, tables or exports.
---

# Module knowledge

- `docs/architecture/` is generated from the source by `node tools/arch/gen.mjs`; CI runs `--check`. After changing
  module imports, an `index.ts`, routes, tables or web routes, regenerate and commit. On a rebase conflict in
  `docs/architecture/`, regenerate instead of merging by hand.
- `apps/core/src/modules/<m>/MAP.md`: hand-written flows, invariants, traps, callers (billing, roster, tariff so far).
  OKF frontmatter (`type: module-notes`, `resource`, `generated`, `verified`, `stale_after`). Update it in the same PR as a
  flow or trap change. Cite a file and a symbol, never a line number — `--check` fails on line numbers and missing files.
  `stale_after` only warns.
- `docs/decisions/NNNN-*.md`: one file per owner ruling, OKF frontmatter (`type: decision`, `id`, `title`, `description`,
  `generated`, `verified: []`, `status` stable|draft|deprecated, `ruling` ruled|partly-open|superseded, `tags`,
  `supersedes`/`superseded_by` both ways, `sources`). `index.md` and `README.md` are generated — run `gen.mjs`, never edit
  them by hand. `verified` gets `{ by: human:owner, at }` only when the owner confirms a record.
