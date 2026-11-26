Unicode true
!include "MUI2.nsh"
!include "x64.nsh"

Name "${DISPLAY_NAME}"
OutFile "${SETUP_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${DISPLAY_NAME}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor zlib
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey "ProductName" "${DISPLAY_NAME}"
VIAddVersionKey "FileDescription" "Dsh Windows Setup"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Dsh"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装程序需要 64 位 Windows。"
    Abort
  ${EndIf}
  SetShellVarContext current
FunctionEnd

Function CheckTarget
  IfFileExists "$INSTDIR\*.*" 0 allowed
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $0 "$INSTDIR" 0 invalid
  IfFileExists "$INSTDIR\Uninstall.exe" allowed invalid
  invalid:
    MessageBox MB_ICONSTOP "请选择空目录，或使用已有的 Dsh 安装目录。" /SD IDOK
    SetErrorLevel 2
    Abort
  allowed:
FunctionEnd

Section "Dsh"
  Call CheckTarget
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\${DISPLAY_NAME}"
  CreateShortcut "$SMPROGRAMS\${DISPLAY_NAME}\${DISPLAY_NAME}.lnk" "$INSTDIR\Dsh文献翻译.exe"
  CreateShortcut "$SMPROGRAMS\${DISPLAY_NAME}\卸载.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Dsh"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Dsh文献翻译.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\${DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\卸载.lnk"
  RMDir "$SMPROGRAMS\${DISPLAY_NAME}"
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
