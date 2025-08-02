@echo off
setlocal enabledelayedexpansion

REM TSX Trading Bot V5 - Master Startup Script
REM Starts all V5 services in sequence

cls
echo ========================================
echo  TSX Trading Bot V5 System Startup
echo ========================================
echo.

REM Start Redis if not running
"C:\Program Files\Redis\redis-cli" ping > nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] Starting Redis...
    start "TSX-V5-Redis" "C:\Program Files\Redis\redis-server.exe"
    
    REM Wait for Redis
    set REDIS_READY=0
    for /l %%i in (1,1,30) do (
        if !REDIS_READY! equ 0 (
            timeout /t 1 /nobreak > nul
            "C:\Program Files\Redis\redis-cli" ping > nul 2>&1
            if !errorlevel! equ 0 (
                set REDIS_READY=1
                echo       Redis ready
            ) else (
                <nul set /p "=."
            )
        )
    )
    
    if !REDIS_READY! equ 0 (
        echo.
        echo       Warning: Redis startup timeout
    )
) else (
    echo [1/4] Redis already running
)

REM Fake API Server is not implemented in V5 yet
echo [2/5] Skipping Fake API Server (not implemented)...

REM Start Connection Manager
echo [3/5] Starting Connection Manager...
start "TSX-V5-Connection-Manager" "%~dp0..\services\run-connection-manager.bat"

REM Wait for Connection Manager
set CONNECTION_READY=0
for /l %%i in (1,1,45) do (
    if !CONNECTION_READY! equ 0 (
        timeout /t 1 /nobreak > nul
        curl -s http://localhost:7500/health > nul 2>&1
        if !errorlevel! equ 0 (
            set CONNECTION_READY=1
            echo       Connection Manager ready
        ) else (
            <nul set /p "=."
        )
    )
)

if !CONNECTION_READY! equ 0 (
    echo.
    echo       Warning: Connection Manager startup timeout
)

REM Start Trading Aggregator
echo [4/6] Starting Trading Aggregator...
start "TSX-V5-Trading-Aggregator" "%~dp0..\services\start-aggregator.bat"

REM Wait for Aggregator
set AGGREGATOR_READY=0
for /l %%i in (1,1,30) do (
    if !AGGREGATOR_READY! equ 0 (
        timeout /t 1 /nobreak > nul
        curl -s http://localhost:7600/health > nul 2>&1
        if !errorlevel! equ 0 (
            set AGGREGATOR_READY=1
            echo       Trading Aggregator ready
        ) else (
            <nul set /p "=."
        )
    )
)

if !AGGREGATOR_READY! equ 0 (
    echo.
    echo       Warning: Trading Aggregator startup timeout
)

REM Start Configuration UI
echo [5/6] Starting Configuration UI...
start "TSX-V5-Config-UI" "%~dp0..\services\start-config-ui.bat"

REM Start Manual Trading V2
echo [6/6] Starting Manual Trading Server...
start "TSX-V5-Manual-Trading" "%~dp0..\services\start-manual-trading.bat"

echo.
echo ========================================
echo  V5 Core Services Started!
echo ========================================
echo.
echo Services:
echo   Control Panel:      http://localhost:8080
echo   Configuration UI:   http://localhost:3000
echo   Connection Manager: http://localhost:7500
echo   Trading Aggregator: http://localhost:7600  
echo   Manual Trading:     http://localhost:3003
echo.
echo Trading Bots can be started individually from the Control Panel
echo.
echo This window will close in 5 seconds...
timeout /t 5 /nobreak >nul
exit