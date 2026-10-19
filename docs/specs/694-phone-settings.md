---
issue: 694
status: built
approved: 2026-10-11
---
# SPEC — phone app Settings (gear) (2026-10-11) — APPROVED by owner 2026-10-11

Owner request 2026-10-11; answers: Copilot switch follows the ACCOUNT; Reminders card leaves home (alerts stay).

1. **Top bar** keeps the bell and the scan mark; gains a **gear** (Settings). The language word ("हिंदी") and
   "Log out" leave the top bar. The copilot icon shows only when the person has turned Copilot on.
2. **Settings screen** (`/settings`), one short line per row:
   - Language: English / हिंदी (same switch as today, saved on the phone).
   - Reminders → opens today's Reminders screen.
   - Copilot: on/off switch, **off by default for everyone** (including people already using it).
   - This phone and My account → today's Account screen (moved off the home screen).
   - **Log out of this phone** button (same sign-out as today).
3. **Copilot switch follows the account**: new server setting per user (one small table, one migration),
   `GET /me/copilot-setting`, `PUT /me/copilot-setting {phone: true|false}`, self-scoped (no permission).
   DECIDED: it governs the phone app only; the web's ask box is unchanged.
4. Off ⇒ no copilot icon, `/copilot` opens Settings instead, no copilot chips on the phone home.
5. Home loses the Reminders card and the "This phone / My account" row; reminder notifications, the bell and
   Waiting-for-me's reminder line still work (the line opens Reminders).

**Done means:** (1) a fresh sign-in shows gear + bell + scan and no copilot icon, no language word, no Log out;
(2) turning Copilot on in Settings shows the icon at once and on another phone after sign-in (server test);
(3) Log out of this phone signs out exactly as before (session cleared, caches cleared);
(4) language switch in Settings changes the app language as before; (5) Reminders and Account open from
Settings; home shows neither card; (6) Hindi/English labels for every new word (parity test).
Build: lane `phone-settings`, one PR; new APK after merge.
