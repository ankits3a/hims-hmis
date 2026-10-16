---
issue: 695
status: approved
approved: 2026-10-14
---
# Spec: specs live in git, carry their checks, one roadmap (owner 2026-10-11) — APPROVED 2026-10-14

**Goal.** A feature's spec is the project's memory: in the repo, reviewed in the PR, true after the build.

1. **Specs in git** (#695). Approved specs move from `/opt/hmis-context/SPEC-*.md` to
   `docs/specs/<issue#>-<slug>.md` with frontmatter `issue`, `status: approved|built|superseded`, `approved`.
   Each issue links its spec. New guard `tools/ci/spec-guard.mjs` (same shape as `acceptance-guard.mjs`,
   reads the PR body from the event): a PR that says `Closes #N` and touches `apps/**` or `packages/**`
   fails when `docs/specs/N-*.md` exists and is not in the diff. Bug fixes with no spec pass untouched.
   The repo is public: each moved spec is scrubbed (no staff names, patient data, IPs, coordinates,
   credentials, security findings); a spec that cannot be scrubbed stays in hmis-context and the issue says so.
2. **Done means = acceptance tests** (#696). Spec "Done means" lines get ids `D1..Dn`. The first commit of a
   build lane adds one `acceptance/` test per id (test name carries `spec #N Dk`), red against `main`.
   `spec-guard` also fails a PR that sets `status: built` while any `Dk` has no matching acceptance test.
3. **One roadmap** (#697). GitHub milestones are the only roadmap. `docs/superpowers/*ROADMAP*` get a
   "superseded by milestones" header; CLAUDE.md and the lane-workflow skill say where specs and roadmap live.
   New decision record (next free number) states 1–3.

**Done means**
- D1 `node --test tools/ci/spec-guard.test.mjs` covers: code PR without spec edit → fail; with edit → pass;
  no spec file → pass; non-PR event → pass; `built` with a missing `Dk` test → fail. Each case red first.
- D2 CI `static` job runs `spec-guard` on every PR; a deliberate violating PR shows it red in the Checks tab.
- D3 `docs/specs/` holds every movable approved spec; `grep` for the scrub list over `docs/specs/` is empty;
  each source issue body links its spec path.
- D4 No `ROADMAP` file under `docs/` is without the superseded header; CLAUDE.md names `docs/specs/` and milestones.
- D5 Next feature lane after merge starts with red acceptance tests named `spec #N Dk` (checked on that PR).
