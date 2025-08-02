@echo off
REM TSX Trading Bot V4 - Stop Manual Trading

echo Stopping Manual Trading Server...
taskkill /F /FI "WINDOWTITLE eq TSX-V4-Manual-Trading*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3003 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Manual Trading stopped.