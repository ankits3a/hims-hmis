# HMIS Print - installs the counter's print program for this Windows user.
#
#   1. copies the program into  %ProgramData%\HMIS Print\program   (falls back to %LOCALAPPDATA%)
#   2. asks for the one-time code from HMIS  Admin > Printing > Add a computer
#   3. picks the printer (the Windows default if it prints paper) - changeable on the status page
#   4. starts the program now and at every log-in (a shortcut in the Startup folder; no service,
#      because a service runs as SYSTEM and does not see a user's USB printer)
#
# Needs no administrator rights. Re-running it over an existing install updates the program files
# and keeps the enrolment. Nothing here is hidden: read it before you run it.
param(
  [string]$Server = "https://hmis.crkmch.com",
  [string]$Code = "",
  [string]$Printer = ""
)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

function Stop-HmisPrint {
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='wscript.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*HMIS Print*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
}

Write-Host ""
Write-Host "HMIS Print - setting up this computer" -ForegroundColor Green
Write-Host ""

# 1. where it lives
$home1 = Join-Path $env:ProgramData "HMIS Print"
try {
  New-Item -ItemType Directory -Force -Path $home1 | Out-Null
  $probe = Join-Path $home1 ".write-test"; Set-Content -Path $probe -Value "ok"; Remove-Item $probe
} catch {
  $home1 = Join-Path $env:LOCALAPPDATA "HMIS Print"
  New-Item -ItemType Directory -Force -Path $home1 | Out-Null
}
$prog = Join-Path $home1 "program"

Stop-HmisPrint
New-Item -ItemType Directory -Force -Path (Join-Path $prog "app") | Out-Null
Copy-Item -Force (Join-Path $src "node.exe"), (Join-Path $src "SumatraPDF.exe"), (Join-Path $src "launcher.mjs"), (Join-Path $src "uninstall.cmd"), (Join-Path $src "uninstall.ps1") -Destination $prog
Copy-Item -Force (Join-Path $src "app\*") -Destination (Join-Path $prog "app")
if (Test-Path (Join-Path $src "LICENSES")) { Copy-Item -Recurse -Force (Join-Path $src "LICENSES") -Destination $prog }
$node = Join-Path $prog "node.exe"
$launcher = Join-Path $prog "launcher.mjs"

# 2. the one-time code (skipped when this computer is already set up)
if (-not (Test-Path (Join-Path $home1 "relay.json"))) {
  $done = $false
  while (-not $done) {
    if ($Code -eq "") {
      Write-Host "In HMIS on any computer: Admin > Printing > Add a computer. It shows a code like ABCD-EFGH."
      $Code = Read-Host "Type the code here"
    }
    $a = @("`"$launcher`"", "enrol", "--code", "`"$Code`"", "--server", "`"$Server`"", "--home", "`"$home1`"")
    if ($Printer -ne "") { $a += @("--printer", "`"$Printer`"") }
    $p = Start-Process -FilePath $node -ArgumentList $a -NoNewWindow -Wait -PassThru
    if ($p.ExitCode -eq 0) { $done = $true } else { Write-Host ""; Write-Host "That did not work - see the line above." -ForegroundColor Yellow; $Code = "" }
  }
} else {
  Write-Host "This computer is already set up - the program files were refreshed."
}

# 3. the launcher that keeps it running, hidden, and restarts it after an update
$vbs = Join-Path $prog "run-hidden.vbs"
@"
' HMIS Print - runs the program with no window and starts it again if it stops (an update restarts it).
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("HMIS_PRINT_SUPERVISED") = "1"
Do
  sh.Run """$node"" ""$launcher"" run --home ""$home1""", 0, True
  WScript.Sleep 5000
Loop
"@ | Set-Content -Path $vbs -Encoding ASCII

# 4. start at log-in, and now
$startup = [Environment]::GetFolderPath("Startup")
$lnk = Join-Path $startup "HMIS Print.lnk"
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$s.Arguments = "`"$vbs`""
$s.WorkingDirectory = $prog
$s.Description = "HMIS Print - the counter's print program"
$s.Save()

Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList "`"$vbs`""
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "Done. HMIS Print is running and will start by itself when this user logs in." -ForegroundColor Green
Write-Host "Its status page is opening in your browser: http://127.0.0.1:47600/"
Write-Host "Press 'Print a test page' there. If the wrong printer is shown, choose the right one on that page."
Start-Process "http://127.0.0.1:47600/"
