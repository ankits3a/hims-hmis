---
issue: 593
status: built
approved: 2026-10-12
---
# SPEC — reminders from the copilot chat (E2.3, #593) — APPROVED by owner 2026-10-12

Builds on E1.2 reminders (`kernel/reminders`, `createReminder`) and E0.2 propose → confirm → act (as E2.1/E2.2).

1. **Ask.** "remind me at 4 to see bed 12", "kal subah 9 baje yaad dilana BP check", "roz 8 baje medicine round
   yaad karana". New floor-only phrasebook intent `reminders.create` (remind / yaad dila / yaad kara / reminder
   laga / याद). Never on the model's menu: the words never reach a model.
2. **Read by rules, write nothing.** Time, day and repeat come from the words; the rest (minus the cue and time
   words) is the reminder text, trimmed. The chat shows one card: text · day + time · repeat, with **Confirm**.
   Only the confirm tap calls `createReminder` as the person — the same door as the Reminders screen.
3. **Time words (DECIDED).** A bare hour: 1–6 = pm, 7–11 = am, 12 = noon ("4" = 4:00 pm, "9 baje" = 9:00 am);
   "subah/morning/am", "dopahar", "shaam/evening/pm", "raat/night" override it. A time already gone today with no
   day named = tomorrow. "16:30", "4:30 pm", "aaj/kal/parso", weekdays, dates as in E2.2; "30 min baad",
   "2 ghante baad", "in 1 hour". Repeat: "roz / daily / har din" = daily; "har Monday / every Monday" = weekly;
   "Mon–Sat / OPD days" = mon_sat. The card always shows the time read, so a wrong guess is seen before Confirm.
4. **Refusals in one line, no card:** no time named → "What time?"; a named day's time already gone ("aaj 9 baje" at 10:00) → "That time has
   passed"; text empty → "Remind you of what?"; over 80 letters → "Keep it under 80 letters"; 20 already set →
   "You have 20 reminders; clear one first". At confirm the same checks run again (limit may have been reached).
5. **Privacy.** Tool is `privateQuestion` (ledger keeps no question text); the act ledger keeps the args hash and
   reminder id, never the text. The push stays "You have a reminder" (unchanged). Text is the person's own,
   shown only to them, as on the Reminders screen.
6. **Clients.** Web chat and phone chat show the card; after Confirm the phone's answer links to Reminders.
   Hindi and English for every new word.

**Done means:** (1) "remind me at 4 to see bed 12" asked at 10:00 IST → one card "see bed 12 · today 4:00 pm",
Confirm → one `user_reminders` row for the asker, due 16:00 IST, same as one made on the Reminders screen;
(2) the ask alone writes nothing; (3) "kal subah 9 baje yaad dilana BP check" → tomorrow 09:00, "roz 8 baje …" →
daily 08:00; "4" asked at 17:00 → tomorrow 4:00 pm; (4) no model is called and neither ledger table holds the text; (5) a 21st
reminder is refused at ask and at confirm; (6) the confirmed reminder fires through the existing bell + push.
Build: lane `copilot-reminders`, one PR, no migration; phone APK after merge.
