# HANDOFF — front-desk lane, FD-11 · written 2026-09-04

Read `CLAUDE.md` first, then this. Nothing else. This file is the whole context.

Lane `/opt/hmis-lanes/front-desk/hmis`, branch `lane/front-desk-fd7-t9`, forked from `593b83c`.
**Nothing is pushed and no PR is open.** Ten commits sit on the lane.

---

## 1 · START HERE — the state in one paragraph

Nine commits are done and deployed to the preview. A **tenth is uncommitted**: the audited
cash-drawer re-count (server + UI + tests), which is finished and green locally and was blocked
only on a full core run. **Verify that run before committing** — see §3.

---

## 2 · HOW TO SEE IT

**External preview** — https://62.238.106.231:8443 · basic auth `preview` / `DeskOne!Preview2026`
(self-signed cert; the browser warns once).
**App login** `ramesh` / `DeskOne!Live2026` (front_office + cashier).
**Admin** `admin` / `DevAdmin!Pass2026` (approvals, billing_manager, duty_manager).

Local: vite `:5180`, API `:3010`, DB `hmis_fd_dev`.

**Restart the API after ANY core change** — this bit me and produced a confusing
`Cannot POST /billing/sessions/:id/recount` in the owner's face. `start:dev` cannot boot it (tsx
emits no decorator metadata):

```
pnpm --filter @hmis/core exec tsc -p tsconfig.build.json
cd apps/core && MEMBER_BENEFITS_ENABLED=true PORT=3010 \
  DATABASE_URL='postgres://hmis:hmis@localhost:5433/hmis_fd_dev' \
  TRIAGE_BASE_URL='https://api.groq.com/openai/v1' TRIAGE_MODEL='openai/gpt-oss-120b' \
  TRIAGE_API_KEY='<in apps/core/.env>' \
  nohup node dist/src/main.js > /tmp/api.log 2>&1 < /dev/null & disown
```
Never `pkill -f "node dist/src/main.js"` in a compound command — it kills the agent's own shell
(exit 144). Start it in its own invocation.

**Redeploy the preview** = rebuild the web bundle; the container bind-mounts this lane's `dist`:
```
pnpm --filter @hmis/web build      # that is all — Caddy serves apps/web/dist directly
```
Caddy config `/opt/hmis-preview/Caddyfile`; `caddy reload` DOES NOT WORK (`admin off`), use
`docker restart hmis-preview-caddy`. **`basic_auth` must stay inside the static `handle` block** —
site-level auth collides with the app's `Bearer` header and makes sign-in impossible. Details in
memory `preview-build-externally`.

---

## 3 · THE ONE THING TO DO FIRST

The tenth change is uncommitted. A full core run was in flight when this session ended:

```
pnpm --filter @hmis/core exec jest -w 2 > /tmp/core.log 2>&1; echo "EXIT:$?"
grep -E "✕|Tests:" /tmp/core.log
```

**Read the exit code, not a wrapper's.** A background run earlier reported "exit 0" while jest had
exited 1 — and because the command was piped through `tail -7`, every line naming the failures was
thrown away. Capture full output to a file, always.

Expected: **376 suites / 3733 tests**. Last full green before this change was 373/3725.

If green, commit by pathspec (the message is drafted in §4), then:
```
pnpm --filter @hmis/web build      # redeploy the preview
```

**Two census guards already absorbed this change** — both were real failures, not flakes:
- `apps/core/src/modules/billing/events.test.ts` pinned exactly 20 billing events; the re-count adds
  a 21st (`cashier_session.recounted`). Updated, in lifecycle order.
- `apps/web/src/components/submit-button.test.tsx` pinned 13 money write-lanes; `recount-submit` is
  the 14th. Updated.

Anything else that fails is likely one of the four recorded flakes (worker scheduler V12, partners
accrual lock timing, lab specimen-number collision, Desk One P5) — check the memory files before
blaming the diff.

---

## 4 · THE UNCOMMITTED CHANGE — the audited re-count

**Why it exists.** The owner mistyped a closing count on the preview (`0` against an expected
₹4,020) and was trapped: a count that misses the till files a `billing_variance` approval and parks
the session in `closing`; the cashier filed it so the kernel refuses their own grant; and they
cannot open a second drawer while that one is live. Every exit needed a second human — in a hospital
with one supervisor. Owner ruled: add the audited re-count path.

**Files:** `sessions.ts` (`recountSession`, `wasRecounted`), `events.ts`
(`cashierSessionRecounted`), `errors.ts` (3 codes), `billing.controller.ts`
(`POST /billing/sessions/:id/recount`), `billing-session.tsx` (the control, beside the count, above
the lockout banner), plus the two census updates and en/hi copy.

