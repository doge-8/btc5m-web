# Polymarket VPS SSH tunnel (PowerShell version, auto-reconnect)
#
# Usage:
#   Right-click the .ps1 → Run with PowerShell  (foreground mode, closing the window = closing the tunnel)
#   Or run in PowerShell: .\tunnel-arl-large.ps1
#
# The first run may be blocked by the execution policy; open PowerShell as administrator and run once:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# ── Config (matches the .sh version) ─────────────────────────────
$PEM   = "$env:USERPROFILE\Desktop\arl.pem"
$HOST_ = "ubuntu@3.255.100.208"
$PORTS = @(3456, 3457, 3458)

# ── Internal ────────────────────────────────────────────────

# Assemble port-forwarding arguments
$portArgs = @()
foreach ($p in $PORTS) {
    $portArgs += "-L"
    $portArgs += "${p}:localhost:${p}"
}

# pem file check
if (-not (Test-Path $PEM)) {
    Write-Host "❌ pem file does not exist: $PEM" -ForegroundColor Red
    exit 1
}

# Windows OpenSSH requires correct pem file permissions (owner-only);
# if permissions were not set before, ssh reports "WARNING: UNPROTECTED PRIVATE KEY FILE" and refuses to connect
# Auto chmod is skipped here (icacls on Windows is too complex); if you hit an error, please:
#   1. Right-click the pem file → Properties → Security → Advanced
#   2. Disable inheritance → remove other users → keep only yourself
#   3. For a detailed guide, search "windows ssh permissions are too open"

Write-Host "✓ Starting tunnel (foreground mode, Ctrl+C to exit)"
Write-Host "  HOST: $HOST_"
Write-Host "  Ports: $($PORTS -join ' ')"
Write-Host ""

# Reconnect loop: ssh exits → wait 3 seconds → reconnect
$attempt = 0
while ($true) {
    $attempt++
    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Attempting connection (count $attempt)..." -ForegroundColor Cyan
    & ssh -N `
        -i $PEM `
        @portArgs `
        $HOST_ `
        -o "ServerAliveInterval=30" `
        -o "ServerAliveCountMax=3" `
        -o "ExitOnForwardFailure=yes" `
        -o "TCPKeepAlive=yes" `
        -o "StrictHostKeyChecking=no" `
        -o "UserKnownHostsFile=NUL"

    $exitCode = $LASTEXITCODE
    Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] Tunnel disconnected (exit=$exitCode), reconnecting in 3 seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}
