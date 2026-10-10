# Packaged-app smoke tests (CI: .github/workflows/ci.yml › windows-smoke, release.yml › smoke).
#
# Every scenario installs the NSIS installer silently, per user, starts the INSTALLED Pevqori.exe (fuses
# on, so Playwright cannot attach) with throw-away profile/data folders and PEVQORI_SMOKE_TEST=1 — the app
# loads its window, calls app.state through the real preload → IPC → core worker → node:sqlite path, logs
# "Smoke test passed|failed" and quits with exit code 0/1 through the normal quit sequence
# (src/main/smoke.ts) — and finally uninstalls silently, checking that data and settings are kept.
#
#   -Scenario Install     (default) install, check the core worker was shipped outside app.asar
#                         (resources\app.asar.unpacked), smoke run, uninstall.
#   -Previous <exe>       (= -Scenario Upgrade) the in-place upgrade: install the previous release N−1, smoke
#                         run it, install N silently over it WITHOUT choosing a folder, then assert: one
#                         uninstall entry, the same install folder, DisplayVersion and Pevqori.exe version N,
#                         every file of the data and settings folders unchanged, %APPDATA%\Pevqori kept;
#                         smoke run N; installing N−1 again is refused with exit code 4 (when N−1 has the
#                         downgrade guard, i.e. 2.0.0 or later); uninstall keeps data and settings. Skipped
#                         with a notice when N−1 is not older than N.
#   -Scenario RunningApp  install, start Pevqori normally and leave it open, install again silently: the
#                         installer waits 30 s, exits with code 3 and changes nothing; Pevqori is still
#                         running (never killed by the installer); after Pevqori is closed the same silent
#                         install succeeds.
#   -Scenario Downgrade   install, pretend a newer version is installed (DisplayVersion 999.0.0 in the
#                         uninstall entry), install silently: exit code 4 and nothing changed; again with
#                         /ALLOWDOWNGRADE: installed, DisplayVersion back to N.
#
#   pwsh ./scripts/smoke-installed.ps1 -Installer release\Pevqori-Setup-2.0.0.exe [-Scenario …] [-Previous old.exe] [-Evidence dir]
#
# Installer exit codes (build/installer.nsh): 0 installed · 3 Pevqori still running · 4 downgrade refused.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [ValidateSet('Install', 'Upgrade', 'RunningApp', 'Downgrade')][string]$Scenario = 'Install',
  # The previous release's installer (Upgrade scenario).
  [string]$Previous = '',
  # The core starts within 30 s (or the app exits 1), the app then gives its own verdict within 90 s
  # (SMOKE_TIMEOUT_MS) and exits at most 40 s later (QUIT_DEADLINE_MS); waiting longer than all three
  # means the app's verdict, not a kill, decides the result (src/main/smoke.test.ts checks this).
  [int]$TimeoutSeconds = 180,
  # Folder that receives the app log (uploaded by CI when the job fails).
  [string]$Evidence = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Previous -and $Scenario -eq 'Install') { $Scenario = 'Upgrade' }
if ($Scenario -eq 'Upgrade' -and -not $Previous) { throw 'The Upgrade scenario needs -Previous <installer of the previous release>' }

$ExitInstalled = 0
$ExitAppRunning = 3
$ExitDowngrade = 4
# How long the installer waits for a running Pevqori before giving up (build/installer.nsh).
$AppRunningWaitSeconds = 30
$InstallerTimeoutSeconds = 300

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$runId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$root = Join-Path $base ("pevqori-smoke-" + $runId)
$installDir = Join-Path $root 'app'
$userData = Join-Path $root 'user-data'
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $root, $userData, $dataDir | Out-Null
$logFile = Join-Path $userData 'logs\pevqori.log'

# A file in the real settings folder: the installer and uninstaller must never delete it.
$appDataSettings = Join-Path $env:APPDATA 'Pevqori'
$appDataExisted = Test-Path $appDataSettings
$appDataSentinel = Join-Path $appDataSettings ".smoke-$runId"

function Write-Step([string]$text) { Write-Host "[$Scenario] $text" }

function Save-Evidence {
  if (-not $Evidence) { return }
  New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
  $logs = Join-Path $userData 'logs'
  if (Test-Path $logs) { Copy-Item -Path (Join-Path $logs '*') -Destination $Evidence -Force }
}

