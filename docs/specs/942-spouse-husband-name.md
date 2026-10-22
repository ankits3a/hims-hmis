---
issue: 942
status: built
approved: 2026-10-22
---
# SPEC — Spouse on the profile guardian list; Husband Name on a woman's prescription (#942)

Status: APPROVED 2026-10-22; BUILT 2026-10-22 as specified. D4–D6 pin behaviour that already held, so they passed before the build; D1–D3 were red.

## What

The patient profile's "Add a representative" dialog offers the same six relations as registration (Desk One web and
the mobile counter already offer Spouse). The prescription header names the husband for a woman whose spouse is on
file: the Guardian Name row becomes `Husband Name: <name>`.

## Decisions

- Spouse wins for a woman: a newer father link does not hide the husband.
- A man's wife stays `Guardian Name: C/o <name>` (DECIDED, standard practice). The print stays English.
- No spouse linked: the registration "father / husband name" box keeps printing `C/o`, even for a married woman
  (owner 2026-10-22). That box holds a father OR a husband, and the sheet does not guess.

## Done means

- **D1** The profile relation list is Father, Mother, Spouse, Sibling, Legal guardian, Other. Saving Spouse stores
  `spouse`, and the word exists in English and Hindi.
- **D2** A woman with a standing spouse link prints `Husband Name: <name>` in place of the Guardian Name row, with no
  `W/o`.
- **D3** A woman with a spouse link and a newer father link still prints Husband Name.
- **D4** Unchanged: a man with a spouse prints `Guardian Name: C/o <name>`; a woman with a father only prints
  `Guardian Name: D/o <name>`.
- **D5** A sealed patient prints `Guardian Name:` with a blank value. The label never shows that a husband exists.
- **D6** An ended or expired spouse link is not used, and the current rules apply.
