---
issue: 574
status: built
approved: 2026-10-10
---
# SPEC — home-screen widgets (owner 2026-10-10)

Owner ask: two home-screen widgets for the staff app. (1) Quick camera: scan a barcode/QR and start
work on that patient and visit. (2) Copilot: talk or chat to the agent, read what the user may read,
ask it to draft, or to do / schedule acts on the user's behalf.

Owner answers 2026-10-10: Android first (iPhone after the App Store release); scan widget first;
drafts = messages to staff + reports/summaries; acts = reminders to myself, book/move appointment,
existing desk-copilot acts, roster/leave requests.

DECIDED (standard, no ruling needed): widgets show no patient data on home or lock screen; a tap
goes through the normal app unlock; every write the copilot does waits for one confirm tap; the
copilot runs as the asking user (never one grant more); native change => new APK, not OTA.

## Part A — Scan widget (lane `widget-scan`, one session)
Android widget "Scan patient" (1x1 and 2x1, CRK crest + camera icon). Tap opens `hmis://scan`,
the existing scan screen with the camera live. No new server code.
Done means:
1. The widget appears in the Android widget picker as "HMIS Scan" after installing the APK.
2. Tap from a cold start opens unlock, then the scan screen with the camera on, no home screen first.
3. Tap with the app already open goes straight to the scan screen.
4. Signed out: tap lands on sign-in, then the scan screen after sign-in.
5. Scanning a slip QR opens the same job the header scan button opens (same `scanPlan`).
6. Jest: deep-link route test fails before the change and passes after; mobile suite and tsc clean.

## Part B — Copilot chat + widget (lanes, several sessions, in this order)
B1 Mobile chat screen `/copilot` over the existing `POST /copilot/ask`; en + Hinglish; answers
   and existing acts only; confirm card before any write.
B2 Copilot widget: "Ask" and mic buttons; mic uses the server /speech/transcribe (needs ruling R-2; hidden until then). See PLAN E1.7.
B3 Acts: reminder to myself (push at a time), book/move appointment, leave/duty-swap request —
   each a `copilotTools` entry on the owning module, behind that module's existing permission.
B4 Drafts: message to staff, report/summary. NEW: the language model writes text here, which the
   current design forbids. A draft is shown as editable text, never sent or saved without the
   user's tap, and logged in the audit trail. Owner decision record owed before B4 starts.
Each B step gets its own "done means" spec before build.

Open: iPhone widgets (Swift WidgetKit target, EAS) after the iPhone app ships.
