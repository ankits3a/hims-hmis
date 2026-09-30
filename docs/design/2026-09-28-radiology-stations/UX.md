# UX bar for v3 (apply on every screen you own)

1. **First frame works.** The screen opens in a realistic working state; no empty shells. Lists sorted by urgency.
2. **One next act.** Where work is done, a sticky dock offers exactly one primary act; Enter runs it. Secondary acts are quiet links.
3. **No dead ends.** Every refusal names who fixes it AND carries a link that opens that seat (`go('rso:licences')`, `go('prep:bay')`, `go('hod:approvals')`). Every "not built" note stays, but never replaces a working control.
4. **No duplicates.** The centre never repeats the right-hand list. A fact lives on one card.
5. **Owner layout.** Header menu · left lane = the thing in hand · right = ONE list (no filter tabs) + Clocks collapsed → shrinks to one line + copilot when something is in hand. Dark only as highlight (the image viewer is the one dark surface).
6. **Presence is derived.** Opening a patient = arrived / in the room / claimed. No "Call", "Start", "Mark present" buttons that only record a fact.
7. **Words.** The user's words, not the schema's: "Kidney function", not `renal_function` — the code appears only inside refusals. Hindi + English wherever a patient is addressed.
8. **Numbers line up.** Tabular numerals, units always, times as HH:MM, money as ₹ with Indian grouping.
9. **390 px.** Nothing scrolls sideways; wide tables in `.tblw`.
10. **The spine.** Every row that stands for a study, critical, follow-up, bill, approval, access-log line, down machine or licence gap carries its `data-*` hook (SPINE.md). Lists render FROM the stores, never from a private copy.
