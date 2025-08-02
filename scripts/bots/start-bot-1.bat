@echo off
REM TSX Trading Bot V5 - Start BOT_1

echo Starting BOT_1 (Port 3004)...
cd /d "%~dp0..\..\src\core\trading"

REM Start BOT_1 with required parameters
start "TSX-V5-BOT_1" node bot-launcher.js --botId BOT_1 --account SIM643952 --config ../../../config/bots/BOT_1.yaml