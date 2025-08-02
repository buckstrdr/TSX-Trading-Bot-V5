@echo off
echo ========================================
echo  Killing process on port 7500
echo ========================================
echo.

REM Find and kill process using port 7500
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7500') do (
    echo Killing process with PID: %%a
    taskkill /F /PID %%a 2>nul
)

echo.
echo Port 7500 should now be free!
pause