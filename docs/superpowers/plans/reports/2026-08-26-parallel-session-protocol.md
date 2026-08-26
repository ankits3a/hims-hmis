# Parallel sessions in /opt/hmis — what is shared, how it goes wrong, and how to recover

**Written 2026-08-26**, after three lanes (Plan 09's pipeline, the identifier grammar, and
roles/access) ran in this checkout on the same day and collided in four distinct ways. Every failure
mode below was OBSERVED here, not imagined.

**Read this before your first tool call if another session may be running.** It is short on purpose.

---

## 1. What is shared — all of it, all the time

| | shared? | consequence |
|---|---|---|
| The working tree `/opt/hmis` | **YES — one** | Their uncommitted edits appear in *your* `git status` |
| `git` index, HEAD, branch `main` | **YES — one** | Your commit can carry their staged work |
| Test databases `hmis_test_<worker>` | **YES** | Two jest runs truncate each other's fixtures mid-test |
| Dev database `hmis_dev` (5433) | **YES** | |
| Production `hmis-prod` (5434) + `/opt-hmis-prod` | **YES — it is a live hospital** | |
| `origin/main` | **YES** | Their push carries your commits |
| Migration numbers | **YES** | Two lanes generating at once both get `NNNN` |
| Your scratchpad `/tmp/claude-0/-opt-hmis/<uuid>/` | no — per session | The only truly private space |

There is **no isolation anywhere except the scratchpad**. Assume nothing is yours alone.

---

## 2. Before your first change — 30 seconds of pre-flight

```bash
ps -eo pid,etimes,cmd | grep -E "jest|vitest|deploy\.sh" | grep -v grep   # who else is working?
git status --short                                                        # whose files are these?
git log --oneline -5 && git status -sb                                    # am I current? ahead?
ls apps/core/drizzle | tail -3                                            # which migration number is free?
```

**Interpreting it:**

- A jest/vitest process whose command line shows a scratchpad UUID **that is not yours** → another
  session is mid-test-run. Do not run a broad suite; see §4.
- Files in `git status` you did not touch → another lane has uncommitted work in this tree. **They
  are not yours to stage, revert, or "clean up".**
- Migration numbers: the highest on disk is not necessarily claimed — the other lane may be about to
  generate. Announce yours in your first commit message and check `_journal.json` again immediately
  before you generate.

---

## 3. While you work — five rules

1. **Stage explicitly, by path. Never `git add -A`, `git add .`, or `git commit -a`.**
   This is the rule that prevents the worst outcome. Plan 09 T8's `927afc6` swept ~90 lines of the
   identifier lane's uncommitted README plus a locale key into itself; `b0d046b` then reverted them
   as scope creep — correct from T8's side, and it deleted finished work from the tree while its
   own session was mid-test-run.

2. **Commit early, in small pieces.** A large dirty tree is the hazard itself: neither session can
   tell whose uncommitted lines are whose. Committing is how you make your work legible to them.

3. **Run only the suites your change touches.** `pnpm verify` while another session tests is not a
   signal, it is noise — see §4.

4. **Never revert a file you did not write** without reading the commit that introduced it. If it
   looks like scope creep, it may be another lane's finished work that landed in your commit by
   accident. Ask before removing.

5. **Assume your commit may go live without you.** See §5 — this is the least obvious mode and the
   one with production consequences.

---

## 4. Contamination mode 1: the shared test database

**What it looks like.** A `pnpm verify` that was green twenty minutes ago fails across a dozen
unrelated suites — billing, tariff, opd, membership, ops, realtime, identity — with foreign-key
violations and 5-second timeouts. **Nothing in your diff explains any of it.**

**The signature to recognise instantly:**

```
FAIL test/perf-opd-queue.test.ts
  error: insert or update on table "opd_encounters" violates foreign key constraint
         "opd_encounters_patient_id_patients_id_fk"
```

That is another run's `truncateAll` deleting `patients` between your test's insert and its FK check.

**What to do — in this order:**

1. `ps -eo cmd | grep jest` — confirm the other run exists. **Do not start debugging your diff.**
2. Run only the suites your change touches.
3. Re-run any that failed **in isolation**. On 2026-08-26 every suite that failed in the batch
   passed alone — the failures were 100% contention, 0% real.
4. Take your green `pnpm verify` later, when `ps` is clear. Say in your commit message which suites
   you ran scoped and why, so a reviewer is not misled by a partial verification.

**Never** "fix" a test to make a contention failure go away.

---

## 5. Contamination mode 2: your commits ship in someone else's deploy

**This is the one nobody expects.** `deploy.sh` builds from the checkout at whatever `HEAD` is. If
your commits are ancestors of theirs — and on a shared `main` they almost always are — then **their
push and their deploy carry your code to production**, without either session deciding that.

