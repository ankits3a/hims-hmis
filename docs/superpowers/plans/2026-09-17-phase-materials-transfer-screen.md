# Materials — the stock transfer screen (2026-09-17)

**Lane** `p19b-retail-returns` worktree, branch `lane/materials-transfer-screen`. No migration.

## 1. WHY

The pharmacy handoff's fourth item: *"A transfer screen for `/materials/transfers`. It exists only as
an API; the retail shelf is stocked by GRN today."* Plan 14 T7 built a two-sided transfer: the
issue moves stock into a real `IN-TRANSIT` store, and the receipt moves only what the receiver
confirms. Reading it for the screen found three gaps:

- **Nobody in the pharmacy could receive.** `pharmacy` held `materials.stock.read` and `grn.qc`, but
  not `materials.stock.receive`. A transfer into `PHARM-RETAIL` could only be confirmed by the
  storekeeper who sent it.
- **Nothing stopped that.** `receiveStock` did not compare the receiver with the issuer. DD9 speaks
  of "the two signatures", but they could be one person's.
- **The reads return ids.** Store, item and batch ids and user ULIDs, with no batch endpoint to
  decode them. A screen built on those would show ULIDs (the P12 walk's defect).

## 2. DECISIONS (the standard Indian hospital answer: the stores issue, the indenting unit acknowledges)

- **TS-1. `pharmacy` gains `materials.stock.receive`.** The dispensary confirms what reached its
  shelf. README table and prose, role model, and the pinned counts are updated: pharmacy 27 → 28 in
  both arrays, model pairs 351 → 352, and the materials table's pharmacy ticks 4 → 5.
- **TS-2. Two people.** The issuer never receives their own transfer (`transfer_self_receipt`, 409).
- **TS-3. The destination's own staff.** A store that names its keepers (`attributes.custodianRoles`,
  set by `seed:pharmacy` on both pharmacy counters) is received into only by a holder of one of those
  roles (`not_store_keeper`, 409). A store that names none is received into by anyone but the issuer.
- **TS-4. One read with names.** `GET /materials/transfers/worklist?storeId=` returns two lists.
  Both carry store code and name, item code, name and unit, batch number and expiry, and who
  issued and received with the time.
  - **`awaiting`**: in transit (to the store when given), oldest first.
  - **`recent`**: the latest 50, from or to the store when given, newest first.
  - Staff say a transfer aloud as `TR-` plus the id's last six characters. A document number would
    need a migration; this is enough to find it on the list.
- **TS-5. The screen.** `/materials/transfers` is gated `materials.stock.read`; each act checks its
  own grant.
  - **Send stock** (`materials.stock.issue`): from, to (never the same), items found by name or code
    with what the source can give now (on hand less reserved and frozen), quantities in whole base
    units, and a note. The server picks batches earliest expiry first.
  - **Awaiting receipt** (`materials.stock.receive` to act): each line starts at what was sent. The
    receiver types what they counted, and the screen shows the shortfall as they type. A refusal is
    shown as a sentence.
  - **Recent transfers**: people's names, never ids. A short transfer is highlighted.
- **Not built.** A batch override on the send form. The API takes one with a reason; FEFO is the
  counter's rule and the override is the exception. Resolving a shortfall is 14c's variance
  machinery, as before.

## 3. AS BUILT

- **Core.**
  - `transfers.ts`: the two refusals in `receiveStock`, plus `transferWorklist` / `transferViews`.
  - `errors.ts`: two codes, with en and hi sentences.
  - The route, the manifest menu entry, and the `index.ts` exports.
  - `seed-roles.ts`.
- **Web.**
  - `materials-transfers.tsx`: `SendStock`, `Awaiting` and the recent list.
  - `materials-api.ts`: `fetchTransferWorklist`, `fetchAvailableAt`, `issueTransfer`,
    `receiveTransfer`.
  - Router, nav, and en/hi strings.
- **Pins.** The web route count goes 63 → 64 (`caddyfile-parity`). `nav-parity` is green with the
  new entry.
- **Runbook.** `pharmacy-go-live.md` §9.3: the retail shelf is stocked by GRN or by a transfer a
  pharmacist confirms.

## 4. TESTS

- **`transfers.test.ts`.**
  - The existing receives are now signed by a second person (`KEEPER`).
  - +2 tests:
    1. The issuer is refused, a non-keeper is refused, a pharmacist receives, and a store with no
       keepers accepts anyone but the issuer.
    2. The worklist, with names, order and store narrowing.
- **`test/materials.e2e.test.ts`.** Over HTTP, the self-receipt is refused 409; a second user
  receives; the worklist names the destination.
- **`materials-transfers.test.tsx` (3).**
  1. Send: availability, the zero quantity, and the body.
  2. Receive: starting values, a shortfall, a refusal sentence, then success.
  3. The store filter.

## 5. MUTANTS (12, each with a written prediction; 12 killed, every count as predicted)

| # | mutant | predicted | result |
|---|---|---|---|
| T1 | the issuer may receive | 1 | 1 |
| T2 | the keeper check skipped | 1 | 1 |
| T4 | awaiting not narrowed to the destination | 1 | 1 |
| T5 | recent listed oldest first | 1 | 1 |
| T6 | the receiver's name dropped | 1 | 1 |
| T7 | recent narrowed to the sender only | 1 | 1 |
| W1 | available ignores reserved and frozen stock | 1 | 1 |
| W2 | a zero quantity can be issued | 1 | 1 |
| W3 | the received boxes start empty | 1 | 1 |
| W4 | only the edited lines are sent | 1 | 1 |
| W5 | the store filter is not sent | 1 | 1 |
| W6 | the send form shows without the issue grant | 1 | 1 |

## 6. VERIFIED (lane, 2026-09-17, under the test lock)

- `pnpm typecheck`: clean. eslint on the touched files: clean.
- Core: `src/modules/materials`, `src/modules/ot`, `test/materials.e2e`, `test/caddyfile-parity`,
  `test/nav-parity`, `test/seed-roles`, `test/seed-pharmacy` and `test/pharmacy.e2e` give
  **37 suites, 449 tests, all green**.
- Web, full: **125 files, 1,103 tests, all green**.
- **Browser walk** (stub API, real Chromium, 1280 and 400 px). An item was sent and a short receipt
  confirmed. At 400 px the page was 446 px wide: the recent list's line spans had no break
  opportunity, and the tables had no scroll container. Both are fixed, and the page now measures
  400.
