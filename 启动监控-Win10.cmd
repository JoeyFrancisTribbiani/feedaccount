@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul
cd /d "%~dp0"

set "NODE_EXE="
set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if exist "%BUNDLED_NODE%" (
  set "NODE_EXE=%BUNDLED_NODE%"
  goto node_ready
)

REM Find real node.exe, skip WindowsApps App Execution Alias stub
for /f "delims=" %%p in ('where node 2^>nul') do (
  echo %%p | findstr /i "WindowsApps" >nul 2>nul
  if errorlevel 1 (
    if not defined NODE_EXE set "NODE_EXE=%%p"
  )
)
if not defined NODE_EXE goto node_missing

REM Check node:sqlite (< nul prevents REPL hang on stub)
"%NODE_EXE%" --no-warnings -e "require('node:sqlite')" < nul >nul 2>nul
if errorlevel 1 goto node_too_old
goto node_ready

:node_missing
echo [无法启动] 未找到可用的 Node.js。
echo 如果已安装 Node.js，请检查 PATH，或在「设置 > 应用 > 应用执行别名」中关闭 node 别名。
echo 请安装当前 Node.js LTS 版本后重试：https://nodejs.org/
goto launch_failed

:node_too_old
echo [无法启动] 当前 Node.js 版本过低，需要 22.5 或更高版本。
echo 当前路径：!NODE_EXE!
echo 请升级到当前 Node.js LTS 版本后重试：https://nodejs.org/
goto launch_failed

:node_ready

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [检测到未安装 FFmpeg]
  where winget >nul 2>nul
  if errorlevel 1 (
    echo [提示] 系统未安装 winget，无法自动安装 FFmpeg
    echo 请手动安装：https://ffmpeg.org/download.html
    echo 将尝试继续启动...
  ) else (
    echo 正在通过 winget 自动安装 FFmpeg...
    winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements -h >nul 2>nul
    if errorlevel 1 (
      echo [警告] FFmpeg 自动安装失败，请手动安装：https://ffmpeg.org/download.html
      echo 将尝试继续启动...
    ) else (
      echo [成功] FFmpeg 已安装，正在刷新环境变量...
      set "FRESH_PATH="
      for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "FRESH_PATH=%%B"
      for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "FRESH_PATH=!FRESH_PATH!;%%B"
      if defined FRESH_PATH set "PATH=!FRESH_PATH!"
    )
  )
) else (
  where ffprobe >nul 2>nul
  if errorlevel 1 (
    echo [提示] FFprobe 未在 PATH 中，视频去重将使用降级模式
  )
)

"!NODE_EXE!" --no-warnings src\server.js --open
set "APP_EXIT=!ERRORLEVEL!"
if "!APP_EXIT!"=="0" goto finished

echo.
echo [程序异常退出] 请查看上方的错误提示。

:launch_failed
echo.
pause
endlocal
exit /b 1

:finished
endlocal
