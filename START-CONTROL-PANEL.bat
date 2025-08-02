@echo off
echo ========================================
echo TSX Trading Bot - API Mode Control Panel
echo ========================================
echo.
echo Starting control panel server...
echo.
echo WARNING: This controls REAL vs FAKE API mode!
echo         Use with extreme caution!
echo.
echo Control Panel will be available at:
echo http://localhost:8080
echo.
echo Press Ctrl+C to stop
echo.

REM Start the control panel server
node src\infrastructure\api-mode\control-panel-server.js

pause