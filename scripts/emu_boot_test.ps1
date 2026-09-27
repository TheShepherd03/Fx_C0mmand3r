$env:JAVA_HOME = (Get-ChildItem "C:\Users\USER-PC\btc" -Directory | Where-Object { $_.Name -like 'jdk-17*' } | Select-Object -First 1).FullName
$env:ANDROID_HOME = "C:\Users\USER-PC\btc\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$avdm = "$env:ANDROID_HOME\cmdline-tools\latest\bin\avdmanager.bat"
$emu  = "$env:ANDROID_HOME\emulator\emulator.exe"
$adb  = "$env:ANDROID_HOME\platform-tools\adb.exe"
$img  = "system-images;android-35;google_apis;x86_64"
$apk  = "C:\Users\USER-PC\Desktop\Command0r.apk"
$pkg  = "com.fxcommander.app"

# 1. Create AVD if missing
$avds = & $avdm list avd 2>&1 | Out-String
if($avds -notmatch "cmdr_test"){
  Write-Host "=== creating AVD ==="
  "no" | & $avdm create avd -n cmdr_test -k $img -d pixel_6 --force | Out-Null
}
Write-Host "AVD ready"

# 2. Boot headless
Write-Host "=== booting emulator ==="
$p = Start-Process -FilePath $emu -ArgumentList "-avd","cmdr_test","-no-window","-no-audio","-no-boot-anim","-no-snapshot","-gpu","swiftshader_indirect","-netdelay","none","-netspeed","full" -PassThru
& $adb wait-for-device
# wait for full boot
for($i=0;$i -lt 90;$i++){
  $b = (& $adb shell getprop sys.boot_completed 2>$null) -join ""
  if($b.Trim() -eq "1"){ break }
  Start-Sleep -Seconds 3
}
Write-Host "boot_completed=$((& $adb shell getprop sys.boot_completed) -join '')"

# 3. Install APK
Write-Host "=== installing APK ==="
& $adb install -r "$apk" 2>&1 | Select-Object -Last 3

# 4. Clear log, launch, capture
& $adb logcat -c
Write-Host "=== launching app ==="
& $adb shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Start-Sleep -Seconds 8

# 5. Is the process alive?
$pid1 = (& $adb shell pidof $pkg) -join ""
Write-Host "APP PID: '$pid1'"

# 6. Dump relevant logcat
Write-Host "=== CRASH / JS LOG ==="
& $adb logcat -d 2>&1 | Select-String -Pattern "ReactNativeJS|AndroidRuntime|FATAL|JavascriptException|com.fxcommander|useSyncExternalStore|useMemoCache|TypeError|Cannot read" | Select-Object -First 60
Write-Host "=== END LOG ==="
if($pid1.Trim().Length -gt 0){ Write-Host "RESULT: APP RUNNING (pid $pid1)" } else { Write-Host "RESULT: APP NOT RUNNING (crashed or exited)" }
