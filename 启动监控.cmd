@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

REM ===== 先杀掉旧进程（监控服务 + CDP守护进程）=====
echo [清理] 正在停止旧进程...
taskkill /fi "WINDOWTITLE eq Chrome CDP Daemon*" /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq FeedAccount Monitor*" /f >nul 2>nul
REM 按命令行匹配杀掉 server.mjs 和 server.js 进程
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq node.exe" /fo list 2^>nul ^| findstr /i "PID"') do (
  for /f "tokens=*" %%c in ('wmic process where "processid=%%p" get commandline /value 2^>nul ^| findstr /i "server.mjs"') do (
    taskkill /pid %%p /f >nul 2>nul
  )
  for /f "tokens=*" %%c in ('wmic process where "processid=%%p" get commandline /value 2^>nul ^| findstr /i "src\\server.js"') do (
    taskkill /pid %%p /f >nul 2>nul
  )
)
timeout /t 1 /nobreak >nul

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

REM ===== 启动 Chrome CDP Daemon（后台）=====
set "DAEMON_DIR=%~dp0src\chrome-cdp-daemon"
if exist "%DAEMON_DIR%\server.mjs" (
  if not exist "%DAEMON_DIR%\node_modules" (
    echo [CDP Daemon] 首次运行，正在安装依赖...
    pushd "%DAEMON_DIR%"
    call npm install
    popd
  )
  echo [CDP Daemon] 正在后台启动...
  start "Chrome CDP Daemon" /min "%NODE_EXE%" "%DAEMON_DIR%\server.mjs"
  timeout /t 2 /nobreak >nul
) else (
  echo [CDP Daemon] 未找到 src\chrome-cdp-daemon\server.mjs，跳过
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [检测到未安装 FFmpeg] 正在通过 winget 自动安装...
  winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements -h
  if errorlevel 1 (
    echo [警告] FFmpeg 自动安装失败，请手动安装：https://ffmpeg.org/download.html
    echo 将尝试继续启动...
  ) else (
    echo [成功] FFmpeg 已安装，正在刷新环境变量...
    for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "SYS_PATH=%%B"
    for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "USR_PATH=%%B"
    set "PATH=%SYS_PATH%;%USR_PATH%"
  )
) else (
  where ffprobe >nul 2>nul
  if errorlevel 1 (
    echo [提示] FFprobe 未在 PATH 中，视频去重将使用降级模式
  )
)

start "FeedAccount Monitor" /wait "%NODE_EXE%" --no-warnings src\server.js --open
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
REM 监控服务退出时也杀掉 CDP Daemon
taskkill /fi "WINDOWTITLE eq Chrome CDP Daemon*" /f >nul 2>nul
endlocal
