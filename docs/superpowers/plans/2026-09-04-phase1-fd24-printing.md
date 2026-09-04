# FD-24 — the counter prints: token slip, payment receipt, prescription sheet, vitals slip

**Status:** AUTHORED, not approved, not started.
**Lane:** front-desk. **Gated on:** PR #50 merging (do not start in that branch).
**Design:** `docs/design/2026-08-29-opd-counter-flow-v2/` — **v2, not v1.**

---

## 0 · Why this phase exists

`/counter` cannot print. Not "prints badly" — there is no print path at all, and the screen lies
about it: the flow-help overlay says *"slip prints at assignment, stamped UNPAID"* and the hand-over
script at the bill stage reads *"Say it, then hand the slip."* A clerk following the screen's own
instructions has nothing to hand over. The owner found this by looking for the button.

`components/counter-slip.tsx` was built for the old `/counter` and has had **zero importers** since
FD-9 deleted that screen.

## 1 · The owner's rulings, all of them, so none is re-litigated

| # | Ruling | Date |
|---|---|---|
| R1 | Printing is **server-side** (option B). Not browser printing. | 2026-09-04 |
| R2 | The **A4 prescription prints at the FRONT DESK**, after the token is generated. | 2026-09-04 |
| R3 | The **vitals desk gets its own thermal printer**, for vitals + basic patient details. | 2026-09-04 |
| R4 | A **relay inside the hospital** is acceptable. | 2026-09-04 |
| R5 | The A4 **keeps its blank vitals strip** for manual writing, despite R3's slip. | 2026-09-04 |
| R6 | (Earlier, `PrinterChoice.dc.html`) Three printer classes; 4×6 label printers off the list for billing. | 2026-08-29 |

**Why browser printing was ruled out, recorded so it is not proposed again:** Chrome's
`--kiosk-printing` prints silently to the machine's **default** printer and there is no browser API
to choose a printer per job. R2 puts two printers on one desk, so kiosk mode cannot express it. The
same wall appears in CSS — `@page` size is per *document*, not per element, so two page sizes cannot
leave one `window.print()` call.

## 2 · The shape, and the constraint that decides it

**Production is a Hetzner CX43 in Helsinki; the printers are on a LAN in Hajipur.** The server cannot
reach a printer. So "server-side" is built as an **outbox the server owns and a relay the hospital
runs**:

```
  screen  ──enqueue──▶  print_jobs (Postgres, server)  ◀──long-poll── relay (in the hospital)
                                                                         │
                                                                         ▼
                                                                   CUPS ─▶ 3 printers
```

The relay holds an **outbound** connection (no inbound firewall hole), claims jobs, renders or
receives the document, submits to a named CUPS queue, and reports back. One per **site**, not per
desk — that is the whole advantage over the per-PC agent that was rejected.

**It must queue locally and keep printing through an internet outage.** The project brief's binding
constraint is *"patient care must never depend on internet connectivity"*, and with the server in
Helsinki an uplink failure would otherwise stop every slip in the building. A job already claimed by
the relay must complete without the server.

**Follow `kernel/notify/`, do not invent.** That module is already an outbox with exactly this shape
— `status` + `next_attempt_at` on the row, an `enqueue`, a `pump`, `adapters`, a `consumer`, a
`dedupeKey` unique index that makes at-least-once redelivery insert nothing. `print_jobs` is the same
pattern with a different sink. Reuse its idioms, its retry semantics and its dedupe rule.

## 3 · The four documents

| Document | Printer | Page | Design artboard |
|---|---|---|---|
| OPD token slip | front-desk thermal | 72 mm × continuous | `TokenSlip72.dc.html` |
| OPD payment receipt | front-desk thermal | 72 mm × continuous | `PaymentReceipt.dc.html` |
| Prescription sheet | front-desk A4 laser | A4 | `RxPageBlank.dc.html` |
| Vitals slip | vitals-desk thermal | 72 mm × continuous | *(new — no artboard yet)* |

The vitals slip has **no design**. It is R3's, invented this session, and it should get an artboard
before it is built rather than being improvised in code.

**Devanagari is load-bearing on the thermal documents** — the token slip carries
`भुगतान शेष — काउंटर 5` and the bilingual "Go next to" block. `DevanagariSpec.dc.html` is the spec.
FD-10/FD-11 already paid for getting Devanagari wrong on screen; a thermal printer is fussier.

## 4 · Tasks

- **T1 · `print_jobs`, the outbox.** Migration + schema + `enqueuePrintJob`, modelled on
  `kernel/notify/enqueue.ts`. Dedupe key so a double-click prints once. Status ladder and
  `next_attempt_at`. Nothing renders yet.
- **T2 · The claim/report API.** `POST /print/claim` (relay long-polls, claims N jobs),
  `POST /print/:id/done|failed`. Its own permission and its own actor type — the relay is not a user.
  Rate-limited; a relay that dies mid-job must not strand the row (visibility timeout).
- **T3 · Rendering.** Server-side HTML→PDF via the Chromium already on the box
  ([[chromium-on-build-host]]). One renderer, four templates, each with its own `@page`. **This is
  where the 72 mm page size enters the codebase — there is none today.**
- **T4 · The relay.** A small process: claim, submit to CUPS by queue name, report. Local spool so an
  outage does not stop the counter. Packaged to run on any always-on machine in the hospital.
- **T5 · The screens.** Desk One enqueues the token slip and the A4 at the right moment (R2: after
  the token is generated); the vitals desk enqueues its slip. Print status is visible and a failure
  is *reported on the screen*, not swallowed. Reprint is a first-class action (`F9` in the design).
- **T6 · Retire the orphans.** `counter-slip.tsx` (zero importers) and the A5-page `token-slip.tsx`
  wired into `/opd/desk` and `/opd/appointments` either move onto the new path or are deleted. Do not
  leave two token-slip implementations in the tree.

## 5 · Open, needs the owner

1. **Does a print failure block the counter, or is it advisory?** A patient can be sent to the doctor
   on a spoken token; a hospital that stops taking money because a printer jammed is worse than one
   that prints late. Default assumption if unanswered: **advisory**, loudly, with reprint.
2. **The vitals slip needs an artboard** before T5.
3. **Procurement:** all three printers should be **network** printers, not USB, so the relay reaches
   them without being physically attached. Worth specifying before they are bought.

## 6 · Traps this lane has already paid for

- **`stubFetch` does not await handlers** (`test-utils.tsx:39`). An `async` route handler makes
  `JSON.stringify(Promise)` → `{}`, and the test fails for a reason that has nothing to do with what
  you were testing. Delay the *response* by wrapping `globalThis.fetch`, never the handler.
- **A test that waits for a heading is not waiting for the data.** `openFutureTab` waited for "The
  day's book" while the grid gated on `!slots.isFetching`; ten synchronous assertions sat on that
  race and CI failed one of them. Wait for the thing you are about to assert on.
- **`INSERT … SELECT … ON CONFLICT` evaluates the SELECT on every call**, not only when the insert
  lands. It put an aggregate in front of every token and cost a 5× regression that `perf-opd-queue`
  caught. Use `RETURNING (xmax = 0) AS inserted` to do work only on the insert branch.
- **Migrations are renumbered at rebase time, and the journal's `when` matters more than the file
  name.** Use `tools/renumber-lane-migrations.py`; drop the lane's test databases afterwards.
