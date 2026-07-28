@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%BUNDLED_NODE%" goto try_path_node
set "NODE_EXE=%BUNDLED_NODE%"
goto node_ready

:try_path_node
where node >nul 2>nul
if errorlevel 1 goto node_missing
node --no-warnings -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 goto node_too_old
set "NODE_EXE=node"
goto node_ready

:node_missing
echo [无法启动] 未找到可用的 Node.js。
echo 请安装当前 Node.js LTS 版本后重试：https://nodejs.org/
goto launch_failed

:node_too_old
echo [无法启动] 当前 Node.js 版本过低，需要 22.5 或更高版本。
echo 请升级到当前 Node.js LTS 版本后重试：https://nodejs.org/
goto launch_failed

:node_ready
"%NODE_EXE%" --no-warnings src\server.js --open
set "APP_EXIT=%ERRORLEVEL%"
if "%APP_EXIT%"=="0" goto finished

echo.
echo [程序异常退出] 请查看上方的错误提示。

:launch_failed
echo.
pause
endlocal
exit /b 1

:finished
endlocal
