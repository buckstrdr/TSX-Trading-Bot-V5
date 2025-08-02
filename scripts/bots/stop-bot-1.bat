@echo off
REM TSX Trading Bot V5 - Stop BOT_1

echo Stopping BOT_1...

REM Kill the bot process by window title
taskkill /FI "WINDOWTITLE eq TSX-V5-BOT_1" /F 2>nul

if %ERRORLEVEL%==0 (
    echo BOT_1 stopped successfully.
) else (
    echo BOT_1 was not running or already stopped.
)