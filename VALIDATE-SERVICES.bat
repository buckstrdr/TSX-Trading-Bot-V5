@echo off
REM TSX Trading Bot V4 - Service Health Validation
REM DevOps Lead: Independent service health checks

echo.
echo ================================================================
echo TSX Trading Bot V4 - Service Health Validation
echo ================================================================
echo DevOps Lead: Validating all manual trading services
echo.

REM Function to check service health
:check_service
echo 🔍 Checking %1 on port %2...
powershell -Command "try { $response = Invoke-WebRequest -Uri 'http://localhost:%2' -TimeoutSec 3 -UseBasicParsing; Write-Host '✅ %1 is healthy and responding' } catch { Write-Host '❌ %1 is not responding or down' }"
goto :eof

REM Function to check port usage
:check_port_usage
echo 📊 Port %1 status:
netstat -an | find ":%1 " > nul
if %ERRORLEVEL% EQU 0 (
    echo    ✅ Port %1 is in use
) else (
    echo    ❌ Port %1 is not in use
)
goto :eof

echo 🔍 Service Health Checks:
echo.

REM Check all required services
call :check_service "Connection Manager" 3001
call :check_service "Manual Trading UI" 3003  
call :check_service "Fake API Server" 8888

echo.
echo 🔍 Redis Health Check:
redis-cli ping > nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo ✅ Redis is healthy and responding to ping
) else (
    echo ❌ Redis is not responding
)

echo.
echo 📊 Port Usage Summary:
echo.
call :check_port_usage 3001
call :check_port_usage 3003
call :check_port_usage 6379
call :check_port_usage 8888

echo.
echo 🎯 Quick URLs for Manual Testing:
echo • Connection Manager:    http://localhost:3001
echo • Manual Trading UI:     http://localhost:3003
echo • Fake API Health:       http://localhost:8888/health
echo • Fake API Root:         http://localhost:8888
echo.

REM Check if all services are running
echo 🚦 Overall Status:
set /a services_running=0

netstat -an | find ":3001 " > nul && set /a services_running+=1
netstat -an | find ":3003 " > nul && set /a services_running+=1
netstat -an | find ":6379 " > nul && set /a services_running+=1
netstat -an | find ":8888 " > nul && set /a services_running+=1

if %services_running% EQU 4 (
    echo ✅ All 4 services are running - Ready for Playwright tests!
) else (
    echo ⚠️  Only %services_running%/4 services are running
    echo 📋 To start services: START-MANUAL-TRADING-SERVICES.bat
)

echo.
pause