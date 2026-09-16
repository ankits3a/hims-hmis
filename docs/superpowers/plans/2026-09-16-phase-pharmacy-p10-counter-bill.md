# Pharmacy P10 — the patient's bill, printed at the counter (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-bill-print`, stacked on P9 (#218).

## 1. WHY

Runbook §8 said: *"No patient's copy of the pharmacy invoice … no screen in the application renders
an already-issued invoice."* That became half-stale once billing shipped `GET /billing/invoices/:id/print` and
`InvoicePrint` (Plan 08 T13; Desk One and the billing counter use them). But the pharmacy counter
never offered them.

An Indian patient leaves a chemist with a bill that names each pack's **batch and expiry**, and the
pharmacist. Billing's invoice lines carry a service, a quantity, a price and its tax, and nothing
about the pack.

## 2. DECISIONS

- **P10-1. Billing's document, not a second invoice.** The counter prints `InvoicePrint`: the
  letterhead, the stored lines and heads, the settlement and the signed QR, exactly as billing
  renders them. A pharmacy-built "bill" would be a second rendering of a tax document that could
  disagree with the first.
- **P10-2. The chemist's part is an annex.**
  - `InvoicePrint` takes an optional `annex`, printed inside the same `.print-doc` after the lines.
    Every other caller passes none and prints what it printed before; a test pins that.
  - The pharmacy annex comes from the label read (`GET /pharmacy/dispenses/:id/label`), which has
    batches from the pick onward. It shows the drug (with "(for X)" on a generic substitution),
    the batch, the expiry as MM/YYYY, the quantity, and "Dispensed by … · Reg. …" (P2).
- **P10-3. When the button appears.** "Print bill" shows on a billed or handed-over dispense that
  has an invoice, and never before billing.
- **P10-4. One printable document at a time.** The counter already mounts the dispense labels. The
  billing counter's precedent is to replace the screen with the print, so the counter does the
  same: the bill with "Back to the counter", and nothing else.
- **P10-5. No new grant.** `pharmacy` already holds `billing.invoice.read`.
- **P10-6. No core change.**

## 3. AS BUILT, AND WHAT PROVES IT

- **Code.** `components/pharmacy-bill-annex.tsx`, the `annex` prop, the counter's `billFor` state
  with its two reads, and the `pharmacyCounter.printBill` / `backToCounter` and `pharmacyBill.*`
  keys in en and hi. Runbook §8 is rewritten.
- **Tests.**
  - Counter (2 new):
    - Print bill shows the invoice number, the substituted line with its batch, expiry and
      quantity, the second line, and the dispensing pharmacist; the counter's refund form is gone
      while the bill is on screen and returns after Back.
    - A picked dispense offers no bill. This is an absence test, so its evidence is B1 below.
  - `invoice-print.test.tsx`: no annex section without an annex.
- **Mutants: 8, each with a written prediction. All were killed, each by exactly one test as
  predicted.**
  - B1: the bill offered before billing.
  - B2: the bill never replaces the counter.
  - B3: no annex.
  - B4: the expiry printed as ISO.
  - B5: the substitution hidden.
  - B6: Back does nothing.
  - B7: the pharmacist line dropped.
  - B8: an annex section on every invoice.
- The first draft reset `billFor` when a new dispense was taken. That code was unreachable, because
  the counter is hidden while a bill is shown, so it was removed rather than kept untested.

## 4. NOT BUILT

- The drug licence number and GSTIN on the letterhead. They are billing's letterhead
  configuration, and the owner owes the values.
- A thermal (80 mm) layout. The bill prints A5 through `.print-doc`.
- Reprint audit. It is billing's print route, and it logs what billing logs.
