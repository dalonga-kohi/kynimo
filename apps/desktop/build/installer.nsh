; Wording for the private beta installer (electron-builder includes this file). The wizard
; installs per user only: the "for all users or only me" page is skipped, so there is no UAC prompt.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Install Kynimo (private beta)"
  !define MUI_WELCOMEPAGE_TEXT "Kynimo runs on this computer: no account, no cloud. Your projects stay in %LOCALAPPDATA%\Kynimo. Connect Claude, Codex or Cursor once it opens."
  !define MUI_FINISHPAGE_TITLE "Kynimo is installed."
  !define MUI_FINISHPAGE_RUN_TEXT "Run Kynimo"
  !insertmacro MUI_PAGE_WELCOME
!macroend
