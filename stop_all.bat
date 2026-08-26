@echo off
title Stop Unified Host and Ruaji Bridge

echo Stopping all processes on ports 8870, 29990, 8878, 1451, 29998...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8870 :29990 :8878 :1451 :29998" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo All services stopped and ports released.
timeout /t 2 >nul
