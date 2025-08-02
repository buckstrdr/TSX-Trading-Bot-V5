@echo off
REM TSX Trading Bot V5 - Stop All Services

echo ========================================
echo  TSX Trading Bot V5 System Shutdown
echo ========================================
echo.

REM Stop Trading Bots first (if running)
echo [1/6] Stopping Trading Bots...
for /l %%i in (1,1,6) do (
    taskkill /F /FI "WINDOWTITLE eq TSX-V5-BOT_%%i*" >nul 2>&1
)

REM Stop Manual Trading
echo [2/6] Stopping Manual Trading Server...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Manual-Trading*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3003 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

REM Stop Configuration UI
echo [3/6] Stopping Configuration UI...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Config-UI*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

REM Stop Trading Aggregator
echo [4/6] Stopping Trading Aggregator...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Trading-Aggregator*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7600 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

REM Stop Connection Manager
echo [5/6] Stopping Connection Manager...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Connection-Manager*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq TSX-Connection-Manager*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7500 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

REM Stop Redis (optional - uncomment if you want to stop Redis)
REM echo [5/5] Stopping Redis...
REM taskkill /F /FI "WINDOWTITLE eq TSX-V5-Redis*" >nul 2>&1
REM "C:\Program Files\Redis\redis-cli" shutdown >nul 2>&1

echo.
echo All V5 services stopped.
echo.
pause