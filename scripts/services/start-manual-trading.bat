@echo off
REM TSX Trading Bot V5 - Start Manual Trading Server

echo Starting Manual Trading Server...

REM Start in a new window
start "TSX-V5-Manual-Trading" "%~dp0run-manual-trading.bat"

echo Manual Trading server started in a new window.
timeout /t 2 /nobreak >nul