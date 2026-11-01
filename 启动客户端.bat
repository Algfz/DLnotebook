@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  DLnotebook launcher (Windows)
rem  ASCII only on purpose: cmd parses batch files byte-wise, so
rem  non-ASCII text breaks on machines with a different code page.
rem  Line endings MUST be CRLF (enforced by .gitattributes).
rem
rem  Order of preference:
rem    1. node    - full dev server, request log, auto-open
rem    2. python  - plain static server, no log
rem    3. PowerShell - built in on every Windows box, zero install
rem ============================================================

set "RUNTIME="
where node >nul 2>nul
if not errorlevel 1 set "RUNTIME=node"
if defined RUNTIME goto run_node

rem node may be installed but missing from PATH in this shell
if exist "%ProgramFiles%\nodejs\node.exe" set "RUNTIME=%ProgramFiles%\nodejs\node.exe"
if defined RUNTIME goto run_node
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "RUNTIME=%ProgramFiles(x86)%\nodejs\node.exe"
if defined RUNTIME goto run_node
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "RUNTIME=%LocalAppData%\Programs\nodejs\node.exe"
if defined RUNTIME goto run_node

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py"
if defined PY goto run_py
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto run_py

goto run_ps

rem ------------------------------------------------------------
:run_node
echo.
echo   DLnotebook
echo   address: http://localhost:8080
echo.
echo   runtime: %RUNTIME%
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
"%RUNTIME%" tools\dev-server.js --open
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:run_py
echo.
echo   DLnotebook
echo   address: http://localhost:8080
echo.
echo   Node.js not found - falling back to a Python static server.
echo   (same game, only without the request log)
echo.
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
start "" http://localhost:8080
%PY% -m http.server 8080
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:run_ps
echo.
echo   DLnotebook
echo   address: http://localhost:8080
echo.
echo   Neither Node.js nor Python was found on this computer.
echo   Using the PowerShell server that ships with Windows, so
echo   nothing has to be installed. The browser opens by itself
echo   a few seconds after the server is up.
echo.
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
rem the PowerShell that ships with Windows; call it by full path because
rem a broken PATH is exactly the situation this branch exists for
set "PS="
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined PS set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "tools\serve.ps1" -Port 8080
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:no_runtime
echo.
echo   ==========================================================
echo    Could not start any local server on this computer.
echo.
echo    This is unusual - Windows always has PowerShell. Things to try:
echo      1. right click this file and choose "Run as administrator"
echo      2. install Node.js from https://nodejs.org and run this again
echo      3. open src/index.html directly in Chrome or Edge
echo   ==========================================================
echo.
pause
exit /b 1
