@echo off
REM TSX Trading Bot V5 - Start Control Panel

echo Starting TSX Trading Bot V5 Control Panel...
echo.

REM Navigate to V5 root directory
cd /d "%~dp0..\.."

REM Install dependencies if needed
if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting Control Panel on http://localhost:8080
echo.

REM Start the control panel from src/ui/control-panel
node src\ui\control-panel\server.js

pause