@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
echo ========================================
echo  FeedAccount Code Update
echo ========================================
echo.

git pull origin main

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo  Update successful!
    echo ========================================
) else (
    echo.
    echo ========================================
    echo  Update failed! Check error above.
    echo ========================================
)

echo.
pause
