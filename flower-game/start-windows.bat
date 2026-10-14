@echo off
title Petal Arena server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed yet.
  echo  Opening nodejs.org - download the LTS version, install it, then double-click this file again.
  echo.
  start https://nodejs.org
  pause
  exit /b
)

if not exist node_modules (
  echo Installing game files for the first time...
  call npm install
)

echo Starting the game... (close this window to stop the server)
start "" http://localhost:3000
call npm start
pause
