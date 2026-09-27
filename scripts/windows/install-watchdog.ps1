# Installs the Command0r terminal watchdog for the current Windows user (no admin):
# copies TerminalWatchdog.ps1 to %USERPROFILE%\Command0r, adds a shortcut to the
# user's Startup folder so it runs hidden at every logon, and starts it now.
#   powershell -ExecutionPolicy Bypass -File install-watchdog.ps1              # install / update
#   powershell -ExecutionPolicy Bypass -File install-watchdog.ps1 -Uninstall   # remove
param([switch]$Uninstall)

$dest     = Join-Path $env:USERPROFILE 'Command0r'
$script   = Join-Path $dest 'TerminalWatchdog.ps1'
$startup  = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Command0r Terminal Watchdog.lnk'
$ps       = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Stop-Watchdog {
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like '*TerminalWatchdog.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output "stopped watchdog pid $($_.ProcessId)" }
}

if ($Uninstall) {
  Stop-Watchdog
  if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Write-Output "removed $shortcut" }
  Write-Output "Uninstalled (scripts/logs left in $dest)."
  return
}

New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'TerminalWatchdog.ps1') -Destination $script -Force

$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath       = $ps
$lnk.Arguments        = $psArgs
$lnk.WorkingDirectory = $dest
$lnk.WindowStyle      = 7      # minimized (the script hides itself)
$lnk.Description      = 'Keeps the HFM and Deriv MT5 terminals running (Command0r)'
$lnk.Save()
Write-Output "startup shortcut: $shortcut"

Stop-Watchdog   # restart with the fresh copy
Start-Process -FilePath $ps -ArgumentList $psArgs -WindowStyle Hidden
Write-Output "watchdog running; log: $(Join-Path $dest 'watchdog.log')"
