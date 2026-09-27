# Command0r release build (works around Metro inlineRequires crash on RN 0.81 New Arch)
# Full build: gradle native APK + manual JS bundle (inlineRequires OFF) + hermesc + inject + resign.
# JS-only rebuild: pass -JsOnly to skip gradle and reuse the last native APK.
param([switch]$JsOnly)

$env:JAVA_HOME = (Get-ChildItem "C:\Users\USER-PC\btc" -Directory | Where-Object { $_.Name -like 'jdk-17*' } | Select-Object -First 1).FullName
$env:ANDROID_HOME = "C:\Users\USER-PC\btc\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$nodeDir = if($node){ Split-Path $node } else { "" }
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$nodeDir;$env:PATH"

$real = "C:\Users\USER-PC\Desktop\Playground\TradeCommand_App"
$link = "C:\tc"
$bt   = "$env:ANDROID_HOME\build-tools\35.0.0"
$SP   = "C:\Users\USER-PC\AppData\Local\Temp\claude\scratchpad\final"
$apkGradle = "$link\android\app\build\outputs\apk\release\app-release.apk"
$ks   = "$real\android\app\debug.keystore"
New-Item -ItemType Directory -Force -Path $SP | Out-Null

# junction for short-path (MAX_PATH) native build
if(Test-Path $link){ cmd /c rmdir "$link" 2>$null }
cmd /c mklink /J "$link" "$real" | Out-Null
if(-not (Test-Path "$link\android\gradlew.bat")){ Write-Host "JUNCTION FAILED"; exit 1 }

if(-not $JsOnly){
  # metro.config.js must be ABSENT for the gradle bundle step (junction path mismatch);
  # gradle's embedded bundle is discarded and replaced below, so its content doesn't matter.
  Remove-Item "$real\metro.config.js" -Force -ErrorAction SilentlyContinue
  Remove-Item "$link\android\app\.cxx" -Recurse -Force -ErrorAction SilentlyContinue
  Set-Location "$link\android"
  Write-Host "=== gradle assembleRelease (native) ==="
  & .\gradlew.bat clean assembleRelease --no-daemon --console=plain 2>&1 | Select-String -Pattern "BUILD|FAILED|error:" | Select-Object -Last 8
  if(-not (Test-Path $apkGradle)){ Write-Host "GRADLE APK NOT FOUND"; exit 1 }
}

# --- Manual JS bundle with inlineRequires OFF (run from REAL dir so metro.config __dirname matches) ---
Set-Location $real
Copy-Item "$real\metro.config.inlineoff.js" "$real\metro.config.js" -Force
Get-ChildItem "$env:TEMP\metro-*","$env:TEMP\haste-map-*" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "=== manual JS bundle (inlineRequires off) ==="
& npx expo export:embed --platform android --dev false --bundle-output "$SP\index.android.bundle.js" --assets-dest "$SP\assets" 2>&1 | Select-Object -Last 3
Remove-Item "$real\metro.config.js" -Force -ErrorAction SilentlyContinue
if(-not (Test-Path "$SP\index.android.bundle.js")){ Write-Host "JS BUNDLE FAILED"; exit 1 }

Write-Host "=== hermesc compile ==="
& "$real\node_modules\react-native\sdks\hermesc\win64-bin\hermesc.exe" -emit-binary -O -out "$SP\index.android.bundle" "$SP\index.android.bundle.js" 2>&1 | Select-Object -Last 1
$magic = [System.IO.File]::ReadAllBytes("$SP\index.android.bundle")[0..3] -join ','
if($magic -ne "198,31,188,3"){ Write-Host "HERMESC OUTPUT NOT VALID (magic=$magic)"; exit 1 }

# --- Inject bundle into the gradle APK + resign ---
$work = "$SP\Command0r-unsigned.apk"
Copy-Item $apkGradle $work -Force
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($work, [System.IO.Compression.ZipArchiveMode]::Update)
$old = $zip.GetEntry("assets/index.android.bundle"); if($old){ $old.Delete() }
$entry = $zip.CreateEntry("assets/index.android.bundle", [System.IO.Compression.CompressionLevel]::NoCompression)
$os = $entry.Open(); $bytes = [System.IO.File]::ReadAllBytes("$SP\index.android.bundle"); $os.Write($bytes,0,$bytes.Length); $os.Close()
$zip.Dispose()
Write-Host "=== zipalign + sign ==="
$aligned = "$SP\Command0r-aligned.apk"
& "$bt\zipalign.exe" -f -p 4 $work $aligned
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey $aligned
& "$bt\apksigner.bat" verify $aligned 2>&1 | Select-Object -First 2

Copy-Item $aligned "C:\Users\USER-PC\Desktop\Command0r.apk" -Force
$sz = [math]::Round((Get-Item "C:\Users\USER-PC\Desktop\Command0r.apk").Length/1MB,1)
Write-Host "BUILD OK ($sz MB, bundle $($bytes.Length) B) -> Desktop\Command0r.apk"
