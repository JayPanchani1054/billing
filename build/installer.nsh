; Pevqori — NSIS customisations, included by electron-builder (electron-builder.yml → nsis.include).
; Keep this file minimal: electron-builder treats NSIS warnings as errors.

; Uninstall never deletes company data or settings (nsis.deleteAppDataOnUninstall: false).
; Say so in the uninstaller log so administrators are not surprised.
!macro customUnInstall
  DetailPrint "Pevqori program files removed."
  DetailPrint "Company data in your Pevqori data folder and settings in %APPDATA%\Pevqori were kept."
!macroend
