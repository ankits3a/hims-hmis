---
issue: 1080
status: approved
approved: 2026-11-14
---
# SPEC — Imaging: side (left/right) as an order field, and a shorter scan-room console (#1080)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM3 of the imaging programme #1075. Rulings: 0098.

## What

- The side travels as text inside the indication (`imaging-order-kit.tsx` `composeIndication`); "side required" is checked only by the card (line 143).
- The study's side has no writer before the console, so the console's own mismatch check never fires (`gates.ts` 953–986).
- The name tick at identity is not recorded (`room-console.tsx` 335; `gates.ts` 190).
- Protocol is a step even when nothing is published.

## Decisions

- `order_items.laterality` (null, `left`, `right`, `bilateral`). DECIDED: on the item, in the kernel, because one order can hold a left knee and a chest, and theatre and lab orders may use it later. The kernel's place input and the `order.placed` item carry it.
- `placeImagingOrder` refuses a side-applicable study with no side. The consumer writes the side onto the study at creation.
- The order card sends the side as a field; the indication is the doctor's question only.
- At the console the patient still points. A side that differs from the order is refused and names the referrer as the one who resolves it (the existing refusal, now reachable). Consent is checked against the same side.
- **Identity in one action.** The band box has focus when the patient opens. A scan (value then Enter) submits. Submitting is the attestation that the patient said their name; the evidence carries `nameStated: true` and the server refuses identity without it. DECIDED: two identifiers stay (NABH patient-identification goal).
- **Three steps always**: Identify, Acquire, Send. A published protocol shows as a card on Acquire; with none, nothing is shown.
- DECIDED (ruling 0098): typing the band value keeps working; the hospital buys one scanner per modality room and one for the portable trolley.

## Done means

- **D1** An order for a side-applicable study placed with `laterality: left` yields a study whose side is `left` before any gate is touched.
- **D2** The same order with no side is refused.
- **D3** Confirming `right` at the console for that study is refused with the mismatch code; `left` satisfies.
- **D4** The identity gate refuses a correct band without `nameStated`, and accepts it with.
- **D5** (web) Typing the band value and pressing Enter makes one gate call carrying `nameStated`.
- **D6** (web) A study with no published protocol shows three steps and no protocol card; one with a protocol shows the card on Acquire.
- **D7** (web) The order card sends the side as a field and the indication carries no side word.

## Out of scope

- the phone app's order sheet (follow-up issue); MPPS.

## Build notes

- **Files.** `kernel/db/schema/orders.ts`, `kernel/orders/` place, events, read (SHARED, kernel) · migration (SHARED) · radiology `consumers.ts`, `place.ts`, `gates.ts`, `radiology-orders.controller.ts` · `modules/ordering/seam.ts` · web `imaging-order-kit.tsx`, `room-console.tsx` · locales (SHARED).
- **Migration** yes (one column). **Permissions** none. **Size** M (kernel coordination). **Depends on** IM1 (same console file).
