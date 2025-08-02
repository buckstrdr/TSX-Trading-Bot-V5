@echo off
REM TSX Trading Bot V5 - Run Manual Trading Service
REM This runs the Manual Trading service from the V5 folder

echo Starting TSX Trading Bot Manual Trading V5...
cd /d "%~dp0..\..\manual-trading"

REM Check if node_modules exists
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo.
echo ==========================================
echo Starting Manual Trading Server on port 3003
echo ==========================================
echo.

REM Run the manual trading server
node server.js

pause