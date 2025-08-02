@echo off
REM TSX Trading Bot V5 - Run Connection Manager
REM This runs the Connection Manager from the V5 folder

echo Starting TSX Trading Bot Connection Manager V5...
cd /d "%~dp0..\..\connection-manager"

REM Check if node_modules exists
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo.
echo ========================================
echo Starting Connection Manager on port 7500
echo ========================================
echo.

REM Run the connection manager
node index.js

pause