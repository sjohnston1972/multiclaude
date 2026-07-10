# Makes multiclaude start automatically (and invisibly) when you log in to
# Windows, by dropping a small launcher into your Startup folder.
# Undo with uninstall-startup.ps1, or just delete the file it mentions.

$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "multiclaude.vbs"

if (-not (Test-Path "$root\dist\server\index.js") -or -not (Test-Path "$root\web\dist\index.html")) {
    Write-Host "Building multiclaude first (one-time)..."
    Push-Location $root
    npm run build
    Pop-Location
}

# A .vbs launcher is the one Windows-native way to start a console app at
# login with NO window at all (window style 0).
@"
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$root"
shell.Run """$node"" dist\server\index.js", 0, False
"@ | Out-File -FilePath $launcher -Encoding ascii

Write-Host "Installed: $launcher"
Write-Host "multiclaude will now start hidden every time you log in."
Write-Host "Open http://127.0.0.1:3001 in your browser to use it."
Write-Host "To remove: run scripts\uninstall-startup.ps1 (or delete that file)."
