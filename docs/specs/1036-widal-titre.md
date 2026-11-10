---
issue: 1036
status: built
approved: 2026-11-06
---
# SPEC — Widal: one titre range, a flag for a positive titre, and a titre grid (#1036)

Status: APPROVED 2026-11-06 by the owner and BUILT 2026-11-06 as specified (web bench; the phone bench shows the
flag but has no grid yet). Written after the owner asked for the fix and the grid ("do the needful … we hardly use
1:640 … the titre grid would help us in case of manual testing").

## Change 2026-11-10 (owner, from a reference Widal report)

- Cut-offs per antigen: S. typhi O, S. Paratyphi AH and BH are significant at **1:80 or more** (range "Up to 1:40");
  S. typhi H at **1:160 or more** (range "Up to 1:80"). Data migration 0227 corrects the live rows.
- No agglutination is written **"Non-Reactive"** (typed `negative`, `neg`, `nil`, `nr` and `non-reactive` all save as it).
- The printed report carries a short note under a Widal table: the cut-offs, paired samples 7–10 days apart, and
  confirm by blood culture before antibiotics.

The sections below describe the first version (2026-11-06).

## What

A positive Widal read as negative because S. typhi O and H carried the normal range "Negative" and a titre is never
flagged. All four Widal antigens (S. typhi O, S. typhi H, S. Paratyphi AH, S. Paratyphi BH) now share one normal range,
**"Up to 1:80"**. A titre of **1:160 or more** is flagged abnormal (`A`) and named in the draft summary. The quick bench
shows a **titre grid** under a Widal test: the four antigens against 1:20, 1:40, 1:80, 1:160 and 1:320. The
technologist ticks each dilution that shows agglutination, and the highest ticked dilution becomes that antigen's
result. Nothing ticked saves "Negative".

## Decisions

- DECIDED: the cut-off is the common Indian one, significant at 1:160 or more. The range row holds it as the text
  "Up to 1:80" (low and high stay empty), and the flag reads its limit from that text, so the two cannot drift apart.
- The fix reaches production through a data migration that corrects the four existing range rows and restamps their
  source. Reports already handed over keep the range they were reported against.
- The titre box stays typeable. Accepted: `1:<number>`, `Negative`, case-insensitive, and `1;80` is read as `1:80`.
  Anything else on a Widal line is refused with a sentence naming the antigen.
- The grid stores nothing of its own: the saved titre is the grid, and reopening a report ticks every dilution up to it.
- The same applies to the tube Widal test, which shares the four antigens.

## Done means

- **D1** A Widal antigen's normal range reads "Up to 1:80" on the bench, the printed report and the patient's reports list.
- **D2** A saved titre of 1:160 or 1:320 is flagged `A`; 1:20 to 1:80 and Negative are flagged `N`.
- **D3** The draft summary names a flagged Widal line ("S. typhi O is abnormal: 1:160") and no longer calls it in range.
- **D4** The quick bench shows the titre grid for a Widal test; ticking 1:20, 1:40, 1:80 and 1:160 fills 1:160, and no tick fills Negative.
- **D5** A Widal value that is not a titre or Negative is refused, and `1;80` saves as `1:80`.
