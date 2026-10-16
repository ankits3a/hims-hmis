---
issue: 587
status: built
approved: 2026-10-11
---
# SPEC — "Waiting for me": open loops (E1.4) + the morning card (E1.5) — 2026-10-11 — lane `morning-card`

**Built at the owner's overnight instruction (2026-10-11 03:00 IST, "keep working on the decided milestones and goals"); awaiting review.** Draft PR only — not merged, not staged, no APK.

**What.** Every signed-in person opens the phone (or `/my-day` on the web) and sees, at the top, one line per kind of thing that is waiting on THEM: "2 lab reports back", "1 imaging report unread", "3 critical calls open", "1 duty today". Tap a line, its screen opens. The phone's "Open loops" screen lists every line; the web shows the same list on My day. Both read the same server answer.

**Server.** One read, `GET /me/waiting` (kernel/desk, self-scoped like `/me/desk` — no user id anywhere). DECIDED: a new route, not `/me/desk` reused — the desk's cards are module pictures with free-text rows; this is a flat, counts-only list both clients must draw identically. Composed through the existing desk-provider seam: a provider may now declare `waiting(ctx)` beside `load/report/facts/range`, run only when the caller holds that provider's permission (same gate as the desk). Kernel adds alerts, reminders. Answer: `{ items: [{ kind, count, oldestAt, tone, href }] }`, ordered by a fixed kind order, zero counts omitted.

**Kinds (DECIDED, standard Indian-corporate-hospital meaning).**
| kind | who (permission) | counts |
|---|---|---|
| `lab.criticalsMine` | `lab.results.read` | open lab critical calls on orders where I am the ordering clinician |
| `radiology.criticalsMine` | `radiology.reports.read` | imaging critical findings not yet acknowledged, on studies I treat |
| `lab.reportsBack` | `lab.results.read` | lab reports published in the last 24 h on orders where I am the ordering clinician (lab has no doctor-read stamp, so this ages out rather than closes) |
| `radiology.unreadMine` | `radiology.reports.read` | released imaging reports on studies I treat that nobody but the signer has opened (closes on first read, as the inbox) |
| `lab.callsOpen` | `lab.criticals.close` | critical calls the lab has not yet closed with a read-back |
| `radiology.readsOverdue` | `radiology.reports.write` | studies with images in and no report past their reading-room clock (STAT 30 m, ER 60 m, IPD 6 h, OPD 24 h) |
| `alerts.unanswered` | everyone | my bell rows of the last 7 days nobody has acknowledged (reminders excluded) |
| `reminders.today` | everyone | my reminders still to fire before IST midnight |
| `roster.dutiesToday` | `roster.read` | my duties still to run today |

"Studies I treat" = the radiology inbox's rule (ordering clinician or the visit's doctor); restricted studies counted only for the ordering clinician or `orders.read.restricted`, as the inbox shows them.

**Privacy.** Counts, an oldest time and a link only: no patient name, UHID, test name or id in the answer, so the home card is safe over a shoulder and nothing reaches a lock screen. No new push. No payment kind exists in the list (a doctor never sees money). No new permission, no migration, no new web route.

**Phone.** "Waiting for me" card at the top of every seat's home (one line per kind, tap opens its screen); hidden when nothing waits. New screen `/loops` ("Open loops") lists all lines. Phone targets: alerts → `/alerts`, reminders → `/reminders`, duties → My duties; lab/imaging/criticals lines → `/loops?kind=…` with a one-line "where": these screens are on the computer today (no phone report viewer yet). Short words, one line at 390 px, en + hi.

**Web.** "Waiting for me" section at the top of `/my-day`, the same lines, each a link to its web screen (consult, lab bench, reading room, my duties).

**Done means (binary).**
1. A doctor fixture with 2 returned lab reports and 1 unread imaging report gets exactly those 3 (two lines: 2 + 1) and nothing else.
2. Each line opens its screen in one tap — phone route test on the card and the list; web link test.
3. Phone list equals web list for the same answer: both draw from one shared `waitingLines()` in packages/contracts (contract test).
4. The answer carries no patient name, UHID or patient id (test); no push is added.
5. A doctor never gets a payment kind (test over the kind list and the fixture).
6. Mobile jest + tsc clean; core jest for touched suites; web vitest for my-day; typecheck, lint, gen.mjs --check.
