@echo off
REM TSX Trading Bot V4 - Start Control Panel

echo Starting TSX Trading Bot V4 Control Panel...
echo.

REM Navigate to control panel directory
cd /d "%~dp0..\..\control-panel"

REM Install dependencies if needed
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting Control Panel on http://localhost:8080
echo.

REM Start the control panel
node server.js

pause