@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo ========================================
echo  FeedAccount Setup
echo ========================================
echo.

:: ===== 1. Check Node.js =====
echo [1/4] Checking Node.js...
node --version >nul 2>nul
if %errorlevel% neq 0 (
  echo  Node.js not found. Installing via winget...
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if !errorlevel! neq 0 (
    echo  ERROR: Failed to install Node.js.
    echo  Please install Node.js 22+ manually from https://nodejs.org
    pause
    exit /b 1
  )
  echo  Node.js installed. Refreshing PATH...
  call :refresh_path
) else (
  for /f "tokens=*" %%v in ('node --version') do echo  Node.js: %%v
)

:: ===== 2. Check FFmpeg =====
echo.
echo [2/4] Checking FFmpeg...
ffmpeg -version >nul 2>nul
if %errorlevel% neq 0 (
  echo  FFmpeg not found. Installing via winget...
  winget install Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
  if !errorlevel! neq 0 (
    echo  WARNING: Failed to install FFmpeg via winget.
    echo  Please install FFmpeg manually from https://ffmpeg.org
    echo  and add it to your PATH.
  ) else (
    echo  FFmpeg installed. Refreshing PATH...
    call :refresh_path
  )
) else (
  echo  FFmpeg: OK
)

:: ===== 3. Check npm dependencies =====
echo.
echo [3/4] Checking dependencies...
if not exist "node_modules" (
  echo  Installing main dependencies...
  call npm install
  if !errorlevel! neq 0 (
    echo  ERROR: npm install failed.
    pause
    exit /b 1
  )
  echo  Main dependencies installed.
) else (
  echo  Main dependencies: OK
)
echo  Installing daemon dependencies...
cd "src\chrome-cdp-daemon"
if not exist "node_modules" (
  call npm install
  if !errorlevel! neq 0 (
    echo  ERROR: daemon npm install failed.
    pause
    exit /b 1
  )
  echo  Daemon dependencies installed.
) else (
  echo  Daemon dependencies: OK
)
cd /d "%~dp0"

:: ===== 4. Initialize database =====
echo.
echo [4/4] Initializing database...
if not exist "data" (
  mkdir data
)
echo  Database will be created on first launch.
echo.
echo ========================================
echo  Setup complete!
echo ========================================
echo.
echo  Next steps:
echo  1. Run "启动监控-Win10.cmd" to start the service
echo  2. Open http://127.0.0.1:39210 in your browser
echo  3. Go to Chrome CDP tab to launch Chrome and start daemon
echo.
pause
exit /b 0

:refresh_path
:: Refresh PATH for current session after installing packages
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files (x86)\nodejs"
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USR_PATH=%%b"
if defined SYS_PATH set "PATH=%SYS_PATH%;%PATH%"
if defined USR_PATH set "PATH=%USR_PATH%;%PATH%"
goto :eof
