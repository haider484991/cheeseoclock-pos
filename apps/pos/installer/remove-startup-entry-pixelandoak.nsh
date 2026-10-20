; Pixel & Oak POS's start-up entry (electron-builder.pixelandoak.yml): the
; same as installer/remove-startup-entry.nsh, under this edition's app id,
; com.pixelandoak.pos (shared-types edition.ts). The till writes the HKCU Run
; value under that name (electron/services/till-power-hub.ts), and Task
; Manager keeps its on/off next to it under StartupApproved\Run.
;
; Uninstalling takes both away; an auto-update runs the old uninstaller too,
; and ${isUpdated} keeps the entry then. Cheese O'Clock's entry is never
; touched from here.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.pixelandoak.pos"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.pixelandoak.pos"
  ${endIf}
!macroend
