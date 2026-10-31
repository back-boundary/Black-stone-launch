@echo off
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not defined NODE for %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions") do if exist "%%~D" for /d %%V in ("%%~D\*") do if exist "%%~V\node.exe" if not defined NODE set "NODE=%%~V\node.exe"

if not defined NODE (
  echo.
  echo   [!] Node.js not found.
  echo       Install Node.js 18+ from https://nodejs.org then run start.bat again.
  echo.
  pause
  exit /b 1
)

echo   Yaoshi Launcher  ^|  Minecraft 1.20.1
echo   node: %NODE%
echo.
"%NODE%" "src\server.js"
if errorlevel 1 pause
