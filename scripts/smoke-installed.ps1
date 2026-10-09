# Packaged-app smoke test (CI: .github/workflows/ci.yml › windows-smoke, release.yml › smoke).
#
#   1. installs the NSIS installer silently, per user, into a throw-away folder;
#   2. checks the core worker was shipped outside app.asar (resources\app.asar.unpacked);
#   3. starts the INSTALLED Bahi ERP.exe (fuses on, so Playwright cannot attach) with throw-away
#      profile/data folders and BAHI_SMOKE_TEST=1: the app loads its window, calls app.state through
#      the real preload → IPC → core worker → node:sqlite path, logs "Smoke test passed|failed" and
#      quits with exit code 0/1 through the normal quit sequence (src/main/smoke.ts);
#   4. fails unless the app exited 0 in time and its log says the smoke test passed;
#   5. uninstalls silently.
#
#   pwsh ./scripts/smoke-installed.ps1 -Installer release\Bahi-ERP-Setup-0.1.0.exe [-Evidence dir]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$TimeoutSeconds = 120,
  # Folder that receives the app log (uploaded by CI when the job fails).
  [string]$Evidence = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$root = Join-Path $base ("bahi-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$installDir = Join-Path $root 'app'
$userData = Join-Path $root 'user-data'
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $root | Out-Null

function Save-Evidence {
  if (-not $Evidence) { return }
  New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
  $logs = Join-Path $userData 'logs'
  if (Test-Path $logs) { Copy-Item -Path (Join-Path $logs '*') -Destination $Evidence -Force }
}

try {
  $installerPath = (Resolve-Path $Installer).Path
  Write-Host "Installing $installerPath silently into $installDir"
  # NSIS: /S silent, /currentuser per-user install, /D= target folder (must be last, unquoted).
  $setup = Start-Process -FilePath $installerPath -ArgumentList '/S', '/currentuser', "/D=$installDir" -Wait -PassThru
  if ($setup.ExitCode -ne 0) { throw "The installer exited with code $($setup.ExitCode)" }

  $exe = Join-Path $installDir 'Bahi ERP.exe'
  if (-not (Test-Path $exe)) { throw "The installed app was not found at $exe" }
  $worker = Join-Path $installDir 'resources\app.asar.unpacked\out\main\core-worker.cjs'
  if (-not (Test-Path $worker)) { throw "The core worker was not shipped unpacked ($worker missing)" }

  $env:BAHI_USER_DATA = $userData
  $env:BAHI_DATA_DIR = $dataDir
  $env:BAHI_SMOKE_TEST = '1'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

  Write-Host "Starting $exe (smoke mode)"
  $app = Start-Process -FilePath $exe -PassThru
  $null = $app.Handle # keep the handle so ExitCode is available after exit
  if (-not $app.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
    throw "Bahi ERP did not finish the smoke test and quit within $TimeoutSeconds s"
  }
  $code = $app.ExitCode

  $log = Join-Path $userData 'logs\bahi.log'
  if (-not (Test-Path $log)) { throw "No log file was written ($log)" }
  Write-Host '--- bahi.log ---'
  Get-Content $log | Write-Host
  Write-Host '----------------'

  if (Select-String -Path $log -SimpleMatch 'Core runtime failed to start' -Quiet) { throw 'The core runtime failed to start' }
  if (-not (Select-String -Path $log -SimpleMatch 'Smoke test passed' -Quiet)) { throw 'The log does not report "Smoke test passed"' }
  if ($code -ne 0) { throw "Bahi ERP exited with code $code" }
  Write-Host "Smoke test passed (exit code $code)"
}
catch {
  Save-Evidence
  throw
}
finally {
  $uninstaller = Join-Path $installDir 'Uninstall Bahi ERP.exe'
  if (Test-Path $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList '/S', '/currentuser' -Wait | Out-Null
  }
}