It happened on 2026-08-26: `fc9e49a` (an auth escalation fix) and `0b26b61` (the role picker) went
live inside the identifier-grammar lane's deploy. Nothing broke, but:

> **`fc9e49a` declared a new `auth.*` permission whose GRANT comes from `seed:admin`, which is NOT
> in `deploy.sh`. So production ran for hours with the permission in the catalog and held by nobody
> — the review queue it gated answered 403 to the only administrator, and `fullAdministrators` read
> 0 instead of 1 on the admin screen.**

**Rules that follow:**

- **A commit that needs an operator step is a defect on a shared branch.** Put the step in
  `deploy.sh` instead. When the merge lane needed approval types registered, the seed went into the
  deploy path rather than the runbook for exactly this reason.
- If you truly cannot, say so **in the commit message subject area and in the relay**, because the
  person who deploys will not be you and will not have read your plan.
- **After any deploy — yours or theirs — verify what is actually live**, against the database, not
  against the exit code. Your changes may have gone out early; theirs may have gone out with yours.

---

## 6. Contamination mode 3: the working tree, and `git stash`

**Their files show up in your `git status`.** That is normal here and is not damage. Do not touch
them.

**`git stash -u` sweeps their files too.** It round-trips safely — pop restores everything — but
after the pop *their* work reappears in `git status` looking exactly like yours, and it is very easy
to then commit it. If you must stash, re-check `git status` after the pop and stage by path.

**If your work was swept into someone else's commit:** it is fully recoverable. `git show <their
commit> -- <your file>` has it. The identifier lane recovered ~90 lines that way and verified them
byte-for-byte before re-landing. Say in your commit message that you are restoring, not
re-introducing, so the next reviewer does not revert it a second time.

---

## 7. Contamination mode 4: migration numbers

Two lanes running `drizzle-kit generate` in the same hour both get the next integer. The loser
discovers it when `migrate()` applies them in journal order and one is missing or duplicated.

- Check `apps/core/drizzle/meta/_journal.json` immediately before generating **and** immediately
  after.
- State the number you took in your commit message, and the next free one in your relay note. Both
  2026-08-26 relays do this ("Next free migration: 0026").
- If you collide, renumber YOURS (rename the `.sql`, rename the snapshot, retag the journal entry) —
  never the one already pushed.

---

## 8. If you are picking up a contaminated tree — the judgement checklist

Work through it in order. Each step is a `git` command, not a guess.

1. **Is my work still there?**
   `git merge-base --is-ancestor <my-commit> HEAD && echo SURVIVED`
   Objects are not lost by someone else's commits; check before assuming anything was overruled.

2. **Did anyone change my files after my commit?**
   `git log --oneline <my-commit>..HEAD -- <my paths>` then `git diff --stat <my-commit>..HEAD -- <my paths>`
   Usually the answer is "one locale file, additively" — genuine conflicts are rarer than they feel.

3. **Do my tests still pass on current HEAD?** Run them scoped (§4). This, not the diff, is the real
   answer to "was I overruled".

4. **Is production ahead of, behind, or sideways from `main`?** Measure it — read the live database
   for the specific rows your change writes. Do not infer from commit history; §5 means the two
   diverge routinely.

5. **Did anything I shipped need an operator step that nobody ran?** Grep your own commits for
   `seed:`, and check whether that seed is in `deploy.sh`.

6. **Only then decide what to do next.** In practice the order is almost always: verify → finish
   what is half-done → deploy → assign/operate → write the relay.

---

## 9. Production is not a test surface

- **Read-only SQL against `hmis-prod-db-1` is fine** and is the right way to check what is actually
  live. Every claim in the 2026-08-26 relays was measured this way.
- **Writes go through the application**, not the database. Role assignment writes an append-only
  `role.assigned` event; a raw `INSERT` into `role_assignments` works mechanically and leaves a
  permanent hole in the record of who held what and when.
- **`seed:admin` is idempotent and safe to re-run**; its policy gate fires only when it would CREATE
  the user, so `ADMIN_PASSWORD` is unused on a box that already has an admin.
- **`deploy.sh` is idempotent** and a re-deploy over a running stack is the normal case. It refuses
  on its own pre-flight rather than half-applying.
- Deploy when the box is quiet. Check first: open visits today, newest event timestamp, live
  sessions. On 2026-08-26 the deploy went out at 08:41 IST with zero visits and no activity for an
  hour.

---

## 10. Leave a relay note

Every lane that lands anything writes one in `docs/superpowers/plans/reports/`. It is the only
channel between sessions that survives. State: what changed, what must NOT be "simplified" away,
what is measured versus assumed, what is deployed versus merely pushed, and what the next action is.

Current notes: `2026-08-26-identifier-grammar-relay.md` · `2026-08-26-roles-access-relay.md`.
