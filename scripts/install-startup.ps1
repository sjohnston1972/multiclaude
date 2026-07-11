# Makes multiclaude start automatically (and invisibly) when you log in to
# Windows, by dropping a small launcher into your Startup folder.
# Undo with uninstall-startup.ps1, or just delete the file it mentions.
#
#   .\scripts\install-startup.ps1        # loopback only (safe default)
#   .\scripts\install-startup.ps1 -Lan   # reachable from your LAN (see warning)

param([switch]$Lan)

$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "multiclaude.vbs"
$port = 3001

if (-not (Test-Path "$root\dist\server\index.js") -or -not (Test-Path "$root\web\dist\index.html")) {
    Write-Host "Building multiclaude first (one-time)..."
    Push-Location $root
    npm run build
    Pop-Location
}

# A .vbs launcher is the one Windows-native way to start a console app at
# login with NO window at all (window style 0). In LAN mode it sets the two
# env vars first, which the child node process inherits.
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('Set shell = CreateObject("WScript.Shell")')
if ($Lan) {
    $lines.Add('Set env = shell.Environment("Process")')
    $lines.Add('env("MULTICLAUDE_HOST") = "0.0.0.0"')
    $lines.Add('env("MULTICLAUDE_UNSAFE_HOST") = "1"')
}
$lines.Add('shell.CurrentDirectory = "' + $root + '"')
$lines.Add('shell.Run """' + $node + '"" dist\server\index.js", 0, False')
$lines -join "`r`n" | Out-File -FilePath $launcher -Encoding ascii

Write-Host "Installed: $launcher"
if ($Lan) {
    Write-Host ""
    Write-Host "multiclaude will start hidden at login, reachable from your LAN." -ForegroundColor Cyan
    Write-Host "WARNING: this exposes a real shell on this PC to anyone who can reach" -ForegroundColor Yellow
    Write-Host "the port on your network. Only do this on a network you trust." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Your LAN URLs:"
    Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        ForEach-Object { Write-Host ("  http://" + $_.IPAddress + ":" + $port) }
    $fw = Get-NetFirewallRule -DisplayName "multiclaude LAN" -ErrorAction SilentlyContinue
    if (-not $fw) {
        Write-Host ""
        Write-Host "One more step - run this ONCE in an ADMIN PowerShell to open the firewall:" -ForegroundColor Yellow
        Write-Host ("  New-NetFirewallRule -DisplayName 'multiclaude LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort " + $port + " -Profile Any") -ForegroundColor Yellow
    } else {
        Write-Host "Firewall rule 'multiclaude LAN' is already present."
    }
} else {
    Write-Host "multiclaude will start hidden every time you log in (loopback only)."
    Write-Host ("Open http://127.0.0.1:" + $port + " in your browser to use it.")
}
Write-Host "To remove: run scripts\uninstall-startup.ps1 (or delete that file)."
