---
issue: 617
status: approved
approved: 2026-10-23
---
# SPEC — DDInter major drug–drug interactions as a reference layer (#617)

Status: APPROVED (design in decision 0052, 2026-10-07; licence confirmed by the owner 2026-10-23: "Build, licence sorted").

## What

DDInter 2.0's MAJOR pairs load into their own table, beside and never into the curated interaction book. The owner
supplies the DDInter export files; a script maps the drug names to formulary moieties and loads only Major. When the
kill switch `DDINTER_REFERENCE_ENABLED` is "true", the prescription check adds these pairs as severe hits labelled
"Reference interaction (DDInter)". Before anyone turns it on, a replay over stored prescriptions compares the warning
rate with and without the layer. It ships OFF.

## Decisions

- Curated pairs always win: any curated row for the same two moieties, active or retired, hides the reference pair.
- A reference pair gates like a curated severe pair: the doctor overrides it with a reason (decision 0052).
- Reference pairs are systemic only: a topical line never raises one (DECIDED; DDInter carries no route).
- Name mapping is exact: moiety name, moiety alias, or the FDA reference name map. Anything else is reported, not guessed.
- A re-import retires pairs the new file no longer holds; nothing is deleted.

## Done means

- **D1** The import loads only Major pairs from a DDInter CSV export (quoted commas parsed correctly), maps both names
  to formulary moieties, skips and counts Moderate, Minor and Unknown, and reports unmapped names. It is a dry run
  unless applied, and a second run of the same file changes nothing.
- **D2** With `DDINTER_REFERENCE_ENABLED` unset or "false", the prescription check returns exactly what it returns
  without the layer, even with reference pairs loaded. A value other than "true" or "false" is refused.
- **D3** With the switch "true", a reference pair between two lines is a severe hit whose note starts
  "Reference interaction (DDInter)" and names the source, and it is marked as a reference hit.
- **D4** Where the curated book holds the same pair (active or retired), the reference pair is not shown and the
  curated note and severity stand.
- **D5** The replay counts, over stored active prescriptions in a window, the prescriptions warned and the warnings
  with the curated book alone and with the reference layer, gives the ratio, and says when the rate more than
  doubles. It runs with the switch off and writes nothing.
- **D6** Every loaded row carries the source "DDInter 2.0", the licence "CC BY-NC-SA 4.0" and the retrieval date; a
  topical line never raises a reference pair.
