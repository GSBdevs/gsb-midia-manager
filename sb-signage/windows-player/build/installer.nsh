; Início automático: atalho na pasta Inicializar do usuário (visível em "Aplicativos de
; inicialização" do Windows). O vigia (tarefa agendada) é criado pelo próprio app ao abrir.
!macro customInstall
  Delete "$SMSTARTUP\SB Signage Player.lnk"
  CreateShortCut "$SMSTARTUP\SB Mídias.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\SB Mídias.lnk"
  Delete "$SMSTARTUP\SB Signage Player.lnk"
  nsExec::Exec 'schtasks.exe /Delete /F /TN "SB Mídias (vigia)"'
  nsExec::Exec 'schtasks.exe /Delete /F /TN "SB Signage Player (vigia)"'
!macroend
