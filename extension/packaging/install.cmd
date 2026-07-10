@echo off
REM Jira Agent (Option 1) installer - double-click friendly wrapper around install.ps1.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
