@echo off
REM TSX Trading Bot V5 - Start Manual Trading Server

echo Starting Manual Trading Server...
cd /d "%~dp0..\.."

REM Start the manual trading server
echo Starting Manual Trading on http://localhost:3003
node manual-trading\server.js