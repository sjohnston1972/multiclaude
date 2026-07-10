# Removes the login autostart installed by install-startup.ps1.

$launcher = Join-Path ([Environment]::GetFolderPath("Startup")) "multiclaude.vbs"
if (Test-Path $launcher) {
    Remove-Item $launcher -Confirm:$false
    Write-Host "Removed: $launcher"
    Write-Host "multiclaude will no longer start at login (any running server is untouched)."
} else {
    Write-Host "Autostart wasn't installed."
}
