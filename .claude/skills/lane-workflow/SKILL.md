---
name: lane-workflow
description: How to work in an HMIS lane — create/drop lanes, the lane HANDOFF.md, commit/rebase/PR steps, one task per session. Use when starting or finishing work, opening a PR, or resuming a lane.
---

# Lane workflow

`/opt/hmis` is the integration checkout and stays on `main`. Work happens in a lane:

```
tools/lane.sh new <name>        # worktree /opt/hmis-lanes/<name>/hmis, branch lane/<name>, own test DBs, HANDOFF.md
cd /opt/hmis-lanes/<name>/hmis && claude
tools/lane.sh status            # who else is running tests, free memory, every lane's drift
tools/lane.sh drop <name>       # when the PR merged/closed; archives the handoff, drops the test DBs
```

- Commit on the lane branch, by pathspec: `git commit -m "…" -- <paths>`. New files: `git add -- <paths>` first. Never `git add -A`.
- Before the PR: `git fetch && git merge origin/main` (or rebase if nothing is pushed yet — never rewrite pushed history).
  Migrations take the next free number at that moment: `python3 tools/renumber-lane-migrations.py --apply`, then drop the lane's test DBs.
- `gh pr create` (draft until the owner says yes); CI is the gate; squash-merge.
- A red `main` freezes merges; whoever pushed the red fixes it first.
- Close the session when the lane closes; idle sessions hold the box's memory and that OOM-kills jest.

## The lane handoff — `/opt/hmis-lanes/<name>/HANDOFF.md`
Outside git (never dirties a tree). Read it first when you start in a lane. Overwrite it (≤40 lines, newest state wins)
before you stop or when the context grows long: goal, state (committed/pushed/PR/staged/merged), next step, decisions and
where recorded, traps hit, what to read, how to verify. `drop` archives it to `/opt/hmis-lanes/.handoff-archive/`.

## One task per session
Start a new task with `/clear` or a fresh session in its lane; name the module in the first message. Every turn re-sends
the whole conversation, so a long mixed session pays for all of it on every turn.
