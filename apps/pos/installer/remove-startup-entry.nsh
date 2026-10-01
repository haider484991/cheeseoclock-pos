; The till's start-up entry in Windows ("Start the till with Windows",
; Settings -> Online orders -> This computer; electron/services/till-power-hub.ts).
; The till writes it as the HKCU Run value named after the app's id,
; pk.cheeseoclock.pos, and Task Manager keeps its on/off next to it under
; StartupApproved\Run.
;
; Uninstalling takes both away, so Task Manager does not list a till that is
; gone. An auto-update runs the old uninstaller too: ${isUpdated} keeps the
; entry then, or every update would switch "Start with Windows" off.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "pk.cheeseoclock.pos"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "pk.cheeseoclock.pos"
  ${endIf}
!macroend
