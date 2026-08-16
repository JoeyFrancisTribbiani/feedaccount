@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~1"
set "DAEMON_DIR=%~dp0src\chrome-cdp-daemon"
"%NODE_EXE%" "%DAEMON_DIR%\server.mjs"
