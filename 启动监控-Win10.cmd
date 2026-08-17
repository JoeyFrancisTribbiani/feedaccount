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
echo [ERROR] Node.js not found.
echo If Node.js is installed, check PATH, or disable node alias in Settings > Apps > App execution aliases.
echo Please install the current Node.js LTS version: https://nodejs.org/
goto launch_failed

:node_too_old
echo [ERROR] Node.js version too old, requires 22.5 or higher.
echo Current path: !NODE_EXE!
echo Please upgrade to the current Node.js LTS version: https://nodejs.org/
goto launch_failed

:node_ready

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [INFO] FFmpeg not found.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo [HINT] winget not available, cannot auto-install FFmpeg.
    echo Please install manually: https://ffmpeg.org/download.html
    echo Continuing without FFmpeg...
  ) else (
    echo Installing FFmpeg via winget...
    winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements -h >nul 2>nul
    if errorlevel 1 (
      echo [WARN] FFmpeg auto-install failed. Please install manually: https://ffmpeg.org/download.html
      echo Continuing without FFmpeg...
    ) else (
      echo [OK] FFmpeg installed, refreshing PATH...
      set "FRESH_PATH="
      for /f "usebackq tokens=2,*" %%A in (`reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`) do set "FRESH_PATH=%%B"
      for /f "usebackq tokens=2,*" %%A in (`reg query "HKCU\Environment" /v Path 2^>nul`) do set "FRESH_PATH=!FRESH_PATH!;%%B"
      if defined FRESH_PATH set "PATH=!FRESH_PATH!"
    )
  )
) else (
  where ffprobe >nul 2>nul
  if errorlevel 1 (
    echo [HINT] FFprobe not in PATH, video dedup will use fallback mode.
  )
)

"!NODE_EXE!" --no-warnings src\server.js --open
set "APP_EXIT=!ERRORLEVEL!"
if "!APP_EXIT!"=="0" goto finished

echo.
echo [ERROR] Application exited unexpectedly. Check error messages above.

:launch_failed
echo.
pause
endlocal
exit /b 1

:finished
endlocal
