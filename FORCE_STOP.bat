@echo off
echo ========================================
echo  FORCE STOPPING ALL TSX SERVICES
echo ========================================
echo.

echo Killing Connection Manager...
taskkill /F /FI "WINDOWTITLE eq TSX-Connection-Manager*" 2>nul
taskkill /F /IM node.exe /FI "WINDOWTITLE eq TSX-Connection-Manager*" 2>nul

echo Killing Trading Aggregator...
taskkill /F /FI "WINDOWTITLE eq TSX-V4-Trading-Aggregator*" 2>nul
taskkill /F /IM node.exe /FI "WINDOWTITLE eq TSX-V4-Trading-Aggregator*" 2>nul

echo Killing Manual Trading...
taskkill /F /FI "WINDOWTITLE eq TSX-Manual-Trading*" 2>nul
taskkill /F /IM node.exe /FI "WINDOWTITLE eq TSX-Manual-Trading*" 2>nul

echo Killing all Node.js processes (last resort)...
taskkill /F /IM node.exe 2>nul

echo.
echo All services stopped!
pause