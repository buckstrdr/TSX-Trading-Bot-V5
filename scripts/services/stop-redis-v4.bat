@echo off
REM TSX Trading Bot V4 - Stop Redis

echo Stopping Redis Server...
"C:\Program Files\Redis\redis-cli" shutdown >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq TSX-V4-Redis*" >nul 2>&1
echo Redis stopped.