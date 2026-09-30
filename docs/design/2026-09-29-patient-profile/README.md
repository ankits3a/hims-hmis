# Patient profile — `/patients/:id` (board, 29-Sep-2026)

`patient-profile.html` is the owner-APPROVED design board for the patient profile. It is the
specification for `apps/web/src/screens/patient-detail.tsx`: layout, sizes, tokens
(`apps/web/src/styles/paper-pine.css`), IBM Plex and copy are ported from it.

## Owner rulings that bind this screen

- **2026-09-29 (law) — Record a death.** A death does not save without the death certificate number;
  for a death in this hospital that is the MCCD certificate (Form 4 / 4A) number. Enforced on the
  server (`updatePatient` → 400 `death_certificate_required` with a plain sentence; column
  `patients.death_certificate_no`) and on the screen (the confirm stays disabled until a number is typed).
- **No filter chips or tabs on the timeline** (owner rule for lists). The source chip on each row
  (OPD, LAB, RAD, BILL, PHAR, DOC) says what it is.
- **Restricted (sealed) patient (28-Sep-2026).** The alias is the name everywhere on this page; the real
  name, contact, address and family links are not drawn and are not in the edit form. Only the Medical
  Superintendent breaks glass.
- **Front desk sees dues.** Never raw ids, enums, ISO dates or paise: dates print as `12-Mar-1955`,
  mobiles are masked to the last four digits, Aadhaar is never stored or shown.
- **Acts follow permissions.** Each act is drawn only for a seat holding the permission the server
  checks; the timeline folds clinical detail and money by the permissions the server already splits.

## As built (DECIDED where the board and the server differ)

- Edit details, allergy acts, representative acts and card reissue follow `patients.update` (the
  permission `PATCH /patients/:id` checks), not `patients.register` as the board's table says.
- Record a death / clear the mark follow `patients.deceased.write` (held by `mrd_officer`), because the
  server refuses anyone else; the front-desk seat therefore does not see it.
- Dues and bills follow `billing.invoice.read`. The `front_office` role does not hold it today, so a
  clerk without a cashier role sees no money on this page until that grant is made.
- Radiology rows carry the chip `RAD` (the study name says the modality); the board drew `XRAY`.

## Not built (needs server)

Membership card by patient; an audited "Show" for the full mobile; an alias-only wire shape and a
break-glass act for the MS on restricted records; the queue token and place in line on the today band.
