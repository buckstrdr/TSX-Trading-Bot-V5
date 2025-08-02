@echo off
REM TSX Trading Bot V5 - Stop Configuration UI

echo Stopping Configuration UI...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Config-UI*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Configuration UI stopped.