@echo off
REM Double-click this file on Windows to start Tesla Cast.
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js is not installed on this machine.
  echo Install it from https://nodejs.org ^(LTS version^) and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dependencies not found - installing ^(only needs to happen once^)...
  call npm install
)

echo.
echo Starting Tesla Cast...
echo.
node server\index.js
pause
