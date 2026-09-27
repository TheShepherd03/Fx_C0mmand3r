# Command0r terminal watchdog - started hidden at Windows logon (Startup folder).
#
#  * Launches the HFM and Deriv MT5 terminals if they aren't running.
#  * Relaunches a terminal that crashed or was killed (no clean "shutdown" line in
#    its journal since it last started).
#  * Leaves a terminal closed if YOU closed it normally (X / File > Exit); it comes
#    back at the next logon, or when you start it yourself.
#  * Pause everything: create a file named "watchdog.pause" next to this script
#    (delete it to resume). Log: watchdog.log next to this script.
#
# Install / uninstall: scripts\windows\install-watchdog.ps1 [-Uninstall]

$ErrorActionPreference = 'Continue'
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile   = Join-Path $Here 'watchdog.log'
$PauseFile = Join-Path $Here 'watchdog.pause'
$CheckSec  = 60      # how often to check
$MinGapSec = 300     # at most one relaunch per terminal per 5 min (no crash loops)

$Terminals = @(
  @{ Name = 'HFM';   Exe = 'C:\Program Files\HFM Metatrader 5\terminal64.exe'
     Data = Join-Path $env:APPDATA 'MetaQuotes\Terminal\E3E3B02889D32F38295D39BF94B6AD4A' },
  @{ Name = 'Deriv'; Exe = 'C:\Program Files\MetaTrader 5\terminal64.exe'
     Data = Join-Path $env:APPDATA 'MetaQuotes\Terminal\D0E8209F77C8CF37AD8BF550E51FF075' }
)

function Write-Log([string]$msg) {
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 512KB) {
      Move-Item $LogFile "$LogFile.old" -Force
    }
    Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding utf8
  } catch { }
}

function Test-Running($t) {
  [bool](Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $t.Exe })
}

# MT5 journal (UTF-16, one file per day): a normal close writes
# "Terminal  shutdown with N" after the last "... started for ..." line.
function Test-ClosedByUser($t) {
  $dir = Join-Path $t.Data 'logs'
  $files = Get-ChildItem $dir -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 2
  $lastStart = -1; $lastStop = -1; $i = 0
  foreach ($f in $files) {
    foreach ($line in (Get-Content $f.FullName -Encoding Unicode -ErrorAction SilentlyContinue)) {
      if ($line -match '\tTerminal\t.* started for ') { $lastStart = $i }
      elseif ($line -match '\tTerminal\tshutdown with') { $lastStop = $i }
      $i++
    }
  }
  return ($lastStop -gt $lastStart)
}

function Start-Terminal($t, [string]$why) {
  if (-not (Test-Path $t.Exe)) { Write-Log "$($t.Name): exe not found at $($t.Exe)"; return }
  Start-Process -FilePath $t.Exe
  Write-Log "$($t.Name): launched ($why)"
}

# One watchdog per session.
$mutex = New-Object System.Threading.Mutex($false, 'Local\Command0rTerminalWatchdog')
if (-not $mutex.WaitOne(0)) { exit }

Write-Log "watchdog started (pid $PID)"
Start-Sleep -Seconds 20   # let the network come up after logon

$lastLaunch = @{}
$userClosed = @{}
foreach ($t in $Terminals) {
  $userClosed[$t.Name] = $false
  $lastLaunch[$t.Name] = [datetime]::MinValue
  if (Test-Path $PauseFile) { continue }
  if (Test-Running $t) { Write-Log "$($t.Name): already running" }
  else { Start-Terminal $t 'logon'; $lastLaunch[$t.Name] = Get-Date }
}

while ($true) {
  Start-Sleep -Seconds $CheckSec
  if (Test-Path $PauseFile) { continue }
  foreach ($t in $Terminals) {
    $n = $t.Name
    if (Test-Running $t) { $userClosed[$n] = $false; continue }
    if ($userClosed[$n]) { continue }
    if (Test-ClosedByUser $t) {
      $userClosed[$n] = $true
      Write-Log "${n}: closed normally - leaving it closed until you start it or next logon"
      continue
    }
    if (((Get-Date) - $lastLaunch[$n]).TotalSeconds -lt $MinGapSec) { continue }
    Start-Terminal $t 'not running, no clean shutdown in journal (crash/kill)'
    $lastLaunch[$n] = Get-Date
  }
}
