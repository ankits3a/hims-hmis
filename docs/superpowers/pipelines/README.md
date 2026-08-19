# Compiled pipelines

Each file here is a Workflow script compiled from an approved plan, plus the pre-flight that
proves it. They are committed so a later session can run one without recompiling, and so the
exact thing that ran is auditable afterwards.

## Running one

```
node docs/superpowers/pipelines/<name>.preflight.js     # must exit 0
```
then call the Workflow tool with `{ scriptPath: "<absolute path to the .js>" }`.

The pre-flight is not optional and it is not decoration:

1. **Module-parse probe** — the script's single top-level `return` is rewritten to a binding and
   the result is parsed as an ES module. This is what catches duplicate declarations and real
   syntax errors. `node --check` on the `.js` is **inert** for this script shape (a top-level
   `return` makes it exit 0 on genuine syntax errors), so it is deliberately not used as a gate.
2. **Negative controls** — a duplicate `function brief()` and a broken string literal are each
   injected and must be observed to FAIL in the same run. A probe nobody has watched fail is not
   a probe.
3. **Dry run** — the whole script executes with stubbed `agent`/`parallel`/`phase`/`log`, and
   asserts the agent roster, the tier→model map, the reviewer split, and that every rules block
   appears in the RENDERED brief rather than merely existing as a constant.

## Files

- `plan-08-pipeline-B.js` — Plan 08 (Billing Counter) tasks T7–T12, compiled 2026-08-19 under
  [EXECUTE-METHOD v2](../EXECUTE-METHOD.md). 13 agents: 6 coders, 4 opus gates on the CRITICAL
  tasks, 2 sonnet mechanical checks on the ROUTINE ones, and 1 opus discovery reviewer over the
  whole pipeline. Briefs reference [AGENT-RULES.md](../AGENT-RULES.md) rather than inlining it.
