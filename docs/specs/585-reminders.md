---
issue: 585
status: built
approved: 2026-10-11
---
# SPEC — personal reminders (E1.2, decision 0064) — 2026-10-11 — lane `reminders` — DRAFT, awaiting owner yes

**What.** Any signed-in staff member sets a reminder for themselves on the phone ("4 pm — see bed 12", "every Monday 9 am"). At the time, their phone buzzes with a fixed sentence and the web bell shows it; the words they typed are seen only inside the app, only by them.

**Server (kernel/reminders, controller mounted in AlertsModule — no app.module.ts edit).**
- Table `user_reminders` (migration numbered at merge): id, user_id → users, text (1–80 chars), due_at timestamptz (next firing), repeat (`none|daily|mon_sat|weekly`), time_ist `HH:MM`, fired_at, cancelled_at, created_at. No patient column. Index on (due_at) where fired_at and cancelled_at are null.
- `createReminder(db, actor, {text, at, repeat})` / `listReminders` / `cancelReminder` exported from `kernel/reminders/index.ts`, so the E2.3 copilot act calls the same function after its one confirm. Routes: `GET /reminders`, `POST /reminders`, `POST /reminders/:id/cancel`.
- Firing: `runDueReminders(db, now)` runs inside the existing `runDueTimers` job tick (20 s, `WORKER_TIMERS_INTERVAL_MS`). DECIDED: no new job name, so the job census (jobs.test, scheduler.test, worker-runtime e2e, alerts-parity, `docker/prod/prometheus/alerts.yml`) does not move and the lane stays stageable; the existing runDueTimers staleness alert covers it. Each due row: raise a bell notice (`raiseNotice`, kind `personal_reminder`, title "Reminder", body = the text, key `reminder:<id>:<due ISO>`), then claim it with a conditional UPDATE (`WHERE id AND due_at = old AND cancelled_at IS NULL`). One-off: set fired_at. Repeating: move due_at to the next occurrence after now. Raise-then-claim + the alerts unique key = exactly once across a crash or a second worker.
- Phone: new push category `personal`, link `reminders`, sentence en "You have a reminder. Open HMIS to see it." / hi "आपका एक रिमाइंडर है। देखने के लिए HMIS खोलें।". `personal_reminder` goes in reach `NOTICE_KINDS` (never relayed to WhatsApp/SMS).

**DECIDED (standard practice, not owner rulings).**
- Repeat grammar: once · daily · Mon–Sat (hospital working week) · weekly (on the weekday of the first time). Nothing else.
- Time zone: IST fixed +05:30; times entered and shown as 24 h IST.
- Quiet hours: none apply. The person picked the time; it fires at any hour. Counts as an asked notice (not clock-driven), so it can use the full 12/hour phone budget. No mute switch for `personal` — you cancel the reminder instead.
- Late firing (worker down): fires once on recovery; a repeating one then skips to its next future time (no backlog burst).
- Limits: 20 active reminders per person; time must be 1 min to 365 days ahead; text 1–80 chars.
- Permission: any signed-in USER (agent keys and system actors refused); own reminders only — another person's id answers 404. No new permission (seed-roles count unchanged).
- Text: free, ≤80 chars; the form shows a one-line hint "No patient names". Stored only in `user_reminders` and that person's own bell row.
- Phone: a one-line "Reminders" card on every seat's home, under Attendance ("Next 16:00 · see bed 12" or "+ Reminder"), opens new screen `app/reminders.tsx`: list (next time, repeat, Cancel) + add form (text, time, repeat chips). Words short, one line at 390 px; en + hi keys `mobile.reminders.*` (Reminders/रिमाइंडर, Add/जोड़ें, Once/एक बार, Daily/रोज़, Mon–Sat/सोम–शनि, Weekly/हर हफ़्ते, Cancel/रद्द करें, Next/अगला). Tapping the push opens it.
- Web: the fired reminder appears in the web bell (live, any open tab). No web create screen and no browser push in E1.2 (web push today only arrives via the reach ladder after hours; router.tsx and web locales are shared files). Web create screen can follow if asked.

**Done means (binary, each a test that fails first).**
1. Fires within 60 s of due time: a reminder due at T raises its bell row on the tick at T+20 s (interval 20 s default).
2. Fires once after an API or worker restart: two ticks, two concurrent ticks, and a crash between raise and claim each leave exactly one bell row and one phone send.
3. Repeating ones can be listed and cancelled: GET lists them with next time; after cancel, the next due tick raises nothing.
4. Push payload contains no user text: the FCM message built for a `personal_reminder` alert contains neither the text nor the title, only the fixed sentence (test on the payload).
5. Another person's reminder: absent from my list; cancel answers 404; an agent-key actor is refused.
6. The 21st active reminder is refused; text of 81 chars is refused.
7. A repeating `daily`/`mon_sat`/`weekly` reminder fired on Saturday 16:00 IST moves to Sunday/Monday/next Saturday 16:00 IST.
8. A `personal_reminder` alert never climbs the reach ladder; job census counts unchanged; nothing under `docker/prod/` changed.
