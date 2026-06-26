param(
    [switch]$NoLavalink
)

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lavalinkDir = Join-Path $rootDir "lavalink"

function Start-Lavalink {
    $lavalinkJar = Join-Path $lavalinkDir "Lavalink.jar"
    if (-not (Test-Path $lavalinkJar)) {
        Write-Host "[ERROR] Lavalink.jar not found at: $lavalinkJar" -ForegroundColor Red
        return $null
    }

    Write-Host "[LAVALINK] Starting Lavalink server..." -ForegroundColor Cyan
    $process = Start-Process -FilePath "java" -ArgumentList "-jar", "Lavalink.jar" -WorkingDirectory $lavalinkDir -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $lavalinkDir "stdout.log") -RedirectStandardError (Join-Path $lavalinkDir "stderr.log")
    
    # Wait for Lavalink to be ready (check port 2333)
    $timeout = 30
    $elapsed = 0
    $ready = $false
    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds 1
        $elapsed++
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:2333/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            # not ready yet
        }
        Write-Host "  Waiting for Lavalink... ($elapsed/$timeout s)" -ForegroundColor Gray
    }

    if ($ready) {
        Write-Host "[LAVALINK] Lavalink is ready!" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Lavalink may not be ready yet. Check logs if the bot fails to connect." -ForegroundColor Yellow
    }

    return $process
}

function Start-Bot {
    Write-Host "[BOT] Starting Discord bot..." -ForegroundColor Cyan
    Set-Location $rootDir
    & "pnpm" start
}

# ── Main ──

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  FullMoon Bot + Lavalink Launcher" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""

if (-not $NoLavalink) {
    $lavalinkProcess = Start-Lavalink
    if ($null -eq $lavalinkProcess) {
        Write-Host "[ERROR] Failed to start Lavalink. Aborting." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[SKIP] Lavalink start skipped (--NoLavalink)" -ForegroundColor Yellow
}

Start-Bot

# When bot exits, also stop Lavalink
if ($null -ne $lavalinkProcess -and -not $lavalinkProcess.HasExited) {
    Write-Host "[LAVALINK] Stopping Lavalink..." -ForegroundColor Cyan
    $lavalinkProcess.Kill()
}
