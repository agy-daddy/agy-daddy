Option Explicit

Dim fso, shell, dir, powerShell, command, status
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powerShell & """ -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\install-and-launch.ps1"" -Quiet"
status = shell.Run(command, 0, True)
If status <> 0 Then
    MsgBox "Open Agy-Daddy-Launcher.cmd to see startup output, or check " _
        & shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AgyDaddy\logs\wrapper.log.", _
        vbCritical, "Agy-Daddy Launcher could not start"
End If
WScript.Quit status
