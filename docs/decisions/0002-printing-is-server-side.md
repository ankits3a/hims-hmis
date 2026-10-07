# 0002 — Printing is server-side, through a relay inside the hospital

- **Date:** 2026-09-04   **Status:** Partly open — "no browser printing" is narrowed by 0045 (the browser is the fallback while no relay serves a counter)
- **Area:** printing, opd, front desk, vitals, billing, pharmacy, lab, radiology

## Decision

- The HMIS server submits documents to named printer queues (option B). No browser printing and no local print
  agent on any counter PC.
- What prints where:

  | Desk | Printer | Documents |
  |---|---|---|
  | Front desk (`/counter`) | 80 mm thermal (72 mm printable) | OPD token slip, OPD payment receipt |
  | Front desk (`/counter`) | A4 laser | Prescription sheet, printed AFTER the token is generated |
  | Vitals desk | A second 80 mm thermal | Vitals plus the patient's basic details |

- Later (from `PrinterChoice.dc.html`): pharmacy, lab and radiology invoices go to a 24-pin dot-matrix (two-part
  carbon, GST); the IPD final bill goes to A4 laser; sample tubes, film jackets and wristbands go to a 4×6 thermal
  label printer, DEFERRED until there is something to label.
- **The relay is accepted.** Production is hosted outside the hospital and the printers are on the hospital LAN, so
  "server-side" is built as one small relay process INSIDE the hospital: it holds an outbound connection to the
  server, receives jobs and hands them to the local CUPS. One relay per SITE, not per desk.
- The relay must queue locally and keep printing through an internet outage.
- All three printers should be NETWORK printers, not USB.
- The A4 prescription keeps its blank vitals strip ("keep the vitals strip on A4 to write manually if needed").
  The vitals-desk thermal slip does not replace it; the two overlap on purpose.

## Why

- Rejected: kiosk-mode browser printing (`window.print()` + Chrome `--kiosk-printing`). It prints silently to the
  machine's default printer and no browser API chooses a printer per job, so one machine has one destination. Once
  the A4 had to print at the front desk, the counter needed two printers. CSS `@page` size is also per document, so
  two page sizes cannot come out of one `window.print()` call.
- Rejected: a local print agent per counter PC (option A: software to install and keep alive on every machine), and
  thermal-silent plus A4-with-a-dialog (option C: one dialog per patient).
- B gives one place to configure, scales to any desk added later, and leaves an audit trail on the server of what
  was printed and when.
- The project brief's constraint: "patient care must never depend on internet connectivity". Hence local queuing.

## Consequences / how to apply

- A print failure is something the SCREEN must report, not the OS. Each printer needs a print-queue config.
- The relay needs any always-on machine inside the hospital (a Raspberry Pi will do). It collapses into the
  on-premises server when that lands.
- The design this builds to is `docs/design/2026-08-29-opd-counter-flow-v2/` (v2, not v1): `TokenSlip72.dc.html`,
  `RxPageBlank.dc.html`, `PrinterChoice.dc.html`, `PaymentReceipt.dc.html`, `DevanagariSpec.dc.html`.

## Open

- Whether a print failure blocks the counter or is only advisory. (For the glasses prescription, the owner later
  ruled "keep queuing" when the relay is down — see 0009.)
