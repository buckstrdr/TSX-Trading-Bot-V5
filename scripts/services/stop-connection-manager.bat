@echo off
REM TSX Trading Bot V5 - Stop Connection Manager

echo Stopping Connection Manager...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Connection-Manager*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq TSX-Connection-Manager*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7500 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Connection Manager stopped.