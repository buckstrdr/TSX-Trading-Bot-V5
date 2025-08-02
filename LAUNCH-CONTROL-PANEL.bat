@echo off
REM ========================================
REM TSX Trading Bot V5 - Control Panel Launcher
REM ========================================

cls
echo.
echo  _____ ______  __  _____            _ _             ____       _   
echo ^|_   _^|/ __\ \/ / ^|_   _^|_ _ __ _ ___^| (_)_ __   __ _  ^| __ )  ___ ^| ^|_ 
echo   ^| ^|  \__ \\  /    ^| ^|^| '_/ _` / _` ^| ^| '_ \ / _` ^| ^|  _ \ / _ \^| __^|
echo   ^| ^|  ^|___//  \    ^| ^|^| ^| ^| (_^| ^| (_^| ^| ^| ^| ^| ^| (_^| ^| ^| ^|_) ^| (_) ^| ^|_ 
echo   ^|_^|  ^|____/_/\_\   ^|_^|^|_^|  \__,_^\__,_^|_^|_^| ^|_^\__, ^| ^|____/ \___/ \__^|
echo                                                ^|___/                    
echo.
echo                            VERSION 5.0
echo                        CONTROL PANEL LAUNCHER
echo.
echo ========================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check if Redis is available
"C:\Program Files\Redis\redis-cli" --version >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Redis CLI not found at default location
    echo Redis may need to be started manually
    echo.
)

echo Starting TSX Trading Bot V5 Control Panel...
echo.
echo The Control Panel will open in your default browser at:
echo http://localhost:8080
echo.
echo From the Control Panel you can:
echo   - Start/Stop all services with one click
echo   - Manage individual trading bots (BOT_1 to BOT_6)
echo   - Access Configuration UI
echo   - Monitor service health
echo   - View real-time logs
echo.

REM Kill any existing process on port 8080
echo Checking for existing processes on port 8080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    echo Found process %%a using port 8080, terminating...
    taskkill /F /PID %%a >nul 2>&1
    echo Process terminated.
)

REM Wait a moment for port to be released
timeout /t 2 /nobreak >nul


REM Start the main control panel
start "TSX-V5-Control-Panel" /D "%~dp0" scripts\control\start-control-panel.bat

REM Wait a moment for server to start
timeout /t 3 /nobreak >nul

REM Open in default browser
start http://localhost:8080

echo.
echo Control Panel launching...
echo This window will close in 5 seconds.
echo.
timeout /t 5 /nobreak >nul