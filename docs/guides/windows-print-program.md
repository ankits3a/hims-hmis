# HMIS Print for Windows — install it on a counter PC

For a counter PC that has its own printer. After this, **hand over prints by itself, with no print window**.
Nothing here needs an administrator password on the PC.

## Before you start

- The A4 printer works from Windows (print any page from Notepad).
- You can log in to HMIS as an administrator on any computer.

## Install (about five minutes)

1. **Get the code.** In HMIS: **Users → Print computers → Add a computer**. Type a name for the PC
   ("Front desk 1") and press **Show the code**. A code like `ABCD-EFGH` appears. It works for 15 minutes, once.
2. **Download.** On the counter PC, on the same panel, click **Download HMIS Print for Windows**. Open the zip and
   drag the `HMIS-Print` folder to the Desktop.
3. **Run it.** Open the folder and double-click **install.cmd**.
   - If Windows shows a blue box *"Windows protected your PC"*: click **More info**, then **Run anyway**. The
     program is the hospital's own and is not signed by a publisher, which is all that warning means.
   - If an antivirus asks, allow `node.exe` and `SumatraPDF.exe` from the HMIS Print folder.
4. **Type the code** when the black window asks.
5. A page opens in the browser (`http://127.0.0.1:47600/`). It should say **Connected** and name the printer.
   Press **Print a test page**. If the wrong printer is shown, choose the right one on that page first.
6. **Tell HMIS this is the computer.** On the counter PC, in HMIS: **Menu → Printing → "The print program on this
   computer"** → choose the name you gave. It should say *"… is running — papers go to …"*.

Now open a visit and press **hand over**: the prescription sheet prints with no window.

## If nothing prints

| What you see | What to do |
|---|---|
| The status page does not open | Log out of Windows and in again (the program starts at log-in), or double-click `install.cmd` again — it keeps the set-up. |
| "Not connected to the hospital server" | Check the internet on that PC. Papers already fetched still print. |
| "No printer chosen" / "Printer … is not on this computer any more" | Choose the printer on the status page. |
| "Switched off by the administrator" | Somebody pressed Remove in HMIS. Add the computer again with a new code (run `uninstall.cmd` first). |
| HMIS says "… has not come out of the print program yet" | Press the button beside it — that paper prints from the browser's window this once. Then check the status page. |
| The test page is cut off or tiny | Tell the HMIS team the printer's model — see the checklist below. |

HMIS never waits on the program: if it has not asked for work for 90 seconds, hand over uses the browser's print
window exactly as before.

## Remove it

Double-click **uninstall.cmd** (in the downloaded folder, or in `C:\ProgramData\HMIS Print\program`). Then in HMIS,
**Users → Print computers → Remove** for that PC.

## What it is

- A folder at `C:\ProgramData\HMIS Print` (or under your user's AppData if that is locked): the program, a short
  queue of papers it has fetched, and its log files (`logs\`).
- It talks only to the hospital's server, over https, outbound. It opens no port to the network; the status page
  answers only on that PC itself.
- Its key is kept protected by Windows (DPAPI) and works only for that PC's own counter. If the status page says
  the key is "in a file in the program's folder", PowerShell was blocked on that PC — it still works; tell the HMIS
  team.
- It starts when that Windows user logs in (a shortcut named *HMIS Print* in the Startup folder). It is not a
  Windows service, because a service cannot see a user's USB printer.

## NOT YET VERIFIED ON A REAL WINDOWS PC — the first trial must check these

Everything below was built and tested on Linux as exact command lines and parsed answers. **One counter PC** should
try it before any other, with somebody from the HMIS team watching the status page and the log.

1. `install.cmd` runs under SmartScreen/antivirus as described, without administrator rights, and can write to
   `C:\ProgramData\HMIS Print`.
2. PowerShell lists the printers (`Get-CimInstance Win32_Printer`) and the default is picked; a printer name with
   Hindi characters arrives intact.
3. DPAPI protects and reads back the key (the status page says "protected by Windows").
4. Edge headless starts with the private profile and renders the prescription sheet to PDF — A4, 210 × 297 mm,
   margins as on the browser print, **Devanagari text as letters, not boxes** (Windows uses Nirmala UI).
5. SumatraPDF prints that PDF **silently** on the chosen printer at 100 % (`noscale,paper=A4`): the test page's
   border is whole on all four sides. Some printer drivers add their own unprintable margin — if the border is
   clipped, note the printer model.
6. The program starts by itself after a Windows log-out/log-in and after a restart, with no window.
7. A power cut mid-print: after the PC comes back, the paper prints once, not twice and not never.
8. Remove in HMIS stops it within a few seconds; `uninstall.cmd` leaves nothing running.
9. An update (when switched on) is picked up after a restart and the status page shows the new version.
