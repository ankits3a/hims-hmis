# Briefing a subagent — the template

A subagent starts with nothing but its brief. Everything it does not know, it re-reads from the code, and
that re-reading is where most of a delegated task's tokens go. A good brief hands it what is already known
and asks for its answer in a shape the next step can use without re-reading. Copy the block below, fill the
angle brackets, delete what does not apply.

```
GOAL: <one sentence: the outcome, not the activity>. Owner request <date>: "<their words>".

WHERE: work only in <lane worktree path> (branch lane/<name>). Never touch /opt/hmis or hmis-prod-*.
Read CLAUDE.md there and obey it (test lock, commit by pathspec, fail-first tests, never weaken a guard).

READ FIRST, IN THIS ORDER, AND TRUST THEM OVER A CODE CRAWL:
  1. docs/architecture/modules/<m>.md   (generated: deps, public API with signatures, tables, routes)
  2. apps/core/src/modules/<m>/MAP.md   (hand-written: flows, invariants, traps) — if it exists
  3. docs/decisions/<NNNN>-*.md         (the owner rulings that bind this task)
  4. <specific files I already know matter, with the symbol to look at>

ALREADY KNOWN (do not re-derive): <facts established before this brief, with file + symbol>
ALREADY RULED OUT: <approaches tried or rejected, and why>

SPEC: <the decided behaviour, numbered; every decision made, none left for the subagent to guess>
OUT OF SCOPE: <what not to touch>

VERIFY: <exact commands, under the lock: $L run <lane> …>; typecheck, lint, node tools/arch/gen.mjs --check.
FINISH: commit on the lane by pathspec; do NOT push, stage, merge or deploy.
SHARED DOCS: do not edit MAP.md, docs/decisions or docs/architecture unless this brief says so — the
  orchestrator is their single writer. Put anything they should learn in your report instead.

REPORT (under <N> words), in this shape:
  - files changed (paths)
  - decisions you made that the brief did not, and why
  - test counts exactly as printed, and which tests failed first
  - facts worth keeping for the module notes (file + symbol, no line numbers)
  - anything not done
```

## Why each part is there

- **Read first, in order.** The map and the module notes answer "where is it and what calls it" in a few KB.
  Without the instruction, a subagent greps the module from scratch.
- **Already known / ruled out.** The cheapest token is the one not spent re-discovering what the parent knew.
- **Spec with every decision made.** An open question in a brief becomes a guess in the code.
- **Single writer for shared docs.** Ten parallel subagents editing one MAP.md overwrite each other; the
  parent merges their "facts worth keeping" into the notes once.
- **Report shape.** A fixed report is cheap to read and can feed the next brief directly.

## Choosing the agent

- Reuse a finished subagent (SendMessage) when the next step needs what it already read.
- Fork when the next step needs this conversation's context; a fresh agent re-reads everything.
- For cross-module reading or a rename, Serena in that lane can cut tokens read by about a third (CLAUDE.md).
