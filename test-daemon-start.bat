@echo off
set "NODE_EXE=C:\Users\JoeyF\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "DAEMON_DIR=D:\WILLLUXE\yix-repo\feedaccount\src\chrome-cdp-daemon"
echo NODE_EXE=%NODE_EXE%
echo DAEMON_DIR=%DAEMON_DIR%
echo Testing node...
"%NODE_EXE%" --version
echo Testing start...
start "Chrome CDP Daemon" /d "%DAEMON_DIR%" "%NODE_EXE%" server.mjs
echo Done. Check if daemon started.
timeout /t 3 /nobreak >nul