**THE THREE THINGS THAT KEEP IT SAFE.** A plain undo would be worse than the trap — count short,
read the expected figure off the variance the screen just showed you, retract, type that figure,
close clean, keep the difference. All three are load-bearing and each has a mutant test:

1. The retracted figure is written to the event log **before** the drawer reopens, with the
   expected, the variance, the now-inert approval id and a **mandatory reason**.
2. `beginClose` reads that event and **files an approval on the next close even at zero variance**.
   This is the line that closes the attack. `const closed = variancePaise === 0 && !retracted;`
3. Only the cashier whose drawer it is, only from `closing`.

**Known wart, owner's ruling needed:** the approval filed against a retracted count stays `pending`.
The kernel has `pending | granted | rejected` and no cancel; `rejectRequest` runs the same
requester≠approver check. It is inert (`confirmClose` reads the session's *current* approval id,
which the re-count clears) but the owner's session accumulated **5 stale pending approvals from one
typo**. Adding a `superseded` status is a change to the shared approvals kernel — do not do it
without a ruling.

**Draft commit message:** see the pattern of `101be30`. State the owner quote, the trap, the three
safety properties, the mutants, and the census updates.

---

## 5 · WHAT SHIPPED (nine commits, all deployed)

| commit | what |
|---|---|
| `93cf096` | login pine panel → rotating Gita verse |
| `070d8d0` | shell no longer renders under Desk One |
| `13a3959` | four screenshot findings closed |
| `c95f656` | LLM router → Groq, plus the keystroke-debounce |
| `4ff1d0a` | triage cache |
| `65e12c6` | verse panel Devanagari-only |
| `bd76ca7` | welcome dashboard + drawer gate |
| `34101b5` | real scheme counts + topbar rebuild |
| `101be30` | `closing` drawer no longer asked to be re-opened |

**Owner rulings already given** (do not re-ask):
- Login left pane = rotating Gita verse; 8 verses + the `सेवा ही परम धर्म है` **proverb** labelled
  `कहावत · श्लोक नहीं`. Footer creed dropped. **All lines Devanagari, no English, no Hinglish-Roman.**
- Dashboard = the "Dashboard — the composer" artboard; drawer gate before registration/appointment.
- Topbar rebuilt in paper-pine ("the current topbar… is looking pathetic").
- Scheme tiles carry **real** counts.
- Add the audited re-count.

**Decisions I made and stated** (overrule if wrong): the drawer gate is on the ACTION not the
information, and only gates holders of `billing.session.own`; scheme tiles show a **blank, not a
zero**, when the reader holds no permission that counts them; the dashboard does not repeat the
artboard's chrome bar because the shell already draws it.

---

## 6 · TRAPS THIS LANE ALREADY PAID FOR

- **Devanagari that renders in BOTH languages needs UNCONDITIONAL CSS**, never a
  `[data-lang="hi"]` override — that selector does not match on the English screen and the text
  falls back per character. Bit me twice (`.cite`, then `.mean`/`.gloss`).
- **Reading `i18next.language` in a render body stamps once and never updates.** The component needs
  `useTranslation()` to subscribe. `DeskOne`'s `t()` calls all live in children, so its root
  re-rendered for every reason except the one the attribute existed for.
- **`router` is a module singleton**; `RouterProvider`'s `history` only takes on the FIRST mount in a
  test file. Drive the route with `await act(async () => { await router.navigate(...) })`.
- **Freeze the tree for a full measurement.** A mutant applied mid-run invalidates it; the unit of
  staleness is the worker process.
- **A surviving mutant is a finding, not a shrug.** One found the triage day window had no upper
  bound (every future coupon counted as today's); one found only half the drawer gate was pinned.

---

## 7 · OPEN, IN PRIORITY ORDER

1. **Verify + commit + deploy the re-count** (§3).
2. **Owner ruling:** retracted variance approvals — auto-reject, mark superseded, or leave? Five
   stale rows per typo today.
3. **Rebase on `origin/main` and open the PR.** Ten commits, never pushed. `apps/web/src/router.tsx`,
   `locales/*.json`, `seed-roles`, `caddyfile-parity` are shared — see memory
   `stacked-prs-under-branch-protection` before merging main in.
4. **Rotate the credentials in this handoff and in the last session's transcript**: the Groq key,
   the NVIDIA key, `DevAdmin!Pass2026`, `DeskOne!Preview2026`.
5. **NVIDIA (build.nvidia.com) is measured unusable for triage** — same model as Groq, same answers,
   but 6.2 s median and 300 s p90 against a 6 s budget; 3 of 4 models 404 despite being listed. Its
   only honest use is off the counter's critical path (a background cache-warmer). Not wired.
   Owner has the measurement.
6. Preview data note: the Ramesh cohort's districts and registration dates were varied in
   `hmis_fd_dev` so the duplicate-disambiguation row has something to disambiguate. Dev data only.
