; Included into the Windows installer by scripts/build-desktop-artifact.ts.
;
; Thread links (apps/desktop/src/app/DesktopThreadLinks.ts): the app claims its
; link scheme for the user at every start, as HKCU\Software\Classes\<scheme>.
; Uninstalling takes that claim back, but only one that still starts this
; install's exe; a scheme another install claims stays theirs. An update runs
; this uninstaller too, and keeps the claim for the version replacing it.
; One line per scheme in APP_THREAD_LINK_SCHEMES (@threadlines/shared/appThreadLinks).

!macro threadlinesRemoveLinkScheme SCHEME
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\${SCHEME}\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\${SCHEME}"
  ${EndIf}
  Pop $0
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    !insertmacro threadlinesRemoveLinkScheme "threadlines"
    !insertmacro threadlinesRemoveLinkScheme "threadlines-nightly"
    !insertmacro threadlinesRemoveLinkScheme "threadlines-dev"
  ${EndIf}
!macroend
