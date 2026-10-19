# Feature specs

An approved feature spec is the project's memory of what a feature is for and when it is done. It lives here, in the
repo, so a pull request shows the spec and the code changing together.

- One file per spec: `<issue#>-<slug>.md`, where `<issue#>` is the GitHub issue the spec is for (for a spec built
  before this folder existed and never given an issue, the number of the PR that built it).
- Frontmatter: `issue`, `status` (`approved` → `built`, or `superseded`) and `approved` (the owner's approval date).
- Drafts stay out of the repo until the owner says yes.
- The repo is public: no staff or patient names, patient data, IPs, server names, coordinates, credentials or security
  findings. A spec that cannot be written without them stays out, and its issue says so.

**The guard.** `tools/ci/spec-guard.mjs` (required `static` job) fails a pull request that changes code under `apps/`
or `packages/`, closes issue #N (`Closes`/`Fixes`/`Resolves #N`), and leaves `docs/specs/N-*.md` untouched. When the
build is done, the same PR sets `status: built` and records anything that changed against the spec. `Refs #N` never
binds, and an issue with no spec (a bug fix) passes.

**Done means are tests.** A spec's `## Done means` section lists ids `D1`..`Dn`. The build lane's first commit adds
one test per id under an `acceptance/` folder, its name carrying `spec #N Dk`, red against `main`; `acceptance-guard`
then locks them. `spec-guard` fails a PR that leaves a spec `status: built` while any id has no such test. Specs whose
done-means carry no ids are not checked.

**Roadmap.** GitHub milestones are the only roadmap; the `ROADMAP` files under `docs/` are superseded history.
Decision 0081 records all of the above.
