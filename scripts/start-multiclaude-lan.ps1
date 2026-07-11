# Starts multiclaude reachable from OTHER machines on your LAN.
#
# SECURITY: this exposes a real shell on this PC to anyone who can reach the
# port. Only run it on a network you trust. It listens on all interfaces
# (0.0.0.0) and only accepts browser requests aimed at this machine's own
# IPs/hostname (cross-origin sites and DNS-rebinding are still refused).

$root = Split-Path $PSScriptRoot -Parent
$port = 3001

if (-not (Test-Path "$root\dist\server\index.js") -or -not (Test-Path "$root\web\dist\index.html")) {
    Write-Host "Building multiclaude first..."
    Push-Location $root
    npm run build
    Pop-Location
}

# One-time (needs an elevated shell): open the port. Uses -Profile Any so it
# works whether Windows has labelled your network Private or Public.
$rule = Get-NetFirewallRule -DisplayName "multiclaude LAN" -ErrorAction SilentlyContinue
if (-not $rule) {
    Write-Host "Tip: to let LAN machines connect, run this ONCE in an ADMIN PowerShell:"
    Write-Host "  New-NetFirewallRule -DisplayName 'multiclaude LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any" -ForegroundColor Yellow
}

$env:MULTICLAUDE_HOST = "0.0.0.0"
$env:MULTICLAUDE_UNSAFE_HOST = "1"

Write-Host "Your LAN addresses:" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):$port" }

Push-Location $root
node dist\server\index.js
Pop-Location
