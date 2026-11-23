@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    python -m venv .venv
    if errorlevel 1 goto failed
)

".venv\Scripts\python.exe" -c "import yt_dlp" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
)

".venv\Scripts\python.exe" server.py --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Setup or startup failed. Check the message above and make sure Python 3.11+ is installed.
pause
exit /b 1
