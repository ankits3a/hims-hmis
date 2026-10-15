# Printing the prescription sheet from a counter computer

For a front-desk computer that has its own A4 printer and no hospital print box (decision 0045).

## What happens with no setup

1. Open the visit as usual and click **hand over**.
2. The browser's print window opens by itself with the prescription sheet ready. Press **Enter**.
3. The screen says "Prescription sheet sent to this printer." If the page did not come out, click **Print again**.

"Their papers" works the same way: **print** prints the paper at once. **save as PDF** is still there.

## Make it fully automatic (Windows, once per computer)

1. Windows **Settings → Bluetooth & devices → Printers & scanners**: open the A4 printer and choose
   **Set as default**. Turn off "Let Windows manage my default printer".
2. Right-click the desktop → **New → Shortcut**.
3. Paste this as the location.

   Google Chrome:

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://hmis.crkmch.com/counter
   ```

   Microsoft Edge:

   ```
   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk-printing https://hmis.crkmch.com/counter
   ```

4. Name it **HMIS**, click Finish, and pin it to the taskbar.
5. Close every Chrome (or Edge) window. From now on open HMIS only from this shortcut.

**What changes:** hand over prints the prescription sheet straight to the default printer. No print window appears.

**If Chrome was already open** when the shortcut is clicked, the setting is ignored. Close all its windows first.

**To undo:** open HMIS from the normal browser icon. The print window comes back.

## Choosing what prints

Menu → **Printing settings** (on Desk One: **PRINTING** at the bottom right).

- **How does paper come out here?** "Decide for me" prints on this computer while no hospital print box is running.
- **What prints at hand over:** the prescription sheet is on. The token slip and the payment receipt are off; they
  need a small roll printer.
- **Print a test page** checks the printer without a patient.

The choice is kept on that computer only.
