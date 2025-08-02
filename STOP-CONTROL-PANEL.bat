@echo off
REM ========================================
REM TSX Trading Bot V5 - Stop Control Panel & Config Server
REM ========================================

cls
echo.
echo ========================================
echo   STOPPING TSX TRADING BOT V5 SERVICES
echo ========================================
echo.

REM Kill Control Panel (port 8080)
echo Stopping Control Panel on port 8080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    echo Found process %%a, terminating...
    taskkill /F /PID %%a >nul 2>&1
    echo Control Panel stopped.
)


echo.
echo All services have been stopped.
echo.
pause