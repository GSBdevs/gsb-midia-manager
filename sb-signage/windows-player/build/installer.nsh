; Início automático: atalho na pasta Inicializar do usuário (visível em "Aplicativos de
; inicialização" do Windows). O vigia (tarefa agendada) é criado pelo próprio app ao abrir.
!macro customInstall
  CreateShortCut "$SMSTARTUP\SB Signage Player.lnk" "$INSTDIR\SB Signage Player.exe"
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\SB Signage Player.lnk"
  nsExec::Exec 'schtasks.exe /Delete /F /TN "SB Signage Player (vigia)"'
!macroend
