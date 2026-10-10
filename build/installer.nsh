; Pevqori — NSIS customisations, included by electron-builder (electron-builder.yml → nsis.include).
; electron-builder compiles with warnings as errors: declare nothing that a pass might not use (no Var,
; no Function), keep to registers, LogicLib and the header functions below (all "artificial" functions
; in NSIS 3, so they work in the installer and the uninstaller without declarations).
;
; Exit codes of a silent install (/S), checked by scripts/smoke-installed.ps1:
;   0  installed
;   3  Pevqori is still running after 30 s; nothing was changed and Pevqori was NOT closed
;   4  a newer Pevqori is installed (downgrade refused); pass /ALLOWDOWNGRADE to install anyway
; Docs: docs/INSTALL.md (upgrading, downgrading, administrators), docs/BUILD.md (release checklist).

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

; ─────────────────────────── running app (never force-closed) ───────────────────────────
; A copy of Pevqori.exe running under this Windows account keeps its files locked, and closing it for the
; user could lose unsaved work. Interactive: ask the user to close it (Retry / Cancel). Silent (the in-app
; updater's installer run, administrators' scripts): wait up to 30 s for it to exit — the updater starts
; the installer while Pevqori finishes quitting — then give up with exit code 3. Pevqori is never killed.

!macro _pevqoriAppRunning _RESULT
  ; ${_RESULT} = 0 when Pevqori.exe is running (find.exe found it), non-zero otherwise. A per-user
  ; installation runs only under this Windows account, so only this account's processes count. A
  ; per-machine one ($installMode "all", set by electron-builder from the registry before this runs) is
  ; shared by every account, so a copy open in another user's session (which also locks its files) counts.
  ; APP_EXECUTABLE_FILENAME (Pevqori.exe) comes from electron-builder's common.nsh.
  ${If} $installMode == "all"
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  ${Else}
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  ${EndIf}
  Pop ${_RESULT}
!macroend

!macro _pevqoriWaitForApp
  Push $R0
  Push $R1
  !insertmacro _pevqoriAppRunning $R0
  ${If} $R0 == 0
    ${If} ${Silent}
      StrCpy $R1 0
      ${DoWhile} $R0 == 0
        ${If} $R1 >= 30
          DetailPrint "Pevqori is still running; the installation was stopped and nothing was changed."
          SetErrorLevel 3
          Quit
        ${EndIf}
        Sleep 1000
        IntOp $R1 $R1 + 1
        !insertmacro _pevqoriAppRunning $R0
      ${Loop}
    ${Else}
      ${DoWhile} $R0 == 0
        ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Pevqori is open. Save your work and close it, then click Retry." /SD IDCANCEL IDCANCEL`
          SetErrorLevel 3
          Quit
        ${EndIf}
        !insertmacro _pevqoriAppRunning $R0
      ${Loop}
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

; electron-builder's own check (invoked before files are replaced, also in the uninstaller) closes the
; app, forcibly if needed; this macro replaces it with the wait-or-ask logic above.
!macro customCheckAppRunning
  !insertmacro _pevqoriWaitForApp
!macroend

; ─────────────────────────── start-up checks (installer only) ───────────────────────────

!macro customInit
  ; The elevated inner instance of an "Anyone who uses this computer" install runs .onInit again; the
  ; outer instance has already asked, so do not ask twice.
  !ifdef UAC_IsInnerInstance
  ${IfNot} ${UAC_IsInnerInstance}
  !endif
    !insertmacro _pevqoriDowngradeGuard
    ; Checked here too, before any page is shown, so the user is told at once (and the result does not
    ; depend on where electron-builder's template calls customCheckAppRunning).
    !insertmacro _pevqoriWaitForApp
  !ifdef UAC_IsInnerInstance
  ${EndIf}
  !endif
!macroend

; Downgrade guard. A company opened by a newer Pevqori cannot be opened by an older one (the app refuses
; it rather than damage it), so installing an older version over a newer one is refused unless the user
; confirms (interactive) or the administrator passes /ALLOWDOWNGRADE (silent; exit code 4 otherwise).
; Versions are compared without their pre-release suffix (2.1.0-beta.1 counts as 2.1.0).
!macro _pevqoriStripPre _IN _OUT
  ; ${_OUT} = ${_IN} up to the first "-" or "+".
  Push $R8
  Push $R9
  StrCpy ${_OUT} ""
  StrCpy $R9 0
  ${Do}
    StrCpy $R8 ${_IN} 1 $R9
    ${If} $R8 == ""
    ${OrIf} $R8 == "-"
    ${OrIf} $R8 == "+"
      ${Break}
    ${EndIf}
    StrCpy ${_OUT} "${_OUT}$R8"
    IntOp $R9 $R9 + 1
  ${Loop}
  Pop $R9
  Pop $R8
!macroend

!macro _pevqoriDowngradeGuard
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  ClearErrors
  ; The uninstall key electron-builder writes (its GUID is derived from appId): per-user installs in HKCU,
  ; per-machine installs in HKLM.
  !ifdef UNINSTALL_REGISTRY_KEY
    ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${If} $R0 == ""
      ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ${EndIf}
  !else
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
    ${If} $R0 == ""
      ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
    ${EndIf}
  !endif
  ${If} $R0 != ""
    ${GetParameters} $R1
    ClearErrors
    ${GetOptions} $R1 "/ALLOWDOWNGRADE" $R2
    ${If} ${Errors}
      !insertmacro _pevqoriStripPre $R0 $R2
      !insertmacro _pevqoriStripPre "${VERSION}" $R3
      ${VersionCompare} $R2 $R3 $R1
      ${If} $R1 == 1
        ${IfNot} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION "A newer Pevqori ($R0) is installed. Installing ${VERSION} is not supported: a company opened by the newer version cannot be opened by this one. Continue anyway?" /SD IDNO IDYES`
          SetErrorLevel 4
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ClearErrors
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; ─────────────────────────── uninstall ───────────────────────────

; Uninstall never deletes company data or settings (nsis.deleteAppDataOnUninstall: false).
; Say so in the uninstaller log so administrators are not surprised.
!macro customUnInstall
  DetailPrint "Pevqori program files removed."
  DetailPrint "Company data in your Pevqori data folder and settings in %APPDATA%\Pevqori were kept."
!macroend
