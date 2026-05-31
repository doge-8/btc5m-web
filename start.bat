@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
  echo [Error] .env not found. Please copy .env.example and fill in your config:
  echo   copy .env.example .env
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  npm install
  if errorlevel 1 (
    echo [Error] npm install failed.
    pause
    exit /b 1
  )
)

set "APP_MODE=full"
for /f "tokens=1,* delims==" %%A in (.env) do (
  if /I "%%A"=="APP_MODE" set "APP_MODE=%%B"
)

echo Starting BTC 5m monitor...
echo Mode: %APP_MODE%
echo Port 3456 in use will auto-fallback to 3457-3465 (see startup log)
echo Press Ctrl+C to stop.
echo.

REM Probe actual listening port and open browser
if /I not "%APP_MODE%"=="headless" (
  start "" /b cmd /c "for /l %%i in (1,1,10) do (timeout /t 1 /nobreak >nul & for %%P in (3456 3457 3458 3459 3460 3461 3462 3463 3464 3465) do (curl -sf -m 1 http://localhost:%%P/api/state >nul 2>&1 && (start """" http://localhost:%%P & exit /b 0)))"
)

npx --yes tsx server.ts
