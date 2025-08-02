@echo off
REM TSX Trading Bot V4 - Start Manual Trading Server

echo Starting Manual Trading Server V2...
cd /d "%~dp0..\..\manual-trading-v2"

REM Start the manual trading server
echo Starting Manual Trading on http://localhost:3003
node manual-trading-server-v2.js