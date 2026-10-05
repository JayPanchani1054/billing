; Bahi ERP — NSIS customisations, included by electron-builder (electron-builder.yml → nsis.include).
; Keep this file minimal: electron-builder treats NSIS warnings as errors.

; Uninstall never deletes company data or settings (nsis.deleteAppDataOnUninstall: false).
; Say so in the uninstaller log so administrators are not surprised.
!macro customUnInstall
  DetailPrint "Bahi ERP program files removed."
  DetailPrint "Company data in your Bahi ERP data folder and settings in %APPDATA%\Bahi ERP were kept."
!macroend