function Get-InstallerVersion([string]$path) {
  $m = [regex]::Match([System.IO.Path]::GetFileName($path), '^Pevqori-Setup-(.+)\.exe$')
  if (-not $m.Success) { throw "Cannot read the version from the installer name $path (expected Pevqori-Setup-<version>.exe)" }
  return $m.Groups[1].Value
}

# Numeric part of a semver (pre-release suffix dropped), as the installer's downgrade guard compares it.
function Get-CoreVersion([string]$version) { return [version](($version -split '[-+]')[0]) }

function Invoke-Installer([string]$path, [string[]]$arguments) {
  Write-Step "Running $([System.IO.Path]::GetFileName($path)) $($arguments -join ' ')"
  $p = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
  $null = $p.Handle # keep the handle so ExitCode is available after exit
  if (-not $p.WaitForExit($InstallerTimeoutSeconds * 1000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw "The installer did not finish within $InstallerTimeoutSeconds s"
  }
  Write-Step "Installer exit code $($p.ExitCode)"
  return $p.ExitCode
}

function Assert-ExitCode([int]$actual, [int]$expected, [string]$what) {
  if ($actual -ne $expected) { throw "$what exited with code $actual, expected $expected" }
}

# A registry value as text ('' when absent; StrictMode forbids reading a missing property).
function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return '' }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p -or $null -eq $p.Value) { return '' }
  return [string]$p.Value
}

# Our uninstall entries (electron-builder: key = GUID derived from appId, DisplayName "Pevqori <version>").
function Get-UninstallEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $found = @()
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    foreach ($key in Get-ChildItem -Path $r -ErrorAction SilentlyContinue) {
      $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $props) { continue }
      if (-not (Get-Prop $props 'DisplayName').StartsWith('Pevqori')) { continue }
      $found += [pscustomobject]@{
        Root = $r
        Path = $key.PSPath
        Key = $key.PSChildName
        DisplayVersion = Get-Prop $props 'DisplayVersion'
        Location = Get-EntryLocation $key.PSChildName $props
      }
    }
  }
  return , $found
}

