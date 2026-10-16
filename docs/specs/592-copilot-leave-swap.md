---
issue: 592
status: built
approved: 2026-10-11
---
# SPEC E2.2 — leave and duty cover/swap from the copilot chat (2026-10-11) — APPROVED by owner 2026-10-11

Owner answers 2026-10-11: build leave fully (screen + approver list + chat); Confirm tap = the person's own act;
refusal reason shown in Waiting-for-me and in chat, never in the phone notice; cover AND swap from chat.

1. **My leave (web + phone):** a person files their own leave (kind, from–to, optional reason) and sees each
   request's status; may cancel one not yet started. DECIDED: kinds offered = CL, EL, ML, comp_off (others stay
   manager-entered); no leave-balance check (no balance data exists).
2. **Approver list:** a department's leave requests go to whoever holds `roster.periods.publish` for that
   department (HOD / unit SR), on web and phone. Approve or Refuse; Refuse needs a reason (new column, one migration).
   The requester never decides their own (the existing segregation rule, plus a new fail-first test on the new path).
3. **Chat:** "kal CL chahiye", "20–22 Oct leave" → a confirm card (kind, dates) → Confirm files it, as the person,
   in the same list as the screen. The chat never takes a reason; any reason is typed only on the screen and is
   never sent to the AI. "Kal raat ki duty Dr X le lein" → cover card; "meri Sat night, unki Mon night" → swap card;
   Confirm sends the request the screen sends (`requestCover`). Rules the screen enforces refuse in a sentence.
4. **Rule change** (new decision record): roster policy cells `request_absence` / `request_cover` stay `never` for
   the copilot itself; an E0.2-confirmed act runs as the person (`direct`), exactly as their screen tap.
5. **Outcome back:** the notice says only "Leave not approved" / "Cover refused"; the reason shows in Waiting for me
   and when they ask "meri leave ka kya hua".

**Done means:** (1) a chat leave and a screen leave show identically in the approver's list, and approving either
writes the same row; (2) a refusal's reason comes back in chat and Waiting for me, and is absent from the push text;
(3) the requester's own approve is refused on the screen route and the chat route (fail-first); (4) no leave reason
appears in any copilot ledger row or model call (test reads the ledger); (5) a chat cover/swap equals a My-duties
request, and a rule break is refused at confirm; (6) phone mirrors web words (parity test).
Build: lane `copilot-leave`, two PRs — (a) leave screens + approver list + migration, (b) chat acts.
