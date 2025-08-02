@echo off
REM TSX Trading Bot V5 - Start Configuration UI

echo Starting Configuration UI...
cd /d "%~dp0..\..\src\ui\config"

REM Install dependencies if needed
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Start the configuration UI server
echo Starting Configuration UI on http://localhost:3000
node config-server.js