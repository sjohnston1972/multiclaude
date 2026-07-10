# Starts the multiclaude server (production build) hidden and opens the browser.
# Safe to run when it's already up - it just opens the browser.

$root = Split-Path $PSScriptRoot -Parent
$url = "http://127.0.0.1:3001"
$health = "$url/api/health"

function Test-Up {
    try {
        Invoke-RestMethod $health -TimeoutSec 1 | Out-Null
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Up)) {
    if (-not (Test-Path "$root\dist\server\index.js") -or -not (Test-Path "$root\web\dist\index.html")) {
        Write-Host "First run: building multiclaude (takes ~30s)..."
        Push-Location $root
        npm run build
        Pop-Location
    }
    Write-Host "Starting multiclaude server..."
    Start-Process -FilePath "node" -ArgumentList "dist\server\index.js" `
        -WorkingDirectory $root -WindowStyle Hidden

    # Wait up to 10s for it to come up
    for ($i = 0; $i -lt 40; $i++) {
        if (Test-Up) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Up)) {
        Write-Host "multiclaude didn't start - run 'npm start' in $root to see the error." -ForegroundColor Red
        exit 1
    }
}

Start-Process $url
