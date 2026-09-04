#!/usr/bin/env python3
"""
Renumber THIS lane's migrations onto the end of origin/main's, and rebuild the drizzle journal.

WHY THIS IS A SCRIPT AND NOT A CHECKLIST
========================================
`CLAUDE.md` says migrations are "numbered at rebase time", and with eight lanes merging that is not
a one-off — the front-desk lane renumbered three times in one afternoon (0059->0064->0066) because a
peer took the number each time it went to merge. Doing it by hand is how you get the two failures
below, both of which are silent.

THE TWO SILENT FAILURES THIS EXISTS TO PREVENT
==============================================
1. A COLLIDING FILENAME. Two lanes both ship `0064_*.sql`; the merge takes both files and the journal
   references one. Caught here by asserting our tags do not appear in main's journal.

2. AN OUT-OF-ORDER `when`, WHICH IS THE DANGEROUS ONE. Drizzle applies migrations where
   `when > lastApplied`, walking the journal IN ORDER. An entry whose timestamp sits below its
   predecessor's is skipped FOR EVER, on every database that has not already run it, and it does not
   error — it surfaces later as a missing table. This bit the lane twice: once when main's
   `0059_lab_analyte_applicability` would have been skipped in the lane's own test database, and
   once when main's `0063_aerb_tld_badges` landed with a `when` ABOVE our three and would have
   skipped all of them on any fresh database. The whole journal is asserted strictly ascending here.

USAGE (from the lane root, mid-merge with meta/_journal.json conflicted, or any time):

    python3 tools/renumber-lane-migrations.py            # report what it would do
    python3 tools/renumber-lane-migrations.py --apply    # rename the files and write the journal

AFTERWARDS, ALWAYS: drop this lane's test databases before measuring. They recorded the OLD `when`
values, so migrations would either re-apply (and fail on a non-idempotent DDL) or be skipped.

    docker exec hmis-db-1 psql -U hmis -d postgres \\
      -c 'drop database if exists <lane_db>_1' -c 'drop database if exists <lane_db>_2'
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

JOURNAL = "apps/core/drizzle/meta/_journal.json"
DRIZZLE = "apps/core/drizzle"
STEP_MS = 1000


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def main_journal() -> dict:
    return json.loads(git("show", f"origin/main:{JOURNAL}"))


def lane_migration_tags() -> list[str]:
    """The migration tags this lane adds, in journal order, taken from the merge base with main."""
    base = git("merge-base", "origin/main", "HEAD").strip()
    theirs = {e["tag"] for e in main_journal()["entries"]}
    base_tags = {e["tag"] for e in json.loads(git("show", f"{base}:{JOURNAL}"))["entries"]}
    # Files present in the working tree that neither main nor the merge base knows about.
    ours: list[str] = []
    for name in sorted(os.listdir(DRIZZLE)):
        if not re.match(r"^\d{4}_.*\.sql$", name):
            continue
        tag = name[:-4]
        if tag not in theirs and tag not in base_tags:
            ours.append(tag)
    # Anything the merge base already had but main does not is also ours (renamed on a prior pass).
    for tag in sorted(base_tags - theirs):
        if tag not in ours and os.path.exists(os.path.join(DRIZZLE, f"{tag}.sql")):
            ours.append(tag)
    return ours


def main() -> int:
    apply = "--apply" in sys.argv
    mj = main_journal()
    entries = list(mj["entries"])
    last = entries[-1]
    ours = lane_migration_tags()
    if not ours:
        print("no lane-only migrations found — nothing to renumber")
        return 0

    next_idx = last["idx"] + 1
    when = last["when"]
    plan: list[tuple[str, str, int, int]] = []
    for offset, tag in enumerate(ours):
        idx = next_idx + offset
        when += STEP_MS
        new_tag = f"{idx:04d}_{tag.split('_', 1)[1]}"
        plan.append((tag, new_tag, idx, when))

    print(f"main ends at idx {last['idx']} ({last['tag']}, when={last['when']})")
    for old, new, idx, w in plan:
        arrow = "unchanged" if old == new else f"-> {new}"
        print(f"  {old:<48} {arrow:<48} idx={idx} when={w}")

    # ── the two assertions this script exists for ────────────────────────────────────────────────
    theirs = {e["tag"] for e in entries}
    clash = [new for _, new, _, _ in plan if new in theirs]
    if clash:
        print(f"REFUSING: renamed tag(s) already on main: {clash}", file=sys.stderr)
        return 1

    for _, new, idx, w in plan:
        entries.append({"idx": idx, "version": "7", "when": w, "tag": new, "breakpoints": True})
    whens = [e["when"] for e in entries]
    bad = [(entries[i]["tag"], whens[i], whens[i + 1]) for i in range(len(whens) - 1) if whens[i] >= whens[i + 1]]
    if bad:
        print(f"REFUSING: journal `when` is not strictly ascending: {bad}", file=sys.stderr)
        return 1
    idxs = [e["idx"] for e in entries]
    if idxs != sorted(set(idxs)):
        print("REFUSING: journal idx is not strictly ascending / unique", file=sys.stderr)
        return 1
    print(f"OK: {len(entries)} entries, `when` strictly ascending, idx unique")

    if not apply:
        print("\n(dry run — pass --apply to rename the files and write the journal)")
        return 0

    for old, new, _, _ in plan:
        if old == new:
            continue
        subprocess.run(["git", "mv", f"{DRIZZLE}/{old}.sql", f"{DRIZZLE}/{new}.sql"], check=True)
    mj["entries"] = entries
    with open(JOURNAL, "w") as fh:
        fh.write(json.dumps(mj, indent=2) + "\n")
    subprocess.run(["git", "add", JOURNAL], check=True)
    print("applied. NOW DROP THIS LANE'S TEST DATABASES before measuring — see the module docstring.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
