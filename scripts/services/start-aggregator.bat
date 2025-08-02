@echo off
REM TSX Trading Bot V5 - Start Trading Aggregator

echo Starting Trading Aggregator...
echo.

REM Navigate to root directory to use root node_modules
cd /d "%~dp0\..\..\"

REM Check if root node_modules exists
if not exist node_modules (
    echo Installing dependencies in root directory...
    call npm install
    echo.
)

echo Starting Trading Aggregator on port 7600...
echo.

REM Start the aggregator in production mode from root directory in a new window
start "TSX-V5-Trading-Aggregator" cmd /k node src\core\aggregator\start-aggregator-production.js