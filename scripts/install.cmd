@echo off
REM VOID//ai-launcher — Windows cmd.exe installer
REM Usage: scripts\install.cmd
REM Delegates to install.ps1 (Node-version/winget logic lives in one place).

setlocal
set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %EXIT_CODE%
