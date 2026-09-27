$env:ANDROID_HOME = "C:\Users\USER-PC\btc\android-sdk"
$adb  = "$env:ANDROID_HOME\platform-tools\adb.exe"
$apk  = "C:\Users\USER-PC\Desktop\Command0r.apk"
$pkg  = "com.fxcommander.app"
& $adb uninstall $pkg 2>&1 | Out-Null
Write-Host "=== install ==="; & $adb install -r "$apk" 2>&1 | Select-Object -Last 1
& $adb logcat -c
Write-Host "=== launch ==="; & $adb shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Start-Sleep -Seconds 8
$pid1 = (& $adb shell pidof $pkg) -join ""
Write-Host "=== DIAG + error ==="
& $adb logcat -d 2>&1 | Select-String -Pattern "DIAGROOT|useSyncExternalStore|FATAL EXCEPTION|handleHostException" | Select-Object -First 20
Write-Host "=== END ==="
if($pid1.Trim().Length -gt 0){ Write-Host "RESULT: RUNNING pid $pid1" } else { Write-Host "RESULT: NOT RUNNING" }