function Get-EntryLocation([string]$keyName, $props) {
  $loc = Get-Prop $props 'InstallLocation'
  if ($loc) { return $loc.TrimEnd('\') }
  foreach ($k in @("HKCU:\Software\$keyName", "HKLM:\SOFTWARE\$keyName")) {
    $loc = Get-Prop (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue) 'InstallLocation'
    if ($loc) { return $loc.TrimEnd('\') }
  }
  $m = [regex]::Match((Get-Prop $props 'UninstallString'), '^"([^"]+)"')
  if ($m.Success) { return [System.IO.Path]::GetDirectoryName($m.Groups[1].Value) }
  return ''
}

function Get-SingleEntry {
  $entries = Get-UninstallEntries
  if ($entries.Count -ne 1) { throw "Expected exactly one Pevqori uninstall entry, found $($entries.Count): $(($entries | ForEach-Object { "$($_.Root)\$($_.Key) $($_.DisplayVersion)" }) -join '; ')" }
  if (-not $entries[0].Root.StartsWith('HKCU:')) { throw "The per-user installation was registered under $($entries[0].Root)" }
  return $entries[0]
}

# SHA-256 of every file below $dir (relative path → hash). Excluded: logs (the app appends to them) and
# Chromium's crash-reporter folder (written by a helper process that may outlive the app briefly).
function Get-TreeHashes([string]$dir) {
  $map = @{}
  if (-not (Test-Path $dir)) { return $map }
  $full = (Resolve-Path $dir).Path
  foreach ($f in Get-ChildItem -Path $full -Recurse -File -Force) {
    $rel = $f.FullName.Substring($full.Length).TrimStart('\')
    if ($rel -like 'logs\*' -or $rel -like 'Crashpad\*') { continue }
    $map[$rel] = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash
  }
  return $map
}

function Assert-SameTree([hashtable]$before, [hashtable]$after, [string]$what) {
  foreach ($k in $before.Keys) {
    if (-not $after.ContainsKey($k)) { throw "$what`: $k disappeared" }
    if ($after[$k] -ne $before[$k]) { throw "$what`: $k changed" }
  }
  foreach ($k in $after.Keys) { if (-not $before.ContainsKey($k)) { throw "$what`: $k appeared" } }
  Write-Step "$what unchanged ($($before.Count) files)"
}

function Set-AppEnvironment([bool]$smoke) {
  $env:PEVQORI_USER_DATA = $userData
  $env:PEVQORI_DATA_DIR = $dataDir
  if ($smoke) { $env:PEVQORI_SMOKE_TEST = '1' } else { Remove-Item Env:PEVQORI_SMOKE_TEST -ErrorAction SilentlyContinue }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

# Start the installed app in smoke mode and require its own verdict "passed" for $version.
function Invoke-SmokeRun([string]$exe, [string]$version) {
  if (-not (Test-Path $exe)) { throw "The installed app was not found at $exe" }
  $offset = if (Test-Path $logFile) { (Get-Item $logFile).Length } else { 0 }
  Set-AppEnvironment $true
  Write-Step "Starting $exe (smoke mode, expecting version $version)"
  $app = Start-Process -FilePath $exe -PassThru
  $null = $app.Handle
  if (-not $app.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    throw "Pevqori did not finish the smoke test and quit within $TimeoutSeconds s"
  }
  $code = $app.ExitCode
  # Chromium's helper processes end just after the main process; an installer started before they are
  # gone would (rightly) find Pevqori running.
  $dir = Split-Path -Parent $exe
  for ($i = 0; $i -lt 30 -and @(Get-PevqoriProcesses $dir).Count -gt 0; $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Path $logFile)) { throw "No log file was written ($logFile)" }
  $bytes = [System.IO.File]::ReadAllBytes($logFile)
  if ($bytes.Length -lt $offset) { $offset = 0 } # rotated
  $text = [System.Text.Encoding]::UTF8.GetString($bytes, [int]$offset, $bytes.Length - [int]$offset)
  Write-Host '--- pevqori.log (this run) ---'
  Write-Host $text
  Write-Host '------------------------------'
  if ($text.Contains('Core runtime failed to start')) { throw 'The core runtime failed to start' }
  if (-not $text.Contains('Smoke test passed')) { throw 'The log does not report "Smoke test passed"' }
  if (-not $text.Contains("app.state ok (version $version)")) { throw "The smoke run did not report version $version" }
  if ($code -ne 0) { throw "Pevqori exited with code $code" }
  Write-Step "Smoke test passed (version $version, exit code $code)"
}

function Assert-ExeVersion([string]$exe, [string]$version) {
  $info = (Get-Item $exe).VersionInfo
  $core = (Get-CoreVersion $version).ToString()
  if ($info.ProductVersion -ne $version -and -not ([string]$info.FileVersion).StartsWith($core)) {
    throw "Pevqori.exe reports version $($info.ProductVersion) / $($info.FileVersion), expected $version"
  }
}

# Pevqori.exe processes started from $dir. Callers count them as @(Get-PevqoriProcesses …).Count: with no
# match the call yields $null, and StrictMode does not allow .Count on $null.
function Get-PevqoriProcesses([string]$dir) {
  $exe = Join-Path $dir 'Pevqori.exe'
  return @(Get-Process -Name 'Pevqori' -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $exe } catch { $false } })
}

function Invoke-Uninstall([string]$dir) {
  $uninstaller = Join-Path $dir 'Uninstall Pevqori.exe'
  if (-not (Test-Path $uninstaller)) { return $false }
  $code = Invoke-Installer $uninstaller @('/S', '/currentuser')
  Assert-ExitCode $code 0 'The uninstaller'
  # The uninstaller copies itself to %TEMP% and returns at once; wait for the program file and then the
  # uninstall entry (removed last) to go.
  for ($i = 0; $i -lt 90 -and ((Test-Path (Join-Path $dir 'Pevqori.exe')) -or (Get-UninstallEntries).Count -gt 0); $i++) { Start-Sleep -Seconds 1 }
  return $true
}

function Assert-UninstalledKeepsData {
  if (Test-Path (Join-Path $script:location 'Pevqori.exe')) { throw 'Pevqori.exe is still there after uninstalling' }
  if ((Get-UninstallEntries).Count -ne 0) { throw 'An uninstall entry is left after uninstalling' }
  if (-not (Test-Path $dataDir)) { throw 'The data folder was deleted by the uninstaller' }
  if (-not (Test-Path $userData)) { throw 'The settings folder was deleted by the uninstaller' }
  if (-not (Test-Path $appDataSentinel)) { throw "$appDataSettings was deleted by the uninstaller" }
  Write-Step 'Uninstalled; data folder, settings folder and %APPDATA%\Pevqori kept'
}

$version = Get-InstallerVersion $Installer
$installerPath = (Resolve-Path $Installer).Path
$script:location = $installDir
$script:installed = $false
$running = $null

try {
  if ((Get-UninstallEntries).Count -ne 0) { throw 'Pevqori is already installed on this machine; the smoke test needs a clean machine' }
  New-Item -ItemType Directory -Force -Path $appDataSettings | Out-Null
  Set-Content -Path $appDataSentinel -Value $runId

  switch ($Scenario) {
    'Install' {
      # NSIS: /S silent, /currentuser per-user install, /D= target folder (must be last, unquoted).
      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser', "/D=$installDir")) $ExitInstalled 'The installer'
      $script:installed = $true
      $entry = Get-SingleEntry
      if ($entry.DisplayVersion -ne $version) { throw "DisplayVersion is $($entry.DisplayVersion), expected $version" }
      $worker = Join-Path $installDir 'resources\app.asar.unpacked\out\main\core-worker.cjs'
      if (-not (Test-Path $worker)) { throw "The core worker was not shipped unpacked ($worker missing)" }
      $updateConfig = Join-Path $installDir 'resources\app-update.yml'
      if (-not (Test-Path $updateConfig)) { throw "resources\app-update.yml is missing (electron-builder.yml publish)" }
      Invoke-SmokeRun (Join-Path $installDir 'Pevqori.exe') $version
    }

    'Upgrade' {
      $previousPath = (Resolve-Path $Previous).Path
      $previousVersion = Get-InstallerVersion $previousPath
      if ((Get-CoreVersion $previousVersion) -ge (Get-CoreVersion $version)) {
        Write-Host "::notice::Upgrade smoke skipped: the previous release $previousVersion is not older than $version."
        return
      }
      Write-Step "Upgrade $previousVersion → $version"
      Assert-ExitCode (Invoke-Installer $previousPath @('/S', '/currentuser', "/D=$installDir")) $ExitInstalled "The $previousVersion installer"
      $script:installed = $true
      $old = Get-SingleEntry
      if ($old.DisplayVersion -ne $previousVersion) { throw "DisplayVersion is $($old.DisplayVersion), expected $previousVersion" }
      $script:location = $old.Location
      Invoke-SmokeRun (Join-Path $old.Location 'Pevqori.exe') $previousVersion
      Set-Content -Path (Join-Path $dataDir 'smoke-sentinel.txt') -Value $runId
      $dataBefore = Get-TreeHashes $dataDir
      $settingsBefore = Get-TreeHashes $userData

      # The real upgrade path: no folder given, the installer must find the existing installation.
      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser')) $ExitInstalled "The $version installer"
      $new = Get-SingleEntry
      if ($new.Key -ne $old.Key) { throw "The uninstall entry changed from $($old.Key) to $($new.Key)" }
      if ($new.Location -ne $old.Location) { throw "Installed into $($new.Location) instead of upgrading $($old.Location) in place" }
      if ($new.DisplayVersion -ne $version) { throw "DisplayVersion is $($new.DisplayVersion), expected $version" }
      Assert-ExeVersion (Join-Path $new.Location 'Pevqori.exe') $version
      Assert-SameTree $dataBefore (Get-TreeHashes $dataDir) 'Data folder'
      Assert-SameTree $settingsBefore (Get-TreeHashes $userData) 'Settings folder'
      if (-not (Test-Path $appDataSentinel)) { throw "$appDataSettings was deleted by the upgrade" }
      Invoke-SmokeRun (Join-Path $new.Location 'Pevqori.exe') $version

      if ((Get-CoreVersion $previousVersion) -ge [version]'2.0.0') {
        Assert-ExitCode (Invoke-Installer $previousPath @('/S', '/currentuser')) $ExitDowngrade "Installing $previousVersion over $version"
        $after = Get-SingleEntry
        if ($after.DisplayVersion -ne $version) { throw "The refused downgrade changed DisplayVersion to $($after.DisplayVersion)" }
      } else {
        Write-Host "::notice::Downgrade step skipped: $previousVersion predates the installer's downgrade guard (2.0.0)."
      }
    }

    'RunningApp' {
      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser', "/D=$installDir")) $ExitInstalled 'The installer'
      $script:installed = $true
      Invoke-SmokeRun (Join-Path $installDir 'Pevqori.exe') $version
      $sentinel = Join-Path $installDir 'smoke-sentinel.txt'
      Set-Content -Path $sentinel -Value $runId

      Set-AppEnvironment $false
      $running = Start-Process -FilePath (Join-Path $installDir 'Pevqori.exe') -PassThru
      $null = $running.Handle
      for ($i = 0; $i -lt 60; $i++) {
        $running.Refresh()
        if ($running.HasExited) { throw "Pevqori exited by itself (code $($running.ExitCode))" }
        if ($running.MainWindowHandle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Seconds 1
      }
      Start-Sleep -Seconds 3
      Write-Step "Pevqori is running (pid $($running.Id))"
      $dataBefore = Get-TreeHashes $dataDir

      $started = Get-Date
      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser')) $ExitAppRunning 'Installing while Pevqori runs'
      $waited = ((Get-Date) - $started).TotalSeconds
      if ($waited -lt $AppRunningWaitSeconds - 2) { throw "The installer gave up after $([int]$waited) s; it should wait about $AppRunningWaitSeconds s for Pevqori to close" }
      $running.Refresh()
      if ($running.HasExited) { throw 'Pevqori was closed by the installer' }
      if (-not (Test-Path $sentinel)) { throw 'The refused install changed the program folder' }
      if ((Get-SingleEntry).DisplayVersion -ne $version) { throw 'The refused install changed the uninstall entry' }
      Assert-SameTree $dataBefore (Get-TreeHashes $dataDir) 'Data folder'
      Write-Step "Refused after $([int]$waited) s with exit code $ExitAppRunning; Pevqori still running"

      Write-Step 'Closing Pevqori through its window (normal quit)'
      $null = $running.CloseMainWindow()
      if (-not $running.WaitForExit(60000)) { throw 'Pevqori did not quit within 60 s of closing its window' }
      for ($i = 0; $i -lt 30 -and @(Get-PevqoriProcesses $installDir).Count -gt 0; $i++) { Start-Sleep -Seconds 1 }
      $running = $null
      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser')) $ExitInstalled 'Installing after Pevqori was closed'
      if ((Get-SingleEntry).Location -ne $installDir) { throw 'The retried install did not reuse the program folder' }
    }

    'Downgrade' {
      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser', "/D=$installDir")) $ExitInstalled 'The installer'
      $script:installed = $true
      $entry = Get-SingleEntry
      $sentinel = Join-Path $installDir 'smoke-sentinel.txt'
      Set-Content -Path $sentinel -Value $runId
      # Pretend a newer version is installed.
      Set-ItemProperty -Path $entry.Path -Name 'DisplayVersion' -Value '999.0.0'

      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser')) $ExitDowngrade "Installing $version over 999.0.0"
      if ((Get-SingleEntry).DisplayVersion -ne '999.0.0') { throw 'The refused downgrade changed the uninstall entry' }
      if (-not (Test-Path $sentinel)) { throw 'The refused downgrade changed the program folder' }
      Write-Step "Downgrade refused with exit code $ExitDowngrade"

      Assert-ExitCode (Invoke-Installer $installerPath @('/S', '/currentuser', '/ALLOWDOWNGRADE')) $ExitInstalled 'Installing with /ALLOWDOWNGRADE'
      $after = Get-SingleEntry
      if ($after.DisplayVersion -ne $version) { throw "DisplayVersion is $($after.DisplayVersion) after /ALLOWDOWNGRADE, expected $version" }
      if ($after.Location -ne $installDir) { throw 'The /ALLOWDOWNGRADE install did not reuse the program folder' }
      Write-Step '/ALLOWDOWNGRADE installed over it'
    }
  }

  if ($script:installed) {
    $loc = (Get-SingleEntry).Location
    $script:location = $loc
    $null = Invoke-Uninstall $loc
    $script:installed = $false
    Assert-UninstalledKeepsData
  }
  Write-Host "[$Scenario] Passed"
}
catch {
  Save-Evidence
  throw
}
finally {
  # Test-harness clean-up only (the installer itself never closes Pevqori).
  if ($null -ne $running -and -not $running.HasExited) { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue }
  if ($script:installed) {
    Get-PevqoriProcesses $script:location | Stop-Process -Force -ErrorAction SilentlyContinue
    try { $null = Invoke-Uninstall $script:location } catch { Write-Warning "Clean-up uninstall failed: $_" }
  }
  Remove-Item -Path $appDataSentinel -Force -ErrorAction SilentlyContinue
  if (-not $appDataExisted -and (Test-Path $appDataSettings) -and -not (Get-ChildItem -Path $appDataSettings -Force)) {
    Remove-Item -Path $appDataSettings -Force -ErrorAction SilentlyContinue
  }
}
