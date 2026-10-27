HMIS Lab Bridge - capture mode
==============================

This program records what a lab analyser sends, exactly as it sends it, so HMIS can be taught to
read it. It sends NOTHING to HMIS and needs no login.

Use a quality-control or test sample with a made-up sample ID (for example TEST001) and no patient
name. The captured file holds whatever the analyser sends.

1. Use a PC that is on the same network switch as the analyser.
2. Double-click  start-capture.cmd
   Windows may say "Windows protected your PC" - click "More info", then "Run anyway".
   Click "Yes" when Windows asks for administrator permission (it opens port 5100 in the firewall).
3. The black window shows "Server IP" and "Port". Leave the window open.
4. On the analyser, open its communication / LIS settings and enter that Server IP and Port.
   Turn on LIS / auto communication. Save.
5. Run the test sample. When the analyser finishes, the window shows a line like
     HL7 ORU^R01 1234 bytes -> ....hl7 (ACK sent)
6. Send the whole "captures" folder (next to this file) to the HMIS team.

Other port: start-capture.cmd 6000  (from a command prompt in this folder).
To stop: close the black window.

What is in this folder
  node.exe          Node.js (https://nodejs.org) - runs the program. MIT licence.
  capture.mjs       the hospital's capture program (source in the HMIS repository, tools/lab-bridge).
  captures\         created on first run; the recorded messages and capture.log.
