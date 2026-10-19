---
issue: 586
status: built
approved: 2026-10-11
---
# SPEC — E1.3 the copilot on the staff phone (2026-10-11)

**Status:** built at the owner's overnight instruction (2026-10-11 03:00 IST, "keep working on the decided
milestones and goals"); awaiting review. Lane `copilot-phone`, DRAFT PR. Plan §3 E1.3; decisions 0064, 0065.

1. **Screen.** `/copilot` on the phone, opened from a header button ("Ask") beside the scan mark on every
   signed-in screen. Signed out → sent to `/` (sign-in). One scroll view (KeyboardScrollView, vc24 rule) holds,
   top to bottom: the staff notice (until dismissed), three chips, the input row (box + Ask), answers newest first.
2. **Over `POST /copilot/ask`**, body `{question, screen: "phone", source: "chip" | "typed"}` — no `terms`: the
   server's E0.6 day-name masking covers the phone. The server records `source` in `copilot_asks.source`.
3. **Answers** render `t(answer.key, params)` from en/hi keys copied verbatim from the web (`copilot.answer.*`,
   `copilot.when.*`, `copilot.notice.*`); roster params are worded as the web's `sayParams` does. A day report
   arrives as the same sentence plus "Full report on computer" (the phone draws no report table).
4. **Wrong tap.** Each answer card has "Wrong". It calls new `POST /copilot/feedback {askId, wrong: true}`;
   the ask response now carries `askId`. Own asks only: another user's or an unknown ask id → 404. One row per
   ask (`copilot_ask_feedback`, migration — number taken at merge), deleted with the asks after 180 days. No
   new permission (sign-in only, self-scoped like `/copilot/notice`).
5. **Notice (0065).** `GET /copilot/notice`; if not seen, the one line + OK shows before the first ask;
   OK → `POST /copilot/notice`. Server state, so it shows once per person on any device, then never.
6. **Nothing stored on the phone:** history lives in screen memory only and is gone when the screen closes.
7. **Chips (DECIDED).** Each seat's top three, filtered by the permission the intent needs, merged across the
   person's seats in seat order, de-duplicated, capped at 3, filled with "My day report":
   - consult / vitals: Shortest line? (`queue_depth`, opd.queue.read) · My next duty · My next night (roster.read)
   - counter / slips: Shortest line? · My next duty · My day report (none)
   - onNow / myDuties: My next duty · My next night · My day report
   The sent question is a phrasebook phrase (en, and romanised Hindi for hi), so a chip never needs the model.

**Done means** (binary)
- [ ] every web `copilot.answer.*` key renders on the phone with the web's exact text, en and hi (test over the key list)
- [ ] a chip ask sends and records `source=chip`; a typed ask `source=typed` (e2e on the ledger row)
- [ ] Wrong writes one feedback row for my own ask; another user's ask id → 404, no row
- [ ] the notice shows when the server says unseen, OK dismisses it on the server, then it never shows again
- [ ] the input row is inside KeyboardScrollView (structural test)
- [ ] every chip question routes to its intent through the phrasebook (core test reads the app's locale files)
- [ ] mobile jest + `npx tsc --noEmit` clean; core typecheck, lint, targeted jest clean
