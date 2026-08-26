@echo off
title Start Unified Host and Ruaji Bridge v2

set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

echo [1/2] Starting Unified AstrBot Host (:8870)...
if exist "%ROOT_DIR%astr\unified_astrbot_host\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%ROOT_DIR%astr\unified_astrbot_host\.venv\Scripts\python.exe"
) else (
    set "PYTHON_EXE=python"
)

start "Unified AstrBot Host" cmd /k "cd /d "%ROOT_DIR%astr\unified_astrbot_host" && "%PYTHON_EXE%" host_server.py"

timeout /t 3 >nul

echo [2/2] Starting Ruaji Bridge v2 (:29998)...
start "Ruaji Bridge v2" cmd /k "cd /d "%ROOT_DIR%" && node src\index.js --no-preflight"

echo.
echo ====================================================
echo   Services started in new windows:
echo   - Unified AstrBot Host API:  http://127.0.0.1:8870
echo   - LivingMemory Dashboard:    http://127.0.0.1:8878/dashboard/
echo   - GroupChatPlus Dashboard:   http://127.0.0.1:1451/
echo   - Ruaji Bridge Panel:        http://127.0.0.1:29998
echo ====================================================
echo.
pause
