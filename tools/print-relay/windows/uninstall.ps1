# HMIS Print - removes the program from this computer. The administrator should also press
# "Remove" for this computer in HMIS (Admin > Printing), which ends its key on the server.
$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='wscript.exe'" |
  Where-Object { $_.CommandLine -like "*HMIS Print*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item (Join-Path ([Environment]::GetFolderPath("Startup")) "HMIS Print.lnk") -Force
Start-Sleep -Seconds 1
foreach ($base in @($env:ProgramData, $env:LOCALAPPDATA)) {
  $h = Join-Path $base "HMIS Print"
  if (Test-Path $h) {
    # Run from a copy: this script may be inside the folder it is deleting.
    Remove-Item (Join-Path $h "agent.key") -Force
    Remove-Item (Join-Path $h "relay.json") -Force
    Remove-Item (Join-Path $h "spool") -Recurse -Force
    Remove-Item (Join-Path $h "app-next") -Recurse -Force
    Remove-Item (Join-Path $h "logs") -Recurse -Force
    Start-Process cmd.exe -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$h`"" -WindowStyle Hidden
  }
}
Write-Host "HMIS Print has been removed from this computer."
