@echo off
REM TSX Trading Bot V5 - Launch Trading Chart
REM This will launch the real-time trading chart interface

echo ========================================
echo TSX TRADING BOT V5 - TRADING CHART
echo ========================================
echo.

REM Change to trading-chart directory
cd /d "%~dp0trading-chart"

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies for trading chart...
    npm install
    echo.
)

REM Start the trading chart
echo Starting Trading Chart on http://localhost:4675
echo.
echo The chart will connect to:
echo - Redis for real-time market data
echo - Aggregator for trade executions
echo.
echo Press Ctrl+C to stop the trading chart
echo.

REM Run the trading chart
npm run dev

pause