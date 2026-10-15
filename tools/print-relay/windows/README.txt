HMIS Print - the counter's print program
========================================

1. Double-click  install.cmd
   Windows may say "Windows protected your PC" - click "More info", then "Run anyway".
   (The program is the hospital's own and is not signed by a publisher.)
2. Type the code from HMIS: Admin > Printing > Add a computer.
3. A page opens in your browser. Press "Print a test page".

To remove it: double-click uninstall.cmd (it is also in the program's folder).

What is in this folder
  node.exe          Node.js (https://nodejs.org) - runs the program. MIT licence.
  SumatraPDF.exe    SumatraPDF (https://www.sumatrapdfreader.org) - sends a PDF to the printer.
                    Unmodified. GPLv3 - see LICENSES. Its source: https://github.com/sumatrapdfreader/sumatrapdf
  launcher.mjs, app the hospital's print program (source in the HMIS repository, tools/print-relay).
