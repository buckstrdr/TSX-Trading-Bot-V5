@echo off
REM TSX Trading Bot V4 - Run Connection Manager
REM This runs the Connection Manager from the V4 folder

echo Starting TSX Trading Bot Connection Manager V4...
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