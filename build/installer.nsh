; 自定义安装页面：让用户自己决定要不要桌面快捷方式（默认不勾选）。
; 由 package.json 的 build.nsis.include 引入，配合 nsis.createDesktopShortcut=false 使用：
; 关掉默认创建后，只有用户在这一页勾了，才由 customInstall 建快捷方式。
;
; 注意：electron-builder 会把脚本编译两遍（安装包 / 卸载包，靠 BUILD_UNINSTALLER 区分）。
; 下面这些只用于「安装」流程，因此整体包在 !ifndef BUILD_UNINSTALLER 里，
; 否则卸载包那一遍会因函数未被引用而触发 warning 6010，被 /WX 当成错误导致构建失败。

!ifndef NSISDL_NSH
  !include nsDialogs.nsh
!endif

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL DesktopShortcutCheckbox
  Var /GLOBAL DesktopShortcutState

  ; 展开在「选择安装目录之后、开始安装之前」这一页位置
  !macro customPageAfterChangeDir
    Page custom DesktopShortcutPage DesktopShortcutPageLeave
  !macroend

  Function DesktopShortcutPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "接下来开始安装。需要的附加项请勾选（不勾选不影响使用，开始菜单里仍然有本程序）："
    Pop $1

    ${NSD_CreateCheckbox} 0 30u 100% 12u "在桌面创建快捷方式"
    Pop $DesktopShortcutCheckbox
    ${NSD_SetState} $DesktopShortcutCheckbox 0    ; 默认不勾选

    nsDialogs::Show
  FunctionEnd

  Function DesktopShortcutPageLeave
    ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutState
  FunctionEnd

  !macro customInstall
    ${If} $DesktopShortcutState == 1
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
  !macroend
!endif
