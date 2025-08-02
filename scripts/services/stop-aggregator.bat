@echo off
REM Stop Trading Aggregator
echo Stopping Trading Aggregator...
taskkill /F /FI "WINDOWTITLE eq TSX-V5-Trading-Aggregator*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7600 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Trading Aggregator stopped.