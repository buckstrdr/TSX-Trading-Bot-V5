@echo off
echo ========================================
echo Starting Trading Aggregator in PRODUCTION MODE
echo ========================================
echo.
echo This will:
echo - Intercept orders from Manual Trading
echo - Apply risk validation rules
echo - Forward approved orders to Connection Manager
echo - Calculate and place SL/TP orders automatically
echo - Show real orders in TopStep for validation
echo.
echo Press Ctrl+C to stop
echo.

REM Run from current directory using local node_modules
node src\core\aggregator\start-aggregator-production.js
pause