---
type: decision
id: "0081"
title: "Specs live in docs/specs and change with the code; done-means become acceptance tests; GitHub milestones are the only roadmap"
description: "Owner 2026-10-14: approved feature specs move into the repo as docs/specs/<issue#>-<slug>.md, scrubbed for the public repo. spec-guard in CI fails a code PR that closes #N without touching its spec, and a PR that marks a spec built while a done-means id has no acceptance test named spec #N Dk. The ROADMAP files are superseded by GitHub milestones."
generated: { by: agent:claude, at: 2026-10-18 }
verified: []
status: stable
ruling: ruled
tags: [process, ci, docs]
supersedes: []
superseded_by: []
sources:
  - { id: spec-specs-in-git, resource: "docs/specs/695-specs-in-git.md", title: "Spec: specs live in git, carry their checks, one roadmap" }
---
# 0081 — Specs in git, done-means as tests, one roadmap

- **Date:** 2026-10-14   **Status:** Ruled
- **Area:** how every feature is specified, built and closed (#695, #696, #697)

## What is ruled (owner, 2026-10-14)

1. **Specs live in the repo.** An approved spec is `docs/specs/<issue#>-<slug>.md` with frontmatter `issue`,
   `status` (`approved` → `built`, or `superseded`) and `approved`. Drafts stay out until the owner says yes.
2. **Spec and code change together.** `tools/ci/spec-guard.mjs` (required `static` job) fails a PR that changes
   `apps/**` or `packages/**`, closes #N, and leaves `docs/specs/N-*.md` untouched.
3. **Done means are tests.** A spec's `## Done means` section carries ids `D1`..`Dn`. The build lane's first commit adds one
   `acceptance/` test per id named `spec #N Dk`, red against `main`; `spec-guard` fails a PR that sets
   `status: built` while an id has no such test (built in #869). The tests are then locked by the acceptance guard.
4. **One roadmap.** GitHub milestones are the roadmap. The `ROADMAP` files under `docs/superpowers/` are kept for
   history with a superseded header.

## DECIDED (standard practice, open to the owner's objection)

- The repo is public: specs are scrubbed of names, patient data, IPs, server names, coordinates, credentials and
  security findings before they move; a spec that cannot be scrubbed stays out and its issue says so.
- A spec built before this folder existed and never given an issue is numbered by the PR that built it.
- Specs written before this ruling keep unnumbered done-means and are not held to rule 3.
