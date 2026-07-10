# Stops the multiclaude server. WARNING: this kills every terminal session it holds.

$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $procId = ($conn | Select-Object -First 1).OwningProcess
    Write-Host "Stopping multiclaude (PID $procId) and all its terminal sessions..."
    Stop-Process -Id $procId -Force
    Write-Host "Stopped."
} else {
    Write-Host "multiclaude isn't running."
}
